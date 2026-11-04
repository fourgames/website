"""Pseudonyms and signed tokens.

- pid: HMAC-SHA256(pepper, "steam:" + steamid64), hex, first 32 characters. The same steamid always
  gives the same pid, and without the pepper a pid can't be turned back into a steamid.
- Signed tokens (the games' session tokens, the privacy page's cookie, the Steam sign-in's state):
  base64url(JSON) + "." + base64url(HMAC-SHA256(secret, purpose + "\\n" + body)). The purpose is in
  the signature, so a token made for one use can't be passed off as another.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from typing import Any

# SteamID64 of an individual account: 76561197960265728 + account id (32 bits). 0 isn't an account.
STEAMID_MIN = 76561197960265729
STEAMID_MAX = 76561197960265728 + 0xFFFFFFFF
STEAMID = re.compile(r"^\d{17}$")

PID = re.compile(r"^[0-9a-f]{32}$")


class TokenError(Exception):
    """The token is unusable. str(error) is "invalid" or "expired"."""


def valid_steamid(value: object) -> str | None:
    """The steamid as a string if it's an individual account's SteamID64, else None."""
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str) or not STEAMID.match(value):
        return None
    return value if STEAMID_MIN <= int(value) <= STEAMID_MAX else None


def make_pid(pepper: str, steamid: str) -> str:
    return hmac.new(pepper.encode(), f"steam:{steamid}".encode(), hashlib.sha256).hexdigest()[:32]


def random_pid() -> str:
    """A new pid for anonymised data: the same shape as a real one, and linked to nothing."""
    return secrets.token_hex(16)


def short(pid: str) -> str:
    """What the logs show of a pid."""
    return pid[:8]


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _signature(secret: str, purpose: str, body: str) -> str:
    return _b64(hmac.new(secret.encode(), f"{purpose}\n{body}".encode(), hashlib.sha256).digest())


def sign(secret: str, purpose: str, payload: dict[str, Any], ttl: int, now: float | None = None) -> str:
    """A token holding `payload` plus its expiry ("e", unix seconds)."""
    now = time.time() if now is None else now
    body = _b64(json.dumps({**payload, "e": int(now) + ttl}, separators=(",", ":")).encode())
    return f"{body}.{_signature(secret, purpose, body)}"


def verify(secret: str, purpose: str, token: object, now: float | None = None) -> dict[str, Any]:
    """The payload, or TokenError("invalid" / "expired")."""
    now = time.time() if now is None else now
    if not isinstance(token, str) or len(token) > 4096:
        raise TokenError("invalid")
    try:
        body, signature = token.split(".")
    except ValueError:
        raise TokenError("invalid") from None
    # Constant-time compare, so the signature can't be found out byte by byte.
    if not hmac.compare_digest(signature.encode(), _signature(secret, purpose, body).encode()):
        raise TokenError("invalid")
    try:
        data = json.loads(_unb64(body))
        expires = int(data["e"])
    except (ValueError, KeyError, TypeError):
        raise TokenError("invalid") from None
    if not isinstance(data, dict):
        raise TokenError("invalid")
    if now >= expires:
        raise TokenError("expired")
    return data

