"""HTTP GETs that return JSON, with the errors sorted into what the collector does about them.

Nothing here sleeps or retries: the collector's rate limiters decide when to try again. Errors and
logs name the host and path only, never the query string, so the Web API key can't end up in a log.
"""

from __future__ import annotations

import gzip
import http.client
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from typing import Any, Callable

log = logging.getLogger("steamdata.net")

# Bigger replies than this are refused (the largest normal one, an app-list page, is ~1 MB).
MAX_BYTES = 32 * 1024 * 1024


class HttpError(Exception):
    """A reply that won't get better by asking again soon (404, 400, ...)."""

    def __init__(self, status: int | str, where: str):
        super().__init__(f"HTTP {status} from {where}")
        self.status = status
        self.where = where


class Throttled(HttpError):
    """The site says we're asking too often (429, or the store's 403): back off this host."""

    def __init__(self, status: int | str, where: str, retry_after: float | None = None):
        super().__init__(status, where)
        self.retry_after = retry_after


class Transient(HttpError):
    """5xx, timeouts, broken connections, a reply that isn't JSON: try again a bit later."""


# transport(url, headers, timeout) -> (status, headers, body). The tests pass a fake one.
Transport = Callable[[str, dict, float], tuple[int, dict, bytes]]


def urllib_transport(url: str, headers: dict, timeout: float) -> tuple[int, dict, bytes]:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as res:
            return res.status, {k.lower(): v for k, v in res.headers.items()}, res.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        with error:
            body = error.read(64 * 1024) if error.fp else b""
            return error.code, {k.lower(): v for k, v in (error.headers or {}).items()}, body


class Http:
    def __init__(self, user_agent: str, transport: Transport | None = None, timeout: float = 30):
        self.user_agent = user_agent
        self.transport = transport or urllib_transport
        self.timeout = timeout
        # Per host: ok, throttled, failed, bytes. The collector writes them to http_log.
        self.counts: dict[str, Counter] = {}

    def _count(self, host: str, what: str, amount: int = 1) -> None:
        self.counts.setdefault(host, Counter())[what] += amount

    def take_counts(self) -> dict[str, Counter]:
        counts, self.counts = self.counts, {}
        return counts

    def get_json(self, url: str, params: dict | None = None, *,
                 throttle_codes: tuple[int, ...] = (429,)) -> Any:
        parts = urllib.parse.urlsplit(url)
        host, where = parts.netloc, parts.netloc + parts.path.rstrip("/")
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        headers = {"User-Agent": self.user_agent, "Accept": "application/json",
                   "Accept-Encoding": "gzip"}
        try:
            status, res_headers, body = self.transport(url, headers, self.timeout)
        except (urllib.error.URLError, http.client.HTTPException, OSError) as error:
            # OSError covers timeouts and refused or reset connections.
            self._count(host, "failed")
            raise Transient(f"network error ({type(error).__name__})", where) from None
        self._count(host, "bytes", len(body))
        if status in throttle_codes:
            self._count(host, "throttled")
            raise Throttled(status, where, _retry_after(res_headers.get("retry-after")))
        if status >= 500:
            self._count(host, "failed")
            raise Transient(status, where)
        if status != 200:
            # A 404 is a normal answer here ("no player count for that app"), not a failure.
            self._count(host, "ok" if status == 404 else "failed")
            raise HttpError(status, where)
        if len(body) > MAX_BYTES:
            self._count(host, "failed")
            raise Transient("reply too big", where)
        if res_headers.get("content-encoding", "").lower() == "gzip":
            try:
                body = gzip.decompress(body)
            except (OSError, EOFError):
                self._count(host, "failed")
                raise Transient("broken gzip", where) from None
        try:
            data = json.loads(body.decode("utf-8", errors="replace"))
        except ValueError:
            # E.g. a retired endpoint that redirects to an HTML page.
            self._count(host, "failed")
            raise Transient("non-JSON reply", where) from None
        self._count(host, "ok")
        return data


def _retry_after(value: str | None) -> float | None:
    if value and value.strip().isdigit():
        return float(value.strip())
    return None
