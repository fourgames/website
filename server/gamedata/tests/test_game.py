"""The games' endpoints, end to end: session start (with a fake Steam), events, end, crash."""

from __future__ import annotations

import gzip
import json
import logging
import secrets
import uuid

from gamedata.signing import make_pid, sign
from gamedata.web import Limits

from .harness import APP_ID, ENV, FRIEND, HARDWARE, PUBLISHER_KEY, STEAMID, TICKET, run

PID = make_pid(ENV["GAMEDATA_PEPPER"], STEAMID)


def test_start_checks_the_ticket_and_stores_the_session(tmp_path, caplog):
    caplog.set_level(logging.INFO)

    async def steps(w):
        # Hardware keys beyond the known ones (a device id, say) are never stored.
        body = await w.started(hardware_extra={"device_id": "HWID-0042-SECRET", "mac": "00:11:22:33:44:55"})
        [call] = w.steam.called("authenticate")
        assert call == {"key": PUBLISHER_KEY, "appid": str(APP_ID), "ticket": TICKET, "identity": "fourgames-gamedata"}
        # The player's own copy (ownersteamid == steamid): no ownership call needed.
        assert w.steam.called("ownership") == []
        assert str(uuid.UUID(body["session_id"])) == body["session_id"]
        assert body["upload_every_s"] == 60 and body["max_batch_kb"] == 256
        assert body["privacy_url"] == "https://fourgames.se/privacy"
        session = w.store.session(body["session_id"])
        assert session.pid == PID and session.app_id == APP_ID
        hardware = w.store.rows("hardware", PID)[0]
        assert (hardware["gpu"], hardware["screen_w"], hardware["screen_h"], hardware["steam_deck"]) == (
            HARDWARE["gpu"], 2560, 1440, 0)
        assert json.loads(w.store.rows("settings", PID)[0]["data"]) == {"volume": 0.8, "fullscreen": True, "lang": "en"}
        return body
    run(tmp_path, steps)

    # Nothing anywhere holds the steamid, the ticket or the extra hardware keys: not the database,
    # not the files, not the logs.
    for path in (tmp_path / "data").rglob("*"):
        if path.is_file():
            data = path.read_bytes()
            for secret in (STEAMID, TICKET, "HWID-0042", "00:11:22:33:44:55", "device_id"):
                assert secret.encode() not in data
    # Our own logs (the test servers' access logs are on in tests only; the service turns them off).
    text = "\n".join(record.getMessage() for record in caplog.records if record.name.startswith("gamedata"))
    assert STEAMID not in text and TICKET not in text
    assert f"session start {PID[:8]} app {APP_ID}" in text and PID not in text


def test_no_app_ids_means_no_game_is_taken(tmp_path):
    async def steps(w):
        status, body = await w.start()
        assert (status, body["error"]) == (400, "unknown_app")
        assert w.steam.calls == []
    run(tmp_path, steps, GAMEDATA_APP_IDS="")


def test_both_paths_work(tmp_path):
    async def steps(w):
        response = await w.client.post("/v1/session/start", json={
            "app_id": APP_ID, "ticket": TICKET, "consent": {"gameplay": True, "hardware": False}})
        assert response.status == 200
        body = await response.json()
        status, _ = await w.upload(body["token"], body["session_id"], 0, path="/v1/events")
        assert status == 200
    run(tmp_path, steps)


def test_no_gameplay_consent_means_nothing_at_all(tmp_path):
    async def steps(w):
        status, body = await w.start(gameplay=False)
        assert status == 200
        assert body == {"ok": True, "session_id": None, "token": None, "opted_out": True, "upload_every_s": 60,
                        "max_batch_kb": 256, "privacy_url": "https://fourgames.se/privacy"}
        assert w.steam.calls == []
        assert w.store.player(PID) is None and w.store.rows("sessions", PID) == []
    run(tmp_path, steps)


def test_no_hardware_consent_keeps_hardware_and_settings_out(tmp_path):
    async def steps(w):
        await w.started(hardware=False)
        assert w.store.rows("sessions", PID)[0]["consent_hardware"] == 0
        assert w.store.rows("hardware", PID) == [] and w.store.rows("settings", PID) == []
    run(tmp_path, steps)


def test_opted_out_player_gets_no_session(tmp_path):
    async def steps(w):
        w.store.set_opted_out(PID, True)
        status, body = await w.start()
        assert status == 200 and body["opted_out"] is True and body["session_id"] is None
        assert w.store.rows("sessions", PID) == []
    run(tmp_path, steps)


def test_start_refusals(tmp_path):
    async def steps(w):
        status, body = await w.start(app_id=480)
        assert (status, body["error"]) == (400, "unknown_app")
        status, body = await w.start(ticket="deadbeef")
        assert (status, body["error"]) == (401, "bad_ticket")
        assert body["ok"] is False and body["message"]
        # Family Sharing: the ticket is the friend's, the copy someone else's.
        w.steam.tickets["beef" * 4] = (FRIEND, STEAMID)
        status, body = await w.start(ticket="beef" * 4)
        assert (status, body["error"]) == (403, "not_owned")
        w.steam.owns[(FRIEND, APP_ID)] = True
        status, body = await w.start(ticket="beef" * 4)
        assert status == 200 and body["session_id"]
        assert [c["steamid"] for c in w.steam.called("ownership")] == [FRIEND, FRIEND]
        w.steam.fail_status = 503
        status, body = await w.start()
        assert (status, body["error"]) == (502, "steam_unavailable")
        response = await w.client.post("/gamedata/v1/session/start", data=b"{nope",
                                       headers={"Content-Type": "application/json"})
        assert (response.status, (await response.json())["error"]) == (400, "bad_json")
        response = await w.client.post("/gamedata/v1/session/start", data=b"x" * (65 * 1024))
        assert (response.status, (await response.json())["error"]) == (413, "too_large")
    run(tmp_path, steps)


def test_rate_limit_per_ip(tmp_path):
    limits = Limits()
    limits.start_ip.limit = 2

    async def steps(w):
        assert (await w.start())[0] == 200
        assert (await w.start())[0] == 200
        status, body = await w.start()
        assert (status, body["error"]) == (429, "rate_limited")
    run(tmp_path, steps, limits=limits)


def test_events_are_stored_once_as_gzip(tmp_path):
    async def steps(w):
        body = await w.started()
        token, sid = body["token"], body["session_id"]
        assert await w.upload(token, sid, 0) == (200, {"ok": True})
        assert await w.upload(token, sid, 0) == (200, {"ok": True, "duplicate": True})
        assert await w.upload(token, sid, 1) == (200, {"ok": True})
        [b0, b1] = w.store.rows("batches", PID)
        assert (b0["seq"], b0["events"], b1["seq"]) == (0, 3, 1)
        path = tmp_path / "data" / b0["path"]
        assert path.parts[-5:-2] == ("raw", str(APP_ID), path.parts[-3]) and path.parts[-2] == sid
        assert path.name == "0.json.gz"
        stored = json.loads(gzip.decompress(path.read_bytes()))
        assert stored["session_id"] == sid and stored["seq"] == 0
        assert stored["events"][0] == {"t": 12.345, "type": "action", "name": "plant_seed",
                                       "data": {"x": 3, "y": 7, "crop": "carrot"}}
        assert PID not in json.dumps(stored)
        session = w.store.rows("sessions", PID)[0]
        assert (session["batches"], session["events"], session["last_t"]) == (2, 6, 20.1)
    run(tmp_path, steps)


def test_events_need_their_own_valid_token(tmp_path):
    async def steps(w):
        body = await w.started()
        token, sid = body["token"], body["session_id"]
        status, answer = await w.upload("nonsense", sid, 0)
        assert (status, answer["error"]) == (401, "bad_token")
        expired = sign(w.cfg.token_secret, "session", {"s": sid, "p": PID, "a": APP_ID}, ttl=-1)
        status, answer = await w.upload(expired, sid, 0)
        assert (status, answer["error"]) == (401, "token_expired")
        other = str(uuid.uuid4())
        status, answer = await w.upload(token, other, 0)
        assert (status, answer["error"]) == (403, "session_mismatch")
        # Signed with the cookie secret instead: not a session token.
        forged = sign(w.cfg.cookie_secret, "session", {"s": sid, "p": PID, "a": APP_ID}, ttl=60)
        status, answer = await w.upload(forged, sid, 0)
        assert (status, answer["error"]) == (401, "bad_token")
        response = await w.client.post("/gamedata/v1/events", json={"session_id": sid, "seq": 0, "events": []})
        assert response.status == 401
    run(tmp_path, steps)


def test_event_caps(tmp_path):
    async def steps(w):
        body = await w.started()
        token, sid = body["token"], body["session_id"]
        status, answer = await w.upload(token, sid, 0, events=[{"t": 1, "type": "teleport"}])
        assert (status, answer["error"]) == (400, "bad_event")
        status, answer = await w.upload(token, sid, 0, events=[{"t": 1, "type": "rng"}] * 2001)
        assert (status, answer["error"]) == (400, "too_many_events")
        # A gzip bomb: 16 MB of spaces in about 16 KB.
        bomb = gzip.compress(b'{"session_id": "' + b" " * (16 * 1024 * 1024) + b'"}')
        status, answer = await w.upload(token, sid, 0, raw=bomb)
        assert (status, answer["error"]) == (413, "too_large")
        status, answer = await w.upload(token, sid, 0, raw=b"\x1f\x8b" + b"x" * (300 * 1024))
        assert (status, answer["error"]) == (413, "too_large")
        status, answer = await w.upload(token, sid, 0, raw=b"not gzip")
        assert (status, answer["error"]) == (400, "bad_gzip")
        assert w.store.rows("batches", PID) == []
    run(tmp_path, steps)


def test_daily_cap_per_player(tmp_path):
    async def steps(w):
        body = await w.started()
        token, sid = body["token"], body["session_id"]
        answers = []
        for seq in range(12):
            # About 160 KB of gzip each: random text doesn't compress.
            noisy = [{"t": i, "type": "snapshot", "data": {"noise": secrets.token_hex(100)}} for i in range(1500)]
            status, answer = await w.upload(token, sid, seq, events=noisy)
            answers.append((status, answer.get("error")))
            if status != 200:
                break
        assert answers[-1] == (429, "daily_cap")
        assert 5 <= len(answers) <= 8
        stored = sum(row["bytes"] for row in w.store.rows("batches", PID))
        assert 1024 * 1024 <= stored < 1024 * 1024 + 256 * 1024
    run(tmp_path, steps, GAMEDATA_MAX_MB_PER_DAY="1")


def test_full_disk_refuses_uploads(tmp_path):
    async def steps(w):
        body = await w.started()
        status, answer = await w.upload(body["token"], body["session_id"], 0)
        assert (status, answer["error"]) == (503, "storage_full")
    run(tmp_path, steps, GAMEDATA_MIN_FREE_MB=str(10 ** 9))


def test_opting_out_stops_a_running_session(tmp_path):
    async def steps(w):
        body = await w.started()
        w.store.set_opted_out(PID, True)
        status, answer = await w.upload(body["token"], body["session_id"], 0)
        assert (status, answer["error"]) == (403, "opted_out")
        assert w.store.rows("batches", PID) == []
    run(tmp_path, steps)


def test_session_end(tmp_path):
    async def steps(w):
        body = await w.started()
        headers = {"Authorization": f"Bearer {body['token']}"}
        end = {"session_id": body["session_id"], "seq": 40, "playtime_s": 1834, "summary": {"day": 9}}
        response = await w.client.post("/gamedata/v1/session/end", json=end, headers=headers)
        assert (response.status, await response.json()) == (200, {"ok": True})
        response = await w.client.post("/gamedata/v1/session/end", json={**end, "playtime_s": 5}, headers=headers)
        assert await response.json() == {"ok": True, "duplicate": True}
        row = w.store.rows("sessions", PID)[0]
        assert (row["end_seq"], row["playtime_s"], json.loads(row["summary"])) == (40, 1834, {"day": 9})
        assert row["ended"] is not None
        response = await w.client.post("/gamedata/v1/session/end", headers=headers,
                                       json={**end, "summary": {"x": "y" * 20000}})
        assert (response.status, (await response.json())["error"]) == (413, "too_large")
    run(tmp_path, steps)


def test_crash_report(tmp_path):
    async def steps(w):
        old = await w.started()
        new = await w.started()
        headers = {"Authorization": f"Bearer {new['token']}"}
        report = {"crashed_session_id": old["session_id"], "game_version": "1.0.2",
                  "log_tail": "ERROR: boom\n" * 100, "last_events": [{"t": 3, "type": "action", "name": "dig"}],
                  "signal": "SIGSEGV", "os": "Windows 11"}
        response = await w.client.post("/gamedata/v1/crash", json=report, headers=headers)
        assert (response.status, await response.json()) == (200, {"ok": True})
        response = await w.client.post("/gamedata/v1/crash", json=report, headers=headers)
        assert await response.json() == {"ok": True, "duplicate": True}
        [row] = w.store.rows("crashes", PID)
        assert (row["crashed_session_id"], row["signal"], row["events"]) == (old["session_id"], "SIGSEGV", 1)
        stored = json.loads(gzip.decompress((tmp_path / "data" / row["path"]).read_bytes()))
        assert stored["log_tail"].startswith("ERROR: boom") and stored["last_events"][0]["name"] == "dig"
        assert row["path"].startswith(f"crashes/{APP_ID}/")

        # Someone else's session id can't be tied to this player's crash.
        w.steam.tickets["cafe" * 4] = (FRIEND, FRIEND)
        friend = await w.started(ticket="cafe" * 4)
        response = await w.client.post("/gamedata/v1/crash", json=report,
                                       headers={"Authorization": f"Bearer {friend['token']}"})
        assert response.status == 200
        friend_pid = make_pid(ENV["GAMEDATA_PEPPER"], FRIEND)
        assert w.store.rows("crashes", friend_pid)[0]["crashed_session_id"] is None
    run(tmp_path, steps)


def test_errors_are_json(tmp_path):
    async def steps(w):
        response = await w.client.get("/gamedata/v1/nothing-here")
        assert (response.status, await response.json()) == (404, {
            "ok": False, "error": "not_found", "message": "Not Found"})
        response = await w.client.get("/gamedata/v1/events")
        assert response.status == 405 and (await response.json())["error"] == "method_not_allowed"
        response = await w.client.get("/gamedata/health")
        assert (await response.json())["ok"] is True
        assert response.headers["Cache-Control"] == "no-store"
    run(tmp_path, steps)


DEMO = 3958210


def test_start_and_end_extras(tmp_path):
    async def steps(w):
        body = await w.started(input={"type": "gamepad", "controller": "Xbox Wireless Controller", "serial": "x"},
                               dlc=[{"app_id": 111, "owned": True}, {"app_id": "222", "owned": True}, "junk"],
                               boot_kind="first_after_update")
        row = w.store.rows("sessions", PID)[0]
        assert (row["input_type"], row["input_controller"]) == ("gamepad", "Xbox Wireless Controller")
        assert json.loads(row["dlc"]) == [{"app_id": 111, "owned": True}]
        assert row["boot_kind"] == "first_after_update"
        headers = {"Authorization": f"Bearer {body['token']}"}
        response = await w.client.post("/gamedata/v1/session/end", headers=headers, json={
            "session_id": body["session_id"], "seq": 3, "playtime_s": 600, "active_s": 540.5, "idle_s": "lots",
            "first_session": True, "last_scene": "res://farm.tscn", "last_screen": "inventory"})
        assert response.status == 200
        row = w.store.rows("sessions", PID)[0]
        assert (row["active_s"], row["idle_s"], row["first_session"], row["last_scene"], row["last_screen"]) == (
            540.5, None, 1, "res://farm.tscn", "inventory")

        # Without the hardware consent, what they play with isn't kept; the rest is.
        await w.started(hardware=False, input={"type": "keyboard"}, boot_kind="sideways",
                        dlc=[{"app_id": 5, "owned": False}])
        row = w.store.rows("sessions", PID)[1]
        assert (row["input_type"], row["input_controller"], row["boot_kind"]) == (None, None, None)
        assert json.loads(row["dlc"]) == [{"app_id": 5, "owned": False}]
    run(tmp_path, steps)


def test_new_event_types_and_oversized_events(tmp_path):
    async def steps(w):
        body = await w.started()
        token, sid = body["token"], body["session_id"]
        events = [{"t": 1, "type": kind, "name": kind, "data": {"v": 1}}
                  for kind in ("perf", "load", "input", "idle", "setting_changed", "screen", "marker")]
        events.append({"t": 0.4, "type": "load", "data": {"boot_ms": 2300, "to_play_ms": 5100}})
        events.append({"t": 2, "type": "snapshot", "data": {"blob": "x" * 40000}})
        status, answer = await w.upload(token, sid, 0, events=events)
        assert (status, answer) == (200, {"ok": True, "dropped": 1})
        [batch] = w.store.rows("batches", PID)
        assert batch["events"] == 8
        status, answer = await w.upload(token, sid, 1, events=[{"t": 1, "type": ["perf"]}])
        assert (status, answer["error"]) == (400, "bad_event")
    run(tmp_path, steps)


def test_demo_then_full_game(tmp_path):
    async def steps(w):
        w.steam.owns[(STEAMID, APP_ID)] = True
        await w.started(app_id=DEMO)
        # The demo's session start asked Steam whether the player has the full game.
        assert [(c["steamid"], c["appid"]) for c in w.steam.called("ownership")] == [(STEAMID, str(APP_ID))]
        assert w.store.rows("sessions", PID)[0]["owns_full_game"] == 1
        cookie = await w.sign_in()
        games = (await (await w.client.get("/gamedata/v1/me", headers=w.page(cookie))).json())["games"]
        assert [(g["app_id"], g.get("demo_of"), g.get("owns_game")) for g in games] == [(DEMO, APP_ID, True)]

        await w.started(app_id=APP_ID)
        games = (await (await w.client.get("/gamedata/v1/me", headers=w.page(cookie))).json())["games"]
        assert [(g["app_id"], g.get("demo_of"), g.get("owns_game"), g.get("played_demo")) for g in games] == [
            (DEMO, APP_ID, True, None), (APP_ID, None, None, True)]
        players = (await (await w.client.post("/gamedata/v1/internal/lookup", json={"steamids": [STEAMID]},
                                              headers={"X-Internal-Key": w.cfg.internal_key})).json())["players"]
        assert [g["app_id"] for g in players[STEAMID]["games"]] == [DEMO, APP_ID]
        assert players[STEAMID]["games"][0]["owns_game"] is True
    run(tmp_path, steps, GAMEDATA_DEMO_OF=f"{DEMO}:{APP_ID}")


def test_demo_ownership_unknown_never_blocks(tmp_path):
    async def steps(w):
        # Steam's ownership answer for the full game is "no" here: the demo session still starts.
        await w.started(app_id=DEMO)
        assert w.store.rows("sessions", PID)[0]["owns_full_game"] == 0
        cookie = await w.sign_in()
        games = (await (await w.client.get("/gamedata/v1/me", headers=w.page(cookie))).json())["games"]
        assert games[0]["owns_game"] is False
    run(tmp_path, steps, GAMEDATA_DEMO_OF=f"{DEMO}:{APP_ID}")
