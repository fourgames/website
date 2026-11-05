"""Test mode: GAMEDATA_TEST_APP_IDS takes sessions only from the GAMEDATA_TEST_STEAMIDS accounts, marks
them test, shows them to the player (and in the download) and keeps them out of the internal lookup."""

from __future__ import annotations

import json
import sqlite3
import time

import pytest

from gamedata import retention
from gamedata.config import Config, ConfigError
from gamedata.signing import make_pid
from gamedata.store import Store

from .harness import APP_ID, ENV, FRIEND, STEAMID, run, unzip

PID = make_pid(ENV["GAMEDATA_PEPPER"], STEAMID)
FRIEND_PID = make_pid(ENV["GAMEDATA_PEPPER"], FRIEND)
TEST_APP = 4242420
FRIEND_TICKET = "f00d" * 4
# The tester is STEAMID; only the test app is in test mode, APP_ID stays open to everyone.
TEST_ENV = {"GAMEDATA_TEST_APP_IDS": str(TEST_APP), "GAMEDATA_TEST_STEAMIDS": STEAMID}


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def friend(w) -> None:
    w.steam.tickets[FRIEND_TICKET] = (FRIEND, FRIEND)


def test_config(tmp_path):
    base = {**ENV, "DATA_DIR": str(tmp_path)}
    cfg = Config.from_env(base)
    assert cfg.test_app_ids == frozenset() and cfg.test_steamids == frozenset()
    cfg = Config.from_env({**base, "GAMEDATA_TEST_APP_IDS": f" {TEST_APP}, 480 ",
                           "GAMEDATA_TEST_STEAMIDS": f"{STEAMID},{FRIEND}"})
    assert cfg.test_app_ids == {TEST_APP, 480} and cfg.test_steamids == {STEAMID, FRIEND}
    # The open list is untouched by the test one.
    assert cfg.app_ids == {APP_ID, 3958210}
    assert STEAMID not in repr(cfg)
    for name, value in (("GAMEDATA_TEST_APP_IDS", "abc"), ("GAMEDATA_TEST_APP_IDS", "0"),
                        ("GAMEDATA_TEST_STEAMIDS", "1234"), ("GAMEDATA_TEST_STEAMIDS", f"{STEAMID},x")):
        with pytest.raises(ConfigError):
            Config.from_env({**base, name: value})


def test_a_tester_s_session_is_a_test_session(tmp_path):
    async def steps(w):
        body = await w.started(app_id=TEST_APP)
        session_id = body["session_id"]
        [row] = w.store.rows("sessions", PID)
        assert row["test"] == 1 and row["app_id"] == TEST_APP
        # The rest works as for any session: Steam was asked, events and the end are taken.
        assert w.steam.called("authenticate")[0]["appid"] == str(TEST_APP)
        assert (await w.upload(body["token"], session_id, 0))[0] == 200
        response = await w.client.post("/gamedata/v1/session/end", headers=bearer(body["token"]),
                                       json={"session_id": session_id, "seq": 1, "playtime_s": 30})
        assert response.status == 200
        assert w.store.rows("batches", PID)[0]["session_id"] == session_id
    run(tmp_path, steps, **TEST_ENV)


def test_anyone_else_is_told_the_app_is_unknown(tmp_path):
    async def steps(w):
        status, unknown = await w.start(app_id=480)
        assert status == 400
        friend(w)
        status, body = await w.start(app_id=TEST_APP, ticket=FRIEND_TICKET)
        assert status == 400 and body == unknown
        # Their switch off: still the same answer, not a known app's opted_out.
        status, body = await w.start(app_id=TEST_APP, ticket=FRIEND_TICKET, gameplay=False)
        assert status == 400 and body == unknown
        assert w.store.player(FRIEND_PID) is None
        # A tester with the switch off: nothing stored, as for any game.
        status, body = await w.start(app_id=TEST_APP, gameplay=False)
        assert status == 200 and body["opted_out"] is True and body["session_id"] is None
        assert w.store.player(PID) is None
    run(tmp_path, steps, **TEST_ENV)


def test_without_test_steamids_nobody_sends_test_sessions(tmp_path):
    async def steps(w):
        status, body = await w.start(app_id=TEST_APP)
        assert (status, body["error"]) == (400, "unknown_app")
        assert w.store.player(PID) is None
    run(tmp_path, steps, GAMEDATA_TEST_APP_IDS=str(TEST_APP))


def test_a_tester_must_own_the_game(tmp_path):
    async def steps(w):
        # Family Sharing: the tester plays someone else's copy, and Steam says they don't own it.
        w.steam.tickets["beef" * 4] = (STEAMID, FRIEND)
        status, body = await w.start(app_id=TEST_APP, ticket="beef" * 4)
        assert (status, body["error"]) == (403, "not_owned")
        assert [c["appid"] for c in w.steam.called("ownership")] == [str(TEST_APP)]
    run(tmp_path, steps, **TEST_ENV)


def test_an_app_in_both_lists_takes_everyone_and_marks_the_testers(tmp_path):
    async def steps(w):
        friend(w)
        await w.started()
        await w.started(ticket=FRIEND_TICKET)
        assert [r["test"] for r in w.store.rows("sessions", PID)] == [1]
        assert [r["test"] for r in w.store.rows("sessions", FRIEND_PID)] == [0]
    run(tmp_path, steps, GAMEDATA_TEST_APP_IDS=str(APP_ID), GAMEDATA_TEST_STEAMIDS=STEAMID)


def test_the_player_sees_and_downloads_test_sessions(tmp_path):
    async def steps(w):
        test = await w.started(app_id=TEST_APP)
        await w.upload(test["token"], test["session_id"], 0)
        real = await w.started()
        await w.upload(real["token"], real["session_id"], 0)
        # The next launch of the test app reports the last one's crash.
        again = await w.started(app_id=TEST_APP)
        response = await w.client.post("/gamedata/v1/crash", headers=bearer(again["token"]), json={
            "crashed_session_id": test["session_id"], "log_tail": "boom", "signal": "SIGSEGV"})
        assert response.status == 200
        cookie = await w.sign_in()
        me = await (await w.client.get("/gamedata/v1/me", headers=w.page(cookie))).json()
        by_app = {game["app_id"]: game for game in me["games"]}
        assert by_app[TEST_APP]["sessions"] == 2 and by_app[TEST_APP]["test_sessions"] == 2
        assert by_app[TEST_APP]["test"] is True
        assert "test" not in by_app[APP_ID] and "test_sessions" not in by_app[APP_ID]

        files = unzip(await (await w.client.get("/gamedata/v1/me/export", headers=w.page(cookie))).read())
        sessions = {s["session_id"]: s for s in json.loads(files["sessions.json"])}
        assert sessions[test["session_id"]]["test"] is True and sessions[again["session_id"]]["test"] is True
        assert sessions[real["session_id"]]["test"] is False
        test_batch = json.loads(files[f"events/{TEST_APP}/{test['session_id']}/0.json"])
        assert test_batch["test"] is True and test_batch["events"][0]["name"] == "plant_seed"
        assert "test" not in json.loads(files[f"events/{APP_ID}/{real['session_id']}/0.json"])
        [crash] = json.loads(files["crashes.json"])
        assert crash["test"] is True and crash["crashed_session_id"] == test["session_id"]
        assert "test             true for a test session" in files["README.txt"].decode()
    run(tmp_path, steps, **TEST_ENV)


async def lookup(w, steamids, **extra):
    response = await w.client.post("/gamedata/v1/internal/lookup", json={"steamids": steamids, **extra},
                                   headers={"X-Internal-Key": w.cfg.internal_key})
    return response.status, await response.json()


def test_the_lookup_leaves_test_sessions_out(tmp_path):
    async def steps(w):
        # A player with one real session and a test session of the same game that crashed, played
        # further and ran on other hardware (marked test here, as an app in both lists would).
        real = await w.started(game_version="1.0.1")
        await w.upload(real["token"], real["session_id"], 0, events=[
            {"t": 5, "type": "progress", "data": {"day": 2}}])
        test = await w.started(game_version="9.9.9-test", hardware_extra={"gpu": "Test GPU"})
        await w.upload(test["token"], test["session_id"], 0, events=[
            {"t": 50, "type": "progress", "data": {"day": 99}}])
        await w.client.post("/gamedata/v1/crash", headers=bearer(test["token"]),
                            json={"crashed_session_id": real["session_id"], "signal": "SIGSEGV"})
        # A second player with nothing but test sessions.
        friend(w)
        only_test = await w.started(ticket=FRIEND_TICKET)
        for session_id in (test["session_id"], only_test["session_id"]):
            w.store.db.execute("UPDATE sessions SET test = 1 WHERE session_id = ?", (session_id,))

        status, body = await lookup(w, [STEAMID, FRIEND])
        assert status == 200
        assert set(body["players"]) == {STEAMID}, "only test sessions: no data to show"
        [game] = body["players"][STEAMID]["games"]
        assert game["sessions"] == 1 and game["last_version"] == "1.0.1"
        assert game["progress"] == {"day": 2} and game["crashes"] == 0
        assert game["hardware"]["gpu"] == "NVIDIA GeForce RTX 3070"
        assert game["playtime_s"] == 5 and "test_sessions" not in game

        status, body = await lookup(w, [STEAMID, FRIEND], include_test=True)
        assert set(body["players"]) == {STEAMID, FRIEND}
        [game] = body["players"][STEAMID]["games"]
        assert game["sessions"] == 2 and game["test_sessions"] == 1 and game["last_version"] == "9.9.9-test"
        assert game["progress"] == {"day": 99} and game["crashes"] == 1 and game["hardware"]["gpu"] == "Test GPU"
        assert body["players"][FRIEND]["games"][0]["test"] is True

        status, body = await lookup(w, [STEAMID], include_test="yes")
        assert (status, body["error"]) == (400, "bad_request")
    run(tmp_path, steps)


def test_the_column_is_added_to_an_older_database(tmp_path):
    # A database made before test mode: the sessions table without the column, and a session in it.
    db = sqlite3.connect(tmp_path / "gamedata.db")
    db.execute("""CREATE TABLE sessions (session_id TEXT PRIMARY KEY, pid TEXT NOT NULL, app_id INTEGER NOT NULL,
                  started INTEGER NOT NULL, last_seen INTEGER NOT NULL, ended INTEGER, game_version TEXT,
                  build_id TEXT, godot_version TEXT, platform TEXT, locale TEXT, country TEXT, region TEXT,
                  consent_hardware INTEGER NOT NULL, previous_crash TEXT, boot_kind TEXT, input_type TEXT,
                  input_controller TEXT, dlc TEXT, owns_full_game INTEGER,
                  batches INTEGER NOT NULL DEFAULT 0, events INTEGER NOT NULL DEFAULT 0, last_t REAL,
                  last_progress TEXT, last_progress_t REAL, playtime_s REAL, end_seq INTEGER, summary TEXT,
                  active_s REAL, idle_s REAL, first_session INTEGER, last_scene TEXT, last_screen TEXT)""")
    db.execute("INSERT INTO sessions (session_id, pid, app_id, started, last_seen, consent_hardware) "
               "VALUES ('old', ?, ?, 1, 1, 0)", (PID, APP_ID))
    db.commit()
    db.close()
    store = Store(tmp_path)
    again = Store(tmp_path)  # a second connection (an export) opening the migrated file
    try:
        assert store.rows("sessions", PID)[0]["test"] == 0
        new = store.start_session(PID, APP_ID, {"consent_hardware": False, "test": True}, None, None)
        assert {r["session_id"]: r["test"] for r in again.rows("sessions", PID)} == {"old": 0, new: 1}
        assert store.summary(PID)["games"][0]["test_sessions"] == 1
    finally:
        store.close()
        again.close()


def test_anonymising_and_the_unlinking_treat_test_sessions_like_the_rest(tmp_path):
    store = Store(tmp_path)
    try:
        long_ago = time.time() - 30 * 31 * 86400
        test = store.start_session(PID, TEST_APP, {"consent_hardware": True, "test": True},
                                   {"os": "Linux"}, {"v": 1}, now=long_ago)
        assert store.stale_pids(time.time() - 86400) == [PID]
        assert retention.run(tmp_path, 24) == 1
        [row] = store.db.execute("SELECT pid, test FROM sessions WHERE session_id = ?", (test,)).fetchall()
        assert row["pid"] != PID and row["test"] == 1
        assert store.rows("sessions", PID) == []

        other = "c" * 32
        store.start_session(other, TEST_APP, {"consent_hardware": False, "test": True}, None, None)
        _, counts = store.anonymise(other)
        assert counts["sessions"] == 1 and store.opted_out(other)
    finally:
        store.close()
