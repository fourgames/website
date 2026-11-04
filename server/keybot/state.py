"""The signed, expiring `state` in the "Verify your channel" link.

It ties the Discord login on the web back to the /request it came from (who asked, for which game),
and Discord hands it back unchanged on /callback. The signature means nobody can make one up for
someone else; the nonce is also stored in the database so each link works only once.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass

TTL_SECONDS = 15 * 60


class StateError(Exception):
    """The state is unusable. str(error) is "invalid" or "expired". An expired state's contents
    are still in error.state (its signature was good), so the page can say which command to rerun."""

    def __init__(self, reason: str, state: "State | None" = None):
        super().__init__(reason)
        self.state = state


@dataclass(frozen=True)
class State:
    nonce: str
    user_id: int
    game_id: int
    expires_at: int
    # What the link is for: "request" (a creator's /request, for game_id) or "privacy" (/privacy,
    # with action one of privacy.ACTIONS and game_id 0).
    purpose: str = "request"
    action: str = ""


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _signature(secret: str, body: str) -> str:
    return _b64(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())


def sign_state(secret: str, user_id: int, game_id: int, now: float | None = None,
               ttl: int = TTL_SECONDS, nonce: str | None = None, purpose: str = "request",
               action: str = "") -> tuple[str, State]:
    """A new token and what's in it."""
    now = time.time() if now is None else now
    state = State(nonce or secrets.token_urlsafe(16), int(user_id), int(game_id), int(now) + ttl,
                  purpose, action)
    data = {"n": state.nonce, "u": str(state.user_id), "g": state.game_id, "e": state.expires_at}
    if purpose != "request":
        # Signed with the rest, so a /request link can't be turned into a /privacy one or back.
        data.update(p=purpose, a=action)
    body = _b64(json.dumps(data, separators=(",", ":")).encode())
    return f"{body}.{_signature(secret, body)}", state


def verify_state(secret: str, token: str, now: float | None = None) -> State:
    now = time.time() if now is None else now
    try:
        body, signature = token.split(".")
    except (AttributeError, ValueError):
        raise StateError("invalid") from None
    # Constant-time compare, so the signature can't be found out byte by byte.
    if not hmac.compare_digest(signature, _signature(secret, body)):
        raise StateError("invalid")
    try:
        data = json.loads(_unb64(body))
        state = State(str(data["n"]), int(data["u"]), int(data["g"]), int(data["e"]),
                      str(data.get("p", "request")), str(data.get("a", "")))
    except (ValueError, KeyError, TypeError, AttributeError):
        raise StateError("invalid") from None
    if now >= state.expires_at:
        raise StateError("expired", state)
    return state
