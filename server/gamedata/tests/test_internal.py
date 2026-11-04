"""The internal lookup (game data next to a Steam review's or post's author), and /health."""

from __future__ import annotations

import logging

from gamedata.signing import make_pid

from .harness import APP_ID, ENV, FRIEND, STEAMID, run

PID = make_pid(ENV["GAMEDATA_PEPPER"], STEAMID)
STRANGER = "76561198000000003"
OPTED = "76561198000000004"


async def lookup(w, steamids, key=None, path="/gamedata/v1/internal/lookup", **headers):
    key = w.cfg.internal_key if key is None else key
    response = await w.client.post(path, json={"steamids": steamids}, headers={"X-Internal-Key": key, **headers})
    return response.status, await response.json()


def test_lookup(tmp_path, caplog):
    caplog.set_level(logging.INFO)

    async def steps(w):
        one = await w.started(game_version="1.0.1")
        await w.upload(one["token"], one["session_id"], 0)
        two = await w.started(game_version="1.0.2")
        await w.upload(two["token"], two["session_id"], 0, events=[
            {"t": 5, "type": "progress", "data": {"day": 9, "coins": 300}},
            {"t": 2, "type": "progress", "data": {"day": 8}}])
        await w.client.post("/gamedata/v1/crash", headers={"Authorization": f"Bearer {two['token']}"},
                            json={"crashed_session_id": one["session_id"], "signal": "SIGSEGV"})
        w.store.set_opted_out(make_pid(ENV["GAMEDATA_PEPPER"], OPTED), True)
        w.steam.tickets["f00d" * 4] = (FRIEND, FRIEND)
        friend = await w.started(ticket="f00d" * 4, hardware=False)

        status, body = await lookup(w, [STEAMID, STRANGER, OPTED, FRIEND, STEAMID])
        assert status == 200 and body["ok"] is True
        players = body["players"]
        assert set(players) == {STEAMID, OPTED, FRIEND}  # the stranger has no data: left out
        assert players[OPTED] == {"opted_out": True}
        [game] = players[STEAMID]["games"]
        assert players[STEAMID]["opted_out"] is False
        assert game["app_id"] == APP_ID and game["sessions"] == 2
        assert game["last_version"] == "1.0.2" and game["crashes"] == 1
        assert game["progress"] == {"day": 9, "coins": 300}
        assert game["hardware"]["gpu"] == "NVIDIA GeForce RTX 3070"
        assert game["hardware"]["screen"] == [2560, 1440] and game["hardware"]["steam_deck"] is False
        assert isinstance(game["first_seen"], int) and isinstance(game["last_seen"], int)
        assert game["countries"] == [] and game["regions"] == []  # no geo database in this test
        [friend_game] = players[FRIEND]["games"]
        assert friend_game["hardware"] is None and friend_game["progress"] is None
        assert friend_game["crashes"] == 0 and friend["session_id"]

        # Anonymised: only the opt-out shows, nothing of the old data.
        w.store.anonymise(PID)
        status, body = await lookup(w, [STEAMID])
        assert body["players"] == {STEAMID: {"opted_out": True}}
        # The other path works too.
        assert (await lookup(w, [FRIEND], path="/v1/internal/lookup"))[0] == 200
    run(tmp_path, steps)
    text = "\n".join(r.getMessage() for r in caplog.records if r.name.startswith("gamedata"))
    for steamid in (STEAMID, STRANGER, OPTED, FRIEND):
        assert steamid not in text
    assert "lookup: 4 steamids, 3 with data or an opt-out" in text


def test_lookup_is_only_for_this_machine_with_the_key(tmp_path):
    async def steps(w):
        status, body = await lookup(w, [STEAMID], key="wrong")
        assert (status, body["error"]) == (403, "forbidden")
        status, body = await lookup(w, [STEAMID], key="")
        assert status == 403
        # Through Caddy (which always adds X-Forwarded-For): as if the route didn't exist.
        status, body = await lookup(w, [STEAMID], **{"X-Forwarded-For": "203.0.113.9"})
        assert (status, body["error"]) == (404, "not_found")
        status, body = await lookup(w, [STEAMID] * 201)
        assert status == 400
        status, body = await lookup(w, ["123", STEAMID])
        assert (status, body["error"]) == (400, "bad_steamid")
        status, body = await lookup(w, "76561198000000001")
        assert status == 400
        assert await lookup(w, []) == (200, {"ok": True, "players": {}})
    run(tmp_path, steps)


def test_health_shows_the_disk(tmp_path):
    async def steps(w):
        await w.started()
        response = await w.client.get("/gamedata/health", headers={"Origin": "https://status.fourgames.se"})
        body = await response.json()
        assert body["ok"] is True and isinstance(body["time"], int)
        disk = body["disk"]
        assert disk["used_bytes"] > 0 and disk["free_bytes"] > 0 and disk["total_bytes"] >= disk["free_bytes"]
        assert disk["low_space"] is False
        assert response.headers["Access-Control-Allow-Origin"] == "https://status.fourgames.se"
        response = await w.client.get("/v1/health")
        assert response.status == 200
    run(tmp_path, steps)


def test_health_warns_when_space_is_low(tmp_path):
    async def steps(w):
        body = await (await w.client.get("/health")).json()
        assert body["disk"]["low_space"] is True
    run(tmp_path, steps, GAMEDATA_MIN_FREE_MB=str(10 ** 9))
