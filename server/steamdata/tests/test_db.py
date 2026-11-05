"""The database: schema, the app list, snapshots, players, metadata, engine signals."""

import json

from steamdata import cadence, steam
from steamdata.db import Store
from steamdata.engine import Signal
from steamdata.pcgw import PageInfo
from steamdata.steam import ListApp

from .conftest import NOW, details, item


def snap(appid, name="Game", **kw):
    return steam.parse_item(item(appid, name, **kw))


def app(store, appid):
    return store.db.execute("SELECT * FROM apps WHERE appid = ?", (appid,)).fetchone()


def changes(store, appid):
    return [(r["field"], r["old"], r["new"]) for r in
            store.db.execute("SELECT * FROM app_changes WHERE appid = ? ORDER BY id", (appid,))]


def add(store, *appids, now=NOW, full=True):
    return store.save_list_apps([ListApp(a, f"App {a}", 100, 7) for a in appids], now, full=full)


def test_wal_and_reopening(db_path):
    s = Store(db_path)
    assert s.db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    add(s, 10)
    s.close()
    s = Store(db_path)  # the schema again is a no-op; the data is there
    assert app(s, 10)["name"] == "App 10"
    assert s.db.execute("PRAGMA user_version").fetchone()[0] == 1
    s.close()


def test_app_list_adds_and_updates(store):
    assert add(store, 10, 20) == 2
    row = app(store, 10)
    assert row["type"] == "game" and row["snapshot_due"] == int(NOW) and row["details_due"] == 0
    assert row["players_due"] is None  # waits for the first snapshot
    assert add(store, 10, 30, now=NOW + 60) == 1
    assert app(store, 10)["list_seen"] == int(NOW + 60) and app(store, 20)["list_seen"] == int(NOW)


def test_full_list_marks_the_missing(store):
    add(store, *range(1, 21))
    started = NOW + 100
    add(store, *range(1, 20), now=started)  # 20 is gone
    assert store.finish_full_list(started, started) == 1
    assert app(store, 20)["in_list"] == 0
    assert changes(store, 20) == [("in_list", "1", "0")]
    add(store, 20, now=started + 100)  # and back
    assert app(store, 20)["in_list"] == 1 and changes(store, 20)[-1] == ("in_list", "0", "1")


def test_a_cut_short_list_marks_nothing(store):
    add(store, *range(1, 21))
    started = NOW + 100
    add(store, 1, 2, now=started)
    assert store.finish_full_list(started, started) == 0
    assert app(store, 20)["in_list"] == 1


def test_snapshot_writes_the_day_and_schedules(store, rng):
    add(store, 10, 20, 30)
    rows = store.save_snapshot({10: snap(10, reviews=5000, price=249, original=499, discount=50),
                                20: snap(20, reviews=0, coming_soon=True, price=None),
                                30: None}, NOW, rng)
    assert rows == 1  # the coming-soon game has nothing to record yet
    day = store.db.execute("SELECT * FROM app_daily WHERE appid = 10").fetchone()
    assert day["day"] == cadence.day_number(NOW)
    assert (day["reviews"], day["positive_pct"], day["price"], day["price_original"], day["discount"]) == (5000, 90, 249, 499, 50)
    a = app(store, 10)
    assert a["snapshot_due"] == cadence.next_snapshot(NOW)
    assert a["players_due"] == int(NOW)  # 5,000 reviews: sampled right away
    assert json.loads(a["tags"]) == [19, 492] and json.loads(a["developers"]) == ["Dev"]
    assert app(store, 20)["players_due"] is None  # not out yet
    hidden = app(store, 30)
    assert hidden["visible"] == 0 and hidden["snapshot_due"] == int(NOW) + cadence.HIDDEN_RETRY
    assert changes(store, 10) == []  # the first fill isn't a change


def test_an_old_id_answered_by_another_app_leaves_collection(store, rng):
    add(store, 201270, 34330)
    store.save_snapshot({201270: snap(34330, "Total War: SHOGUN 2", reviews=5000)}, NOW, rng)
    old = app(store, 201270)
    assert old["type"] == "redirect" and old["parent_appid"] == 34330
    assert (old["snapshot_due"], old["players_due"], old["details_due"]) == (None, None, None)
    assert changes(store, 201270) == [("type", "game", "redirect")]
    assert app(store, 34330)["snapshot_at"] is None  # untouched: it gets its own snapshot
    assert store.due("snapshot", NOW + 60, 10) == [34330]


def test_first_player_sample_waits_by_reviews(store, rng):
    add(store, 1, 2, 3)
    store.save_snapshot({1: snap(1, reviews=150), 2: snap(2, reviews=3), 3: snap(3, reviews=0)}, NOW, rng)
    assert app(store, 1)["players_due"] == int(NOW) + cadence.HOUR
    assert app(store, 2)["players_due"] == int(NOW) + cadence.DAY
    assert app(store, 3)["players_due"] == int(NOW) + 3 * cadence.DAY


def test_changes_between_snapshots(store, rng):
    add(store, 10)
    store.save_snapshot({10: snap(10, coming_soon=True, release=1_800_000_000, price=None, reviews=0)}, NOW, rng)
    tomorrow = NOW + cadence.DAY
    store.save_snapshot({10: snap(10, coming_soon=True, release=1_810_000_000, price=None, reviews=0,
                                  tags=(19, 492, 1716))}, tomorrow, rng)
    assert ("release_ts", "1800000000", "1810000000") in changes(store, 10)
    assert ("tags", "[19,492]", "[19,492,1716]") in changes(store, 10)
    # Released: players and metadata right away.
    later = tomorrow + cadence.DAY
    store.save_snapshot({10: snap(10, release=1_810_000_000, reviews=2)}, later, rng)
    a = app(store, 10)
    assert ("coming_soon", "1", "0") in changes(store, 10)
    assert a["players_due"] == int(later) and a["details_due"] == int(later)


def test_non_games_stop_being_collected(store, rng):
    add(store, 10)
    store.save_snapshot({10: snap(10, kind=4)}, NOW, rng)
    a = app(store, 10)
    assert a["type"] == "dlc"
    assert a["snapshot_due"] is None and a["players_due"] is None and a["details_due"] is None


def test_player_samples_and_backoff(store, rng):
    add(store, 10)
    store.save_snapshot({10: snap(10, reviews=5000)}, NOW, rng)
    interval = store.save_players(10, 250, NOW, rng)
    assert 0.9 * 4 * cadence.HOUR <= interval <= 1.1 * 4 * cadence.HOUR
    assert store.db.execute("SELECT players FROM players WHERE appid = 10").fetchone()[0] == 250
    store.save_players(10, 120, NOW + 100, rng)
    day = store.db.execute("SELECT players_peak FROM app_daily WHERE appid = 10").fetchone()[0]
    assert day == 250  # the day's highest
    a = app(store, 10)
    assert a["players_max"] == 250 and a["players_max_at"] == int(NOW) and a["players_last"] == 120
    # Nobody playing: 2, 4, 8 ... days, at most 30.
    gaps = [store.save_players(10, 0, NOW + 1000 * i, rng) / cadence.DAY for i in range(1, 8)]
    for gap, expected in zip(gaps, [2, 4, 8, 16, 30, 30, 30]):
        assert 0.9 * expected <= gap <= 1.1 * expected
    # No count from Steam: no sample, but it counts as nobody.
    store.save_players(10, None, NOW + 9000, rng)
    assert store.db.execute("SELECT COUNT(*) FROM players WHERE appid = 10 AND ts = ?", (int(NOW + 9000),)).fetchone()[0] == 0


def test_godot_games_are_sampled_hourly(store, rng):
    add(store, 10)
    store.save_snapshot({10: snap(10, reviews=5000)}, NOW, rng)
    store.save_players(10, 50, NOW, rng)  # next one in ~4 hours
    store.add_manual_signal(10, "godot", "the developer told us", NOW + 60)
    a = app(store, 10)
    assert a["godot"] == 1 and a["players_due"] == int(NOW) + cadence.HOUR  # an hour after the last
    assert store.save_players(10, 150, NOW, rng) <= 1.1 * cadence.HOUR
    assert store.save_players(10, 0, NOW + 10, rng) <= 1.1 * 6 * cadence.HOUR
    assert 0.9 * 4 * cadence.HOUR <= store.save_players(10, 5, NOW + 20, rng) <= 1.1 * 4 * cadence.HOUR
    for _ in range(6):  # nobody, again and again: backs off to a week
        last = store.save_players(10, 0, NOW + 30, rng)
    assert 0.9 * 7 * cadence.DAY <= last <= 1.1 * 7 * cadence.DAY


def test_new_reviews_wake_a_quiet_game(store, rng):
    add(store, 10)
    store.save_snapshot({10: snap(10, reviews=5000)}, NOW, rng)
    store.save_players(10, 0, NOW, rng)
    assert app(store, 10)["players_due"] > NOW + cadence.DAY
    store.save_snapshot({10: snap(10, reviews=5001)}, NOW + cadence.DAY, rng)
    assert app(store, 10)["players_due"] == int(NOW + cadence.DAY)


def test_details_and_store_text_signals(store, rng):
    add(store, 10, 20)
    data = details("Ten", legal="Made with Godot Engine (MIT).", genres=((1, "Action"), (23, "Indie")))
    d = steam.parse_details(data)
    store.save_details(10, d, [Signal("godot", "store_legal", 2, "Made with Godot Engine")], NOW, rng, 30)
    a = app(store, 10)
    assert a["details_status"] == "ok" and json.loads(a["genres"]) == [1, 23]
    assert a["languages"] == "English*,French" and a["dlc_count"] == 2
    assert 27 * cadence.DAY <= a["details_due"] - NOW <= 33 * cadence.DAY
    assert a["godot"] == 1
    assert store.db.execute("SELECT name FROM genres WHERE id = 23").fetchone()[0] == "Indie"
    assert store.db.execute("SELECT name FROM categories WHERE id = 2").fetchone()[0] == "Single-player"
    # The next refresh no longer says Godot: the signal and the flag go.
    store.save_details(10, steam.parse_details(details("Ten")), [], NOW + 100, rng, 30)
    assert app(store, 10)["godot"] == 0
    store.save_details(20, None, [], NOW, rng, 30)
    assert app(store, 20)["details_status"] == "unavailable"


def test_due_order(store):
    add(store, 10, 30, 20)
    assert store.due("details", NOW, 10) == [30, 20, 10]  # new ones, newest first
    assert store.due("snapshot", NOW, 10) == [10, 20, 30]
    store.delay("snapshot", [10], NOW + 100)
    assert store.due("snapshot", NOW, 10) == [20, 30]
    assert store.count_due("snapshot", NOW + 100) == 3


def test_pcgamingwiki_pass(store, rng):
    add(store, 10)
    pages = [PageInfo(1, "Ten", 5, (10,), 2, "PCGamingWiki infobox: Godot 4"),
             PageInfo(2, "Unknown To Us", 6, (99,), 2, "PCGamingWiki infobox: Godot"),
             PageInfo(3, "Port", 7, (42,), 1, "links Engine:Godot")]
    store.save_pcgw_pages("godot", pages, NOW)
    result = store.finish_pcgw("godot", {1, 2, 3}, NOW)
    assert result["games"] == 3 and result["strong"] == 2 and result["new_apps"] == 1
    assert app(store, 10)["godot"] == 1
    stub = app(store, 99)  # found through PCGamingWiki: the snapshot finds out what it is
    assert stub["type"] is None and stub["godot"] == 1 and stub["snapshot_due"] == int(NOW)
    assert app(store, 42) is None  # a mention doesn't add apps
    assert store.pcgw_revisions("godot") == {1: 5, 2: 6, 3: 7}
    # Next week page 1 no longer links Godot.
    result = store.finish_pcgw("godot", {2, 3}, NOW + cadence.PCGW_EVERY)
    assert result["removed"] == 1 and app(store, 10)["godot"] == 0
    assert store.db.execute("SELECT COUNT(*) FROM engine_signals WHERE appid = 10").fetchone()[0] == 0


def test_views(store, rng):
    add(store, 10)
    store.save_snapshot({10: snap(10, reviews=200, pct=95)}, NOW, rng)
    row = store.db.execute("SELECT * FROM daily").fetchone()
    assert row["date"] == "2026-11-04" and row["positive_est"] == 190 and row["negative_est"] == 10
    store.add_manual_signal(10, "godot", "x", NOW)
    assert store.db.execute("SELECT sources FROM godot_games").fetchone()[0] == "manual"


def test_http_log_and_pruning(store):
    store.add_http_counts(5, {"h": {"ok": 2, "throttled": 1, "failed": 0, "bytes": 10}})
    store.add_http_counts(5, {"h": {"ok": 3, "throttled": 0, "failed": 1, "bytes": 5}})
    row = store.db.execute("SELECT ok, throttled, failed, bytes FROM http_log").fetchone()
    assert tuple(row) == (5, 1, 1, 15)
    add(store, 10)
    store.db.execute("INSERT INTO players VALUES (10, 100, 1), (10, 200, 2)")
    assert store.prune_samples(150) == 1
