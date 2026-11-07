"""The signed, expiring state in the verify link."""

import pytest

from keybot.state import TTL_SECONDS, StateError, looks_like_code, new_code, sign_state, token_for, verify_state

SECRET = "s" * 40


def test_round_trip():
    token, state = sign_state(SECRET, 123456789012345678, 7, now=1000)
    assert verify_state(SECRET, token, now=1001) == state
    assert state.user_id == 123456789012345678 and state.game_id == 7
    assert state.expires_at == 1000 + TTL_SECONDS == 1900


def test_expires_after_15_minutes():
    token, _ = sign_state(SECRET, 1, 2, now=1000)
    verify_state(SECRET, token, now=1000 + 899)
    with pytest.raises(StateError, match="expired"):
        verify_state(SECRET, token, now=1000 + 900)


def test_wrong_secret():
    token, _ = sign_state(SECRET, 1, 2, now=1000)
    with pytest.raises(StateError, match="invalid"):
        verify_state("t" * 40, token, now=1000)


def test_tampered_body():
    token, _ = sign_state(SECRET, 1, 2, now=1000)
    other, _ = sign_state(SECRET, 999, 2, now=1000)
    forged = other.split(".")[0] + "." + token.split(".")[1]
    with pytest.raises(StateError, match="invalid"):
        verify_state(SECRET, forged, now=1000)


@pytest.mark.parametrize("token", ["", "abc", "a.b.c", "!!!.???", None])
def test_garbage(token):
    with pytest.raises(StateError, match="invalid"):
        verify_state(SECRET, token, now=1000)


def test_nonces_differ():
    a, _ = sign_state(SECRET, 1, 2, now=1000)
    b, _ = sign_state(SECRET, 1, 2, now=1000)
    assert a != b


def test_short_codes_rebuild_the_same_token():
    code = new_code()
    assert looks_like_code(code) and not looks_like_code("0O1lI000") and not looks_like_code(code + "a")
    token, state = sign_state(SECRET, 5, 7, now=1000, nonce=code)
    assert token_for(SECRET, state) == token
    assert verify_state(SECRET, token, now=1001) == state
