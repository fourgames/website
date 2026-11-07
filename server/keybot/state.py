"""The signed, expiring `state` in the "Verify your channel" link.

It ties the Discord login on the web back to the /request it came from (who asked, for which game),
and Discord hands it back unchanged on /callback. The signature means nobody can make one up for
someone else; the nonce is also stored in the database so each link works only once. The link
itself only carries the nonce, as a short code (/k/<code>); the page looks it up and rebuilds the
token for Discord.
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

# The short code in the link (verify.fourgames.se/k/<code>) is the nonce. No 0/O, 1/l/I, so it reads
# cleanly. 8 of 55 characters can't be guessed in 15 minutes, and a guessed one would still be
# useless: /callback only accepts the Discord account that ran /request.
CODE_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
CODE_LENGTH = 8


def new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def looks_like_code(text: str) -> bool:
    return len(text) == CODE_LENGTH and all(char in CODE_ALPHABET for char in text)


class StateError(Exception):
    """The state is unusable. str(error) is "invalid" or "expired"."""


@dataclass(frozen=True)
class State:
    nonce: str
    user_id: int
    game_id: int
    expires_at: int


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _signature(secret: str, body: str) -> str:
    return _b64(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())


def sign_state(secret: str, user_id: int, game_id: int, now: float | None = None,
               ttl: int = TTL_SECONDS, nonce: str | None = None) -> tuple[str, State]:
    """A new token and what's in it."""
    now = time.time() if now is None else now
    state = State(nonce or secrets.token_urlsafe(16), int(user_id), int(game_id), int(now) + ttl)
    body = _b64(json.dumps(
        {"n": state.nonce, "u": str(state.user_id), "g": state.game_id, "e": state.expires_at},
        separators=(",", ":"),
    ).encode())
    return f"{body}.{_signature(secret, body)}", state


def token_for(secret: str, state: State) -> str:
    """The signed token for a stored link, the same one sign_state made for it."""
    token, _ = sign_state(secret, state.user_id, state.game_id, now=state.expires_at - TTL_SECONDS,
                          ttl=TTL_SECONDS, nonce=state.nonce)
    return token


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
        state = State(str(data["n"]), int(data["u"]), int(data["g"]), int(data["e"]))
    except (ValueError, KeyError, TypeError):
        raise StateError("invalid") from None
    if now >= state.expires_at:
        raise StateError("expired")
    return state
