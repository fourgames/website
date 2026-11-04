"""The privacy page's side, end to end: Steam sign-in (OpenID, with a fake Steam), the cookie, the
summary, opting out, the download and anonymising. Also CORS and CSRF."""

from __future__ import annotations

import json
import logging
from urllib.parse import parse_qs, urlsplit

import pytest

from gamedata.signing import make_pid, sign

from .harness import APP_ID, ENV, SITE, STEAMID, cookies, run, unzip

PID = make_pid(ENV["GAMEDATA_PEPPER"], STEAMID)


# Sign-in

def test_sign_in_redirects_to_steam(tmp_path):
    async def steps(w):
        response = await w.client.get("/gamedata/v1/auth/steam?return=/privacy", allow_redirects=False)
        assert response.status == 302
        location = urlsplit(response.headers["Location"])
        assert f"{location.scheme}://{location.netloc}{location.path}" == "https://steamcommunity.com/openid/login"
        query = {k: v[0] for k, v in parse_qs(location.query).items()}
        assert query["openid.mode"] == "checkid_setup"
        assert query["openid.ns"] == "http://specs.openid.net/auth/2.0"
        assert query["openid.realm"] == "https://api.fourgames.se"
        assert query["openid.claimed_id"] == query["openid.identity"] == \
            "http://specs.openid.net/auth/2.0/identifier_select"
        assert query["openid.return_to"].startswith("https://api.fourgames.se/gamedata/v1/auth/callback?state=")
        state = cookies(response)["fg_openid"]
        assert state["httponly"] and state["secure"] and state["samesite"] == "Lax"
    run(tmp_path, steps)


@pytest.mark.parametrize("back", ["/privacy", "/ja/privacy", "/ko/privacy", "/zh-cn/privacy", "/zh-tw/privacy",
                                  "/privacy?tab=data"])
def test_sign_in_round_trip(tmp_path, back, caplog):
    caplog.set_level(logging.INFO)

    async def steps(w):
        location, nonce = await w.begin_sign_in(back)
        response = await w.finish_sign_in(location, nonce)
        assert response.status == 302
        assert response.headers["Location"] == SITE + back
        cookie = cookies(response)["fg_privacy"]
        assert cookie["httponly"] and cookie["secure"]
        assert cookie["samesite"] == "None" and cookie["domain"] == "api.fourgames.se"
        assert cookie["max-age"] == "3600" and cookie["path"] == "/"
        # Steam itself was asked, with every field it sent and mode check_authentication.
        [check] = w.steam.called("openid")
        assert check["openid.mode"] == "check_authentication"
        assert check["openid.claimed_id"] == f"https://steamcommunity.com/openid/id/{STEAMID}"
        assert check["openid.sig"] == "c2lnbmF0dXJl"
        # The cookie holds the pid, signed; never the steamid.
        assert STEAMID not in cookie.value
        response = await w.client.get("/gamedata/v1/me", headers=w.page(cookie.value))
        assert await response.json() == {"ok": True, "signed_in": True, "opted_out": False, "games": []}
    run(tmp_path, steps)
    text = "\n".join(r.getMessage() for r in caplog.records if r.name.startswith("gamedata"))
    assert STEAMID not in text and f"signed in {PID[:8]}" in text


@pytest.mark.parametrize("back", ["https://evil.example/", "//evil.example/x", "/\\evil.example", "privacy",
                                  "/a//b", "/x\ny", "javascript:alert(1)"])
def test_return_must_be_a_path_on_the_site(tmp_path, back):
    async def steps(w):
        response = await w.client.get("/gamedata/v1/auth/steam", params={"return": back}, allow_redirects=False)
        assert response.status == 400 and (await response.json())["error"] == "bad_return"
    run(tmp_path, steps)


CLAIMED = "openid.claimed_id"


@pytest.mark.parametrize("changes, asks_steam", [
    ({CLAIMED: "https://evil.example/openid/id/76561198000000001",
      "openid.identity": "https://evil.example/openid/id/76561198000000001"}, False),
    ({CLAIMED: "http://steamcommunity.com/openid/id/76561198000000001",
      "openid.identity": "http://steamcommunity.com/openid/id/76561198000000001"}, False),
    ({CLAIMED: "https://steamcommunity.com/openid/id/123",
      "openid.identity": "https://steamcommunity.com/openid/id/123"}, False),
    ({"openid.identity": "https://steamcommunity.com/openid/id/76561198000000002"}, False),
    ({"openid.op_endpoint": "https://evil.example/openid/login"}, False),
    ({"openid.return_to": "https://evil.example/callback"}, False),
    ({"openid.signed": "signed,op_endpoint,identity,return_to,response_nonce,assoc_handle"}, False),
    ({"openid.response_nonce": "2020-01-01T00:00:00Zold"}, False),
    ({"openid.mode": "setup_needed"}, False),
    ({}, True),  # Steam says is_valid:false (below)
])
def test_bad_sign_ins_are_refused(tmp_path, changes, asks_steam):
    async def steps(w):
        w.steam.openid_valid = False
        location, nonce = await w.begin_sign_in()
        response = await w.finish_sign_in(location, nonce, **changes)
        assert response.status == 302
        assert response.headers["Location"] == SITE + "/privacy?signin=failed"
        assert "fg_privacy" not in cookies(response)
        assert bool(w.steam.called("openid")) == asks_steam
    run(tmp_path, steps)


def test_sign_in_needs_the_browser_that_started_it(tmp_path):
    async def steps(w):
        location, _ = await w.begin_sign_in()
        response = await w.finish_sign_in(location, None)
        assert response.headers["Location"] == SITE + "/privacy?signin=failed"
        response = await w.finish_sign_in(location, "someone-elses-nonce")
        assert response.headers["Location"] == SITE + "/privacy?signin=failed"
        assert w.steam.called("openid") == []
    run(tmp_path, steps)


def test_cancel_and_broken_state(tmp_path):
    async def steps(w):
        location, nonce = await w.begin_sign_in("/ja/privacy")
        response = await w.finish_sign_in(location, nonce, **{"openid.mode": "cancel"})
        assert response.headers["Location"] == SITE + "/ja/privacy?signin=cancelled"
        response = await w.client.get("/gamedata/v1/auth/callback?state=forged.state", allow_redirects=False)
        assert response.headers["Location"] == SITE + "/privacy?signin=failed"
    run(tmp_path, steps)


def test_steam_down_during_sign_in(tmp_path):
    async def steps(w):
        location, nonce = await w.begin_sign_in()
        await w.steam_server_down()
        response = await w.finish_sign_in(location, nonce)
        assert response.headers["Location"] == SITE + "/privacy?signin=failed"
    run(tmp_path, steps)


# The page's calls

def test_me_without_cookie_and_with_a_forged_one(tmp_path):
    async def steps(w):
        for cookie in (None, "garbage", sign("x" * 40, "cookie", {"p": PID}, 60),
                       sign(w.cfg.cookie_secret, "cookie", {"p": PID}, -1),
                       sign(w.cfg.cookie_secret, "session", {"p": PID}, 60)):
            response = await w.client.get("/gamedata/v1/me", headers=w.page(cookie))
            assert await response.json() == {"ok": True, "signed_in": False}
    run(tmp_path, steps)


def test_me_summarises_the_games(tmp_path):
    async def steps(w):
        one = await w.started()
        await w.upload(one["token"], one["session_id"], 0)
        await w.client.post("/gamedata/v1/session/end", headers={"Authorization": f"Bearer {one['token']}"},
                            json={"session_id": one["session_id"], "seq": 1, "playtime_s": 1834.4})
        two = await w.started()
        await w.upload(two["token"], two["session_id"], 0)  # no end yet: last event time counts
        cookie = await w.sign_in()
        response = await w.client.get("/gamedata/v1/me", headers=w.page(cookie))
        body = await response.json()
        assert body["signed_in"] is True and body["opted_out"] is False
        [game] = body["games"]
        assert game["app_id"] == APP_ID and game["sessions"] == 2
        assert game["playtime_s"] == round(1834.4 + 20.1)
        assert isinstance(game["first_seen"], int) and isinstance(game["last_seen"], int)
        assert game["first_seen"] <= game["last_seen"]
        assert response.headers["Access-Control-Allow-Origin"] == SITE
        assert response.headers["Access-Control-Allow-Credentials"] == "true"
    run(tmp_path, steps)


@pytest.mark.parametrize("path", ["/gamedata/v1/me", "/gamedata/v1/me/optout", "/gamedata/v1/me/export",
                                  "/gamedata/v1/me/anonymise", "/gamedata/v1/auth/signout", "/v1/me/optout"])
def test_preflight(tmp_path, path):
    async def steps(w):
        response = await w.client.options(path, headers={
            "Origin": SITE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
        assert response.status == 204
        assert response.headers["Access-Control-Allow-Origin"] == SITE
        assert response.headers["Access-Control-Allow-Credentials"] == "true"
        assert "POST" in response.headers["Access-Control-Allow-Methods"]
        assert "GET" in response.headers["Access-Control-Allow-Methods"]
        assert response.headers["Access-Control-Allow-Headers"] == "Content-Type"
        response = await w.client.options(path, headers={"Origin": "https://evil.example",
                                                         "Access-Control-Request-Method": "POST"})
        assert "Access-Control-Allow-Origin" not in response.headers
    run(tmp_path, steps)


def test_opt_out_on_the_page(tmp_path):
    async def steps(w):
        cookie = await w.sign_in()
        url = "/gamedata/v1/me/optout"
        # CSRF: another site, no Origin, or not JSON.
        for headers in ({"Origin": "https://evil.example"}, {}):
            response = await w.client.post(url, json={"opted_out": True},
                                           headers={**headers, "Cookie": f"fg_privacy={cookie}"})
            assert (response.status, (await response.json())["error"]) == (403, "bad_origin")
        response = await w.client.post(url, data="opted_out=true", headers={
            **w.page(cookie), "Content-Type": "application/x-www-form-urlencoded"})
        assert (response.status, (await response.json())["error"]) == (415, "unsupported_media_type")
        response = await w.client.post(url, json={"opted_out": True}, headers=w.page())
        assert (response.status, (await response.json())["error"]) == (401, "not_signed_in")
        response = await w.client.post(url, json={"opted_out": "yes"}, headers=w.page(cookie))
        assert response.status == 400

        response = await w.client.post(url, json={"opted_out": True}, headers=w.page(cookie))
        assert await response.json() == {"ok": True, "opted_out": True}
        assert response.headers["Access-Control-Allow-Origin"] == SITE
        status, body = await w.start()
        assert status == 200 and body["opted_out"] is True and body["session_id"] is None
        response = await w.client.get("/gamedata/v1/me", headers=w.page(cookie))
        assert (await response.json())["opted_out"] is True

        response = await w.client.post(url, json={"opted_out": False}, headers=w.page(cookie))
        assert await response.json() == {"ok": True, "opted_out": False}
        assert (await w.start())[1]["opted_out"] is False
    run(tmp_path, steps)


def test_export_has_everything(tmp_path):
    async def steps(w):
        old = await w.started()
        await w.upload(old["token"], old["session_id"], 0)
        await w.upload(old["token"], old["session_id"], 1)
        new = await w.started()
        await w.client.post("/gamedata/v1/crash", headers={"Authorization": f"Bearer {new['token']}"}, json={
            "crashed_session_id": old["session_id"], "game_version": "1.0.2", "log_tail": "boom",
            "last_events": [{"t": 1, "type": "action", "name": "dig"}], "signal": "SIGSEGV", "os": "Windows 11"})
        cookie = await w.sign_in()
        response = await w.client.get("/gamedata/v1/me/export", headers=w.page(cookie))
        assert response.status == 200
        assert response.headers["Content-Type"] == "application/zip"
        assert 'filename="fourgames-data.zip"' in response.headers["Content-Disposition"]
        assert response.headers["Access-Control-Allow-Origin"] == SITE
        assert response.headers["Access-Control-Allow-Credentials"] == "true"
        files = unzip(await response.read())
        assert {"README.txt", "player.json", "sessions.json", "hardware.json", "settings.json",
                "crashes.json"} <= set(files)
        player = json.loads(files["player.json"])
        assert player["pid"] == PID and player["opted_out"] is False
        sessions = json.loads(files["sessions.json"])
        assert [s["session_id"] for s in sessions] == [old["session_id"], new["session_id"]]
        assert sessions[0]["started"].endswith("Z") and "pid" not in sessions[0]
        assert json.loads(files["hardware.json"])[0]["gpu"] == "NVIDIA GeForce RTX 3070"
        assert json.loads(files["settings.json"])[0]["data"]["volume"] == 0.8
        batch = json.loads(files[f"events/{APP_ID}/{old['session_id']}/1.json"])
        assert batch["seq"] == 1 and batch["events"][0]["name"] == "plant_seed"
        [crash] = json.loads(files["crashes.json"])
        assert crash["signal"] == "SIGSEGV" and crash["crashed_session_id"] == old["session_id"]
        assert json.loads(files[crash["log_file"]])["log_tail"] == "boom"
        readme = files["README.txt"].decode()
        assert "sessions.json" in readme and "24 months" in readme and "db-ip.com" in readme
        assert STEAMID.encode() not in b"".join(files.values())

        response = await w.client.get("/gamedata/v1/me/export")
        assert (response.status, (await response.json())["error"]) == (401, "not_signed_in")
        response = await w.client.head("/gamedata/v1/me/export", headers=w.page(cookie))
        assert response.status == 405
    run(tmp_path, steps)


def test_anonymise(tmp_path):
    async def steps(w):
        old = await w.started()
        await w.upload(old["token"], old["session_id"], 0)
        new = await w.started()
        await w.client.post("/gamedata/v1/crash", headers={"Authorization": f"Bearer {new['token']}"},
                            json={"crashed_session_id": old["session_id"], "signal": "unclean exit"})
        cookie = await w.sign_in()
        url = "/gamedata/v1/me/anonymise"
        response = await w.client.post(url, json={}, headers=w.page(cookie))
        assert (response.status, (await response.json())["error"]) == (400, "confirm_needed")
        response = await w.client.post(url, json={"confirm": True}, headers={"Cookie": f"fg_privacy={cookie}"})
        assert response.status == 403  # CSRF check first

        response = await w.client.post(url, json={"confirm": True}, headers=w.page(cookie))
        assert await response.json() == {"ok": True}
        cleared = cookies(response)["fg_privacy"]
        assert cleared.value == "" and cleared["max-age"] == "0" and cleared["domain"] == "api.fourgames.se"

        # Nothing is the player's any more; the rows are still there, under one new pid.
        db = w.store.db
        for table in ("sessions", "hardware", "settings", "batches", "crashes"):
            assert db.execute(f"SELECT COUNT(*) FROM {table} WHERE pid = ?", (PID,)).fetchone()[0] == 0
        pids = {row[0] for table in ("sessions", "hardware", "settings", "batches", "crashes")
                for row in db.execute(f"SELECT pid FROM {table}")}
        assert len(pids) == 1 and PID not in pids
        assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 2
        assert w.store.opted_out(PID)

        # The page shows nothing, the download has nothing, the game is told to stop.
        response = await w.client.get("/gamedata/v1/me", headers=w.page(cookie))
        assert await response.json() == {"ok": True, "signed_in": True, "opted_out": True, "games": []}
        files = unzip(await (await w.client.get("/gamedata/v1/me/export", headers=w.page(cookie))).read())
        assert json.loads(files["sessions.json"]) == [] and not any(n.startswith("events/") for n in files)
        status, body = await w.upload(old["token"], old["session_id"], 5)
        assert (status, body["error"]) == (403, "opted_out")
        assert (await w.start())[1]["opted_out"] is True
    run(tmp_path, steps)


def test_sign_out(tmp_path):
    async def steps(w):
        cookie = await w.sign_in()
        response = await w.client.post("/gamedata/v1/auth/signout", json={}, headers=w.page(cookie))
        assert await response.json() == {"ok": True}
        assert cookies(response)["fg_privacy"]["max-age"] == "0"
        response = await w.client.post("/gamedata/v1/auth/signout", json={}, headers={"Origin": "https://evil.example"})
        assert response.status == 403
    run(tmp_path, steps)
