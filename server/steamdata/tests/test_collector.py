"""The collector against the fake Steam and PCGamingWiki, on a fake clock."""

import json
from dataclasses import replace

import pytest

from steamdata import cadence
from steamdata.collector import Collector
from steamdata.db import Store

from .conftest import GODOT_PAGE, MENTION_PAGE, NOW, details, item


def world(web):
    web.listed = [10, 20, 30, 1942280]
    web.items = {10: item(10, "Ten", reviews=5000), 20: item(20, "Twenty", reviews=3),
                 30: item(30, "Soon", coming_soon=True, price=None, reviews=0),
                 1942280: item(1942280, "Brotato", reviews=112908, price=249, original=499, discount=50),
                 555: item(555, "Godot Only", reviews=50)}
    web.players = {10: 300, 1942280: 17523, 555: 4}
    web.details = {10: details("Ten"), 20: details("Twenty", legal="Godot Engine, MIT license"),
                   30: details("Soon"), 1942280: details("Brotato"), 555: details("Godot Only")}
    web.ai = {1942280: "Some <b>item icons</b> were made with AI.", 555: None}
    web.pcgw_pages = {1: ("Brotato", 11, GODOT_PAGE % 1942280), 2: ("Godot Only", 12, GODOT_PAGE % 555),
                      3: ("Victoria II", 13, MENTION_PAGE % 42960)}


def run_for(collector, clock, seconds, max_requests=None):
    end = clock.now + seconds

    def sleep(s):
        clock.sleep(s)
        if clock.now >= end:
            collector.stop()

    collector.sleep = sleep
    collector._stop.clear()
    return collector.run(max_requests=max_requests)


def gaps(calls):
    times = [c[0] for c in calls]
    return [b - a for a, b in zip(times, times[1:])]


def app(store, appid):
    return store.db.execute("SELECT * FROM apps WHERE appid = ?", (appid,)).fetchone()


def test_an_hour_of_collecting(config, store, http, web, clock, rng):
    world(web)
    collector = Collector(config, store, http, clock=clock, rng=rng)
    run_for(collector, clock, cadence.HOUR)

    # Every lane ran.
    assert len(web.calls_to("GetAppList")) == 1 and len(web.calls_to("GetTagList")) == 1
    assert len(web.calls_to("/w/api.php")) == 2  # the backlinks, then the 3 pages' text in one request
    assert store.db.execute("SELECT COUNT(*) FROM tags").fetchone()[0] == 2

    # The daily snapshot: one row per game with something to record, today.
    today = cadence.day_number(NOW)
    rows = {r["appid"]: r for r in store.db.execute("SELECT * FROM app_daily WHERE day = ?", (today,))}
    assert set(rows) == {10, 20, 1942280, 555}  # not the coming-soon one
    assert (rows[1942280]["reviews"], rows[1942280]["price"], rows[1942280]["discount"]) == (112908, 249, 50)

    # PCGamingWiki's Godot games are in the Godot set, including one the app list didn't have;
    # the store's legal notice put app 20 in too; the mere mention (Victoria II) didn't.
    assert {r[0] for r in store.db.execute("SELECT appid FROM apps WHERE godot = 1")} == {20, 555, 1942280}
    assert app(store, 555)["type"] == "game" and app(store, 42960) is None
    sources = {(r["appid"], r["source"], r["strength"]) for r in store.db.execute("SELECT * FROM engine_signals")}
    assert (1942280, "pcgamingwiki", 2) in sources and (42960, "pcgamingwiki", 1) in sources
    assert (20, "store_legal", 2) in sources

    # Players: the Godot games about hourly, the popular one once (every 4 hours), the one with 3
    # reviews not yet (a day), the unreleased one never.
    samples = {}
    for r in store.db.execute("SELECT appid, COUNT(*) AS n FROM players GROUP BY appid"):
        samples[r["appid"]] = r["n"]
    assert samples.get(10) == 1 and samples.get(1942280, 0) >= 1 and samples.get(555, 0) >= 1
    assert 20 not in samples and 30 not in samples

    # Full metadata for all five.
    assert store.db.execute("SELECT COUNT(*) FROM apps WHERE details_status = 'ok'").fetchone()[0] == 5

    # The pace per host.
    webapi = [c for c in web.calls if c[1] == "api.steampowered.com"]
    assert min(gaps(webapi)) >= 1.0 - 1e-6
    assert min(gaps(web.calls_to("/api/appdetails"))) >= 2.5 - 1e-6
    assert min(gaps(web.calls_to("/w/api.php"))) >= 10 - 1e-6

    # Done and scheduled.
    assert store.meta("applist_run") is None
    assert store.meta_float("applist_full_due") == pytest.approx(NOW + cadence.DAY, abs=60)
    assert store.meta_float("pcgw_due") > NOW + 6 * cadence.DAY
    assert app(store, 10)["snapshot_due"] == cadence.next_snapshot(NOW)
    # The AI disclosure: every game here is recent (Nov 2023), so all 5 store pages are read once.
    assert len(web.calls_to("/app/")) == 5
    assert (app(store, 1942280)["ai"], app(store, 1942280)["ai_text"]) == (1, "Some item icons were made with AI.")
    assert app(store, 10)["ai"] == 0 and app(store, 30)["ai"] == 0
    assert app(store, 555)["ai"] is None and app(store, 555)["ai_due"] == pytest.approx(NOW + cadence.HIDDEN_RETRY, abs=3600)
    assert app(store, 10)["ai_due"] > NOW + 50 * cadence.DAY
    store_calls = sorted(web.calls_to("/api/appdetails") + web.calls_to("/app/"))
    assert min(gaps(store_calls)) >= 2.5 - 1e-6  # one pace for the whole store host
    log = {r["host"]: r["ok"] for r in store.db.execute("SELECT * FROM http_log")}
    assert log["api.steampowered.com"] == len(webapi) and log["store.steampowered.com"] == 10


def test_the_next_day_gets_its_own_snapshot(config, store, http, web, clock, rng):
    world(web)
    collector = Collector(config, store, http, clock=clock, rng=rng, lanes={"applist", "snapshot"})
    run_for(collector, clock, cadence.HOUR)
    first = len(web.calls_to("GetItems"))
    web.items[10] = item(10, "Ten", reviews=5100)
    run_for(collector, clock, cadence.DAY)
    assert len(web.calls_to("GetItems")) > first
    days = [tuple(r) for r in store.db.execute("SELECT day, reviews FROM app_daily WHERE appid = 10 ORDER BY day")]
    assert days == [(cadence.day_number(NOW), 5000), (cadence.day_number(NOW) + 1, 5100)]


def test_throttled_store_pauses_and_slows(config, store, http, web, clock, rng):
    world(web)
    web.fail["/api/appdetails"] = [(429, {}, b"")]
    collector = Collector(config, store, http, clock=clock, rng=rng, lanes={"applist", "details"})
    run_for(collector, clock, 30 * 60)
    calls = web.calls_to("/api/appdetails")
    assert gaps(calls)[0] >= 300  # paused 5 minutes
    assert min(gaps(calls)[1:]) >= 2.5 * 1.5 - 1e-6  # and slower after
    assert calls[0][3]["appids"] == calls[1][3]["appids"]  # the same app again, nothing lost
    assert store.db.execute("SELECT COUNT(*) FROM apps WHERE details_status = 'ok'").fetchone()[0] == 4


def test_failing_item_is_put_off(config, store, http, web, clock, rng):
    world(web)
    web.listed = [10]
    web.fail["/ISteamUserStats/GetNumberOfCurrentPlayers/v1/"] = [(503, {}, b"")] * 3
    collector = Collector(config, store, http, clock=clock, rng=rng, lanes={"applist", "snapshot", "players"})
    run_for(collector, clock, 10 * 60)
    assert len(web.calls_to("GetNumberOfCurrentPlayers")) == 3
    assert app(store, 10)["players_due"] >= NOW + cadence.RETRY_LATER
    assert store.db.execute("SELECT COUNT(*) FROM players").fetchone()[0] == 0


def test_restart_carries_on_with_the_app_list(config, db_path, http, web, clock, rng):
    web.listed = list(range(1, 26))
    web.page_size = 10
    first = Store(db_path)
    Collector(config, first, http, clock=clock, sleep=clock.sleep, rng=rng, lanes={"applist"}).run(max_requests=1)
    first.close()  # stopped after one page
    assert json.loads(Store(db_path).meta("applist_run"))["cursor"] == 10

    second = Store(db_path)
    clock.now += 30
    Collector(config, second, http, clock=clock, sleep=clock.sleep, rng=rng, lanes={"applist"}).run(max_requests=2)
    assert [c[3]["last_appid"] for c in web.calls_to("GetAppList")] == ["0", "10", "20"]
    assert second.db.execute("SELECT COUNT(*) FROM apps").fetchone()[0] == 25
    assert second.meta("applist_run") is None
    second.close()


def test_without_a_key_pcgamingwiki_games_are_still_collected(config, store, http, web, clock, rng):
    world(web)
    collector = Collector(replace(config, web_api_key=""), store, http, clock=clock, rng=rng)
    run_for(collector, clock, cadence.HOUR)
    assert web.calls_to("GetAppList") == []
    assert {r[0] for r in store.db.execute("SELECT appid FROM apps")} == {555, 1942280}
    assert store.db.execute("SELECT COUNT(*) FROM players").fetchone()[0] >= 2


def test_a_crash_keeps_what_was_committed(config, db_path, http, web, clock, rng):
    world(web)
    store = Store(db_path)
    collector = Collector(config, store, http, clock=clock, sleep=clock.sleep, rng=rng,
                          lanes={"applist", "snapshot"})
    collector.run(max_requests=2)
    # No close(): as if the process died here.
    reopened = Store(db_path)
    assert reopened.db.execute("SELECT COUNT(*) FROM app_daily").fetchone()[0] == 3
    reopened.close()
    store.db.close()
