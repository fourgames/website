"""The parts on their own: settings, pids and tokens, size caps, shape checks."""

from __future__ import annotations

import gzip
import hashlib
import hmac

import pytest

from gamedata import validate
from gamedata.config import Config, ConfigError
from gamedata.limits import RateLimiter, Refused, gunzip_capped
from gamedata.signing import (TokenError, make_pid, random_pid, sign, valid_steamid, verify)
from gamedata.steam import fresh_nonce

from .harness import ENV, STEAMID


# Config

def test_config_defaults():
    cfg = Config.from_env({**ENV, "GAMEDATA_APP_IDS": ""})
    # No game assumed: none may send data until its app id is added.
    assert cfg.app_ids == frozenset()
    assert (cfg.host, cfg.port, cfg.link_months) == ("127.0.0.1", 8103, 24)
    assert cfg.data_dir == "/srv/fourgames/gamedata"
    assert cfg.public_base_url == "https://api.fourgames.se/gamedata"
    assert cfg.callback_url == "https://api.fourgames.se/gamedata/v1/auth/callback"
    assert cfg.cookie_domain == "api.fourgames.se"
    assert cfg.realm == "https://api.fourgames.se"
    assert cfg.site_origin == "https://fourgames.se"
    assert cfg.privacy_url == "https://fourgames.se/privacy"
    assert (cfg.upload_every_s, cfg.max_batch_kb) == (60, 256)


def test_config_never_shows_secrets():
    text = repr(Config.from_env(ENV))
    for name in ("GAMEDATA_PEPPER", "GAMEDATA_COOKIE_SECRET", "GAMEDATA_INTERNAL_KEY", "GAMEDATA_TOKEN_SECRET",
                 "STEAM_PUBLISHER_KEY"):
        assert ENV[name] not in text


@pytest.mark.parametrize("missing", ["GAMEDATA_PEPPER", "GAMEDATA_COOKIE_SECRET", "GAMEDATA_INTERNAL_KEY",
                                     "GAMEDATA_TOKEN_SECRET", "STEAM_PUBLISHER_KEY"])
def test_config_needs_every_secret(missing):
    with pytest.raises(ConfigError, match=missing):
        Config.from_env({**ENV, missing: ""})


def test_config_refuses_short_or_shared_secrets():
    with pytest.raises(ConfigError, match="at least 32"):
        Config.from_env({**ENV, "GAMEDATA_PEPPER": "short"})
    with pytest.raises(ConfigError, match="different"):
        Config.from_env({**ENV, "GAMEDATA_COOKIE_SECRET": ENV["GAMEDATA_TOKEN_SECRET"]})


def test_config_app_ids():
    assert Config.from_env({**ENV, "GAMEDATA_APP_IDS": " 1, 2 ,3"}).app_ids == {1, 2, 3}
    with pytest.raises(ConfigError):
        Config.from_env({**ENV, "GAMEDATA_APP_IDS": "pomo"})
    with pytest.raises(ConfigError):
        Config.from_env({**ENV, "GAMEDATA_APP_IDS": "0"})


def test_config_demo_of():
    assert Config.from_env(ENV).demo_of == {}
    assert Config.from_env({**ENV, "GAMEDATA_DEMO_OF": "111:222, 333:444"}).demo_of == {111: 222, 333: 444}
    for bad in ("111", "111:abc", "111:111", "0:5"):
        with pytest.raises(ConfigError, match="GAMEDATA_DEMO_OF"):
            Config.from_env({**ENV, "GAMEDATA_DEMO_OF": bad})


# Pids and tokens

def test_pid_is_the_spec_hmac():
    pepper = ENV["GAMEDATA_PEPPER"]
    expected = hmac.new(pepper.encode(), b"steam:" + STEAMID.encode(), hashlib.sha256).hexdigest()[:32]
    assert make_pid(pepper, STEAMID) == expected
    assert make_pid(pepper, STEAMID) == make_pid(pepper, STEAMID)
    assert make_pid(pepper, STEAMID) != make_pid("other" + pepper, STEAMID)
    assert len(random_pid()) == 32 and random_pid() != random_pid()


@pytest.mark.parametrize("value, ok", [
    (STEAMID, True), (int(STEAMID), True), ("76561197960265729", True),
    ("76561197960265728", False), ("7656119800000000", False), ("765611980000000011", False),
    ("7656119800000000x", False), ("99999999999999999", False), (None, False), (True, False),
])
def test_valid_steamid(value, ok):
    assert (valid_steamid(value) is not None) == ok


def test_token_round_trip_and_expiry():
    token = sign("s" * 32, "session", {"s": "x", "p": "y"}, ttl=60, now=1000)
    assert verify("s" * 32, "session", token, now=1059)["p"] == "y"
    with pytest.raises(TokenError, match="expired"):
        verify("s" * 32, "session", token, now=1060)


def test_token_purpose_and_secret_matter():
    token = sign("s" * 32, "session", {"p": "y"}, ttl=60)
    with pytest.raises(TokenError, match="invalid"):
        verify("s" * 32, "cookie", token)
    with pytest.raises(TokenError, match="invalid"):
        verify("t" * 32, "session", token)


def test_token_tampering():
    token = sign("s" * 32, "cookie", {"p": "a" * 32}, ttl=60)
    other = sign("s" * 32, "cookie", {"p": "b" * 32}, ttl=60)
    forged = other.split(".")[0] + "." + token.split(".")[1]
    for bad in (forged, "", "abc", "a.b.c", None, 5):
        with pytest.raises(TokenError, match="invalid"):
            verify("s" * 32, "cookie", bad)


def test_fresh_nonce():
    assert fresh_nonce("2026-11-04T21:06:00Zabc", now=1793826360 + 30)
    assert not fresh_nonce("2026-11-04T21:06:00Zabc", now=1793826360 + 3600)
    assert not fresh_nonce("yesterday", now=1793826360)


# Caps

def test_gunzip_cap_stops_a_bomb():
    bomb = gzip.compress(b"\0" * (16 * 1024 * 1024))
    assert len(bomb) < 100 * 1024
    with pytest.raises(Refused) as info:
        gunzip_capped(bomb, 4 * 1024 * 1024)
    assert info.value.status == 413


def test_gunzip_takes_what_fits():
    assert gunzip_capped(gzip.compress(b"x" * 1000), 1000) == b"x" * 1000
    with pytest.raises(Refused):
        gunzip_capped(gzip.compress(b"x" * 1001), 1000)


@pytest.mark.parametrize("data", [b"not gzip", gzip.compress(b'{"a": 1}')[:-12]])
def test_gunzip_refuses_garbage_and_cut_off_data(data):
    with pytest.raises(Refused) as info:
        gunzip_capped(data, 1000)
    assert info.value.status == 400 and info.value.error == "bad_gzip"


def test_rate_limiter_window():
    now = [0.0]
    limiter = RateLimiter(2, 60, clock=lambda: now[0])
    assert limiter.allow("a") and limiter.allow("a")
    assert not limiter.allow("a")
    assert limiter.retry_after("a") == 61
    assert limiter.allow("b")
    now[0] = 61
    assert limiter.allow("a")


# Shapes

APPS = frozenset({5207970})
START = {"app_id": 5207970, "ticket": "abcdef", "consent": {"gameplay": True, "hardware": True}}


def test_start_strict_parts():
    assert validate.start(START, APPS).app_id == 5207970
    for body, code in [
        ({**START, "app_id": 1}, "unknown_app"),
        ({**START, "app_id": True}, "bad_request"),
        ({**START, "ticket": "not hex!"}, "bad_request"),
        ({**START, "ticket": "ab" * 5000}, "bad_request"),
        ({**START, "consent": {"gameplay": True}}, "bad_request"),
        ({**START, "consent": None}, "bad_request"),
    ]:
        with pytest.raises(Refused) as info:
            validate.start(body, APPS)
        assert info.value.error == code


def test_start_cleans_hardware_and_settings():
    start = validate.start({**START, "hardware": {"os": "x" * 500, "cpu_cores": "eight", "screen": [1920, 1080],
                                                 "steam_deck": "no", "extra": "dropped"},
                            "settings": {"volume": 0.5, "nested": {"a": 1}, "name": "y" * 999, "": 1}}, APPS)
    assert len(start.hardware["os"]) == 200
    assert start.hardware["cpu_cores"] is None and start.hardware["steam_deck"] is None
    assert start.hardware["screen"] == [1920, 1080] and "extra" not in start.hardware
    assert start.settings == {"volume": 0.5, "name": "y" * 256}


SID = "0b8e4d5c-7a3e-4f7e-9f7b-2a1d3c4b5a69"


def test_batch_checks_every_event():
    events = [{"t": 1, "type": "action", "name": "jump", "data": {"h": 2}, "junk": 1}]
    batch = validate.batch({"session_id": SID, "seq": 0, "events": events})
    assert batch.events == [{"t": 1, "type": "action", "name": "jump", "data": {"h": 2}}]
    for event in [{"t": -1, "type": "action", "name": "a"}, {"t": 1, "type": "nope"},
                  {"t": 1, "type": "action"}, {"t": float("nan"), "type": "rng"},
                  {"t": 1, "type": "custom", "data": [1, 2]}, {"t": True, "type": "rng"}, "x"]:
        with pytest.raises(Refused) as info:
            validate.batch({"session_id": SID, "seq": 0, "events": [event]})
        assert info.value.error == "bad_event"
    with pytest.raises(Refused) as info:
        validate.batch({"session_id": SID, "seq": 0, "events": [{"t": 0, "type": "rng"}] * 2001})
    assert info.value.error == "too_many_events"
    for bad in [{"session_id": "x", "seq": 0, "events": []}, {"session_id": SID, "seq": -1, "events": []},
                {"session_id": SID, "seq": 0, "events": {}}]:
        with pytest.raises(Refused):
            validate.batch(bad)


def test_crash_is_cleaned_not_refused():
    crash = validate.crash({"crashed_session_id": "bogus", "log_tail": "é" * 70000,
                            "last_events": [{"t": 1, "type": "rng"}, "half-written"] * 400,
                            "signal": "SIGSEGV", "os": "Linux"})
    assert crash.crashed_session_id is None
    assert len(crash.log_tail.encode()) <= 64 * 1024
    assert len(crash.last_events) == 250  # the last 500 entries, half of them broken
    assert crash.signal == "SIGSEGV"
