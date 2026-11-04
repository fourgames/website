"""Rate limits and size caps: reading a body without ever holding more than its cap, before and
after gzip."""

from __future__ import annotations

import json
import time
import zlib
from collections import defaultdict, deque
from typing import Any

from aiohttp import web


class Refused(Exception):
    """A request we answer with an error: the status, a code for the client, a short message."""

    def __init__(self, status: int, error: str, message: str, headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status = status
        self.error = error
        self.message = message
        self.headers = headers or {}


def too_large(what: str = "the body") -> Refused:
    return Refused(413, "too_large", f"{what} is too large")


class RateLimiter:
    """At most `limit` hits per `window` seconds for each key (a hashed IP or a pid). In memory: a
    restart forgets, which is fine for limits."""

    def __init__(self, limit: int, window: float, clock=time.monotonic):
        self.limit = limit
        self.window = window
        self.clock = clock
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = self.clock()
        hits = self.hits[key]
        while hits and hits[0] <= now - self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(now)
        # Keep the dict from growing with every key ever seen.
        if len(self.hits) > 10_000:
            for k in [k for k, v in self.hits.items() if not v or v[-1] <= now - self.window]:
                del self.hits[k]
        return True

    def retry_after(self, key: str) -> int:
        hits = self.hits.get(key)
        if not hits:
            return 1
        return max(1, int(hits[0] + self.window - self.clock()) + 1)


async def read_capped(request: web.Request, cap: int) -> bytes:
    """The whole body as sent, but never more than `cap` bytes of it in memory."""
    if request.content_length is not None and request.content_length > cap:
        raise too_large()
    body = bytearray()
    async for chunk in request.content.iter_chunked(64 * 1024):
        body += chunk
        if len(body) > cap:
            raise too_large()
    return bytes(body)


def gunzip_capped(data: bytes, cap: int) -> bytes:
    """Decompresses one gzip stream, stopping as soon as the output would pass `cap`: a small body
    that inflates to gigabytes (a gzip bomb) costs no more than `cap` bytes of memory."""
    inflater = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    try:
        out = inflater.decompress(data, cap + 1)
        if len(out) > cap or inflater.unconsumed_tail:
            raise too_large("the body, unpacked,")
        out += inflater.flush(cap + 1 - len(out))
    except zlib.error:
        raise Refused(400, "bad_gzip", "the body isn't valid gzip") from None
    if len(out) > cap:
        raise too_large("the body, unpacked,")
    if not inflater.eof:
        raise Refused(400, "bad_gzip", "the gzip data is cut off")
    return out


async def read_json(request: web.Request, raw_cap: int, unpacked_cap: int,
                    require_json_type: bool = False) -> dict[str, Any]:
    """The body as a JSON object. Takes `Content-Encoding: gzip` (unpacked with its own cap) or a
    plain body. aiohttp's own decompression is off (web.py), so this is the only place it happens."""
    if require_json_type and request.content_type != "application/json":
        raise Refused(415, "unsupported_media_type", "send JSON (Content-Type: application/json)")
    encoding = request.headers.get("Content-Encoding", "").strip().lower()
    raw = await read_capped(request, raw_cap)
    if encoding == "gzip":
        raw = gunzip_capped(raw, unpacked_cap)
    elif encoding not in ("", "identity"):
        raise Refused(415, "unsupported_media_type", "only gzip or no Content-Encoding")
    elif len(raw) > unpacked_cap:
        raise too_large()
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        # ValueError covers bad UTF-8 and bad JSON; RecursionError very deep nesting.
        raise Refused(400, "bad_json", "the body isn't valid JSON") from None
    if not isinstance(data, dict):
        raise Refused(400, "bad_json", "the body must be a JSON object")
    return data
