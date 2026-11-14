"""The market files (market.py): a small made-up Steam, built and read back."""

import gzip
import json

import pytest

from steamdata import cadence, market, steam
from steamdata.db import Store
from steamdata.engine import Signal
from steamdata.steam import ListApp

from .conftest import NOW, item

DAY = 86400
TODAY = cadence.day_number(NOW)
COZY, SHOOTER, INDIE, PIXEL = 1662, 1774, 492, 3964


def read(out, name):
    with gzip.open(out / f"{name}.json.gz") as f:
        return json.load(f)


def make_steam(db_path, rng):
    """60 games released a year ago and 60 in the last 90 days: cozy games got more common and
    do better; 60 small releases this fortnight and one indie breakout among them; one Godot game;
    one coming soon."""
    s = Store(db_path)
    apps, snaps = [], {}

    def game(appid, days_ago, reviews, tags, price=999, **kw):
        apps.append(ListApp(appid, f"Game {appid}", 100, 1))
        snaps[appid] = steam.parse_item(item(appid, f"Game {appid}", reviews=reviews, price=price, tags=tags,
                                             release=int(NOW - days_ago * DAY), **kw))

    appid = 1000
    for i in range(60):  # a year ago: mostly shooters
        game(appid := appid + 1, 400 + i % 20, 50 + i, (COZY, INDIE) if i < 10 else (SHOOTER, INDIE))
    for i in range(60):  # lately (3 a day, so each has 20+ peers): half cozy, and the cozy ones get more reviews
        cozy = i % 2 == 0
        game(appid := appid + 1, 30 + i // 3, 400 + i if cozy else 5 + i % 7, (COZY, PIXEL, INDIE) if cozy else (SHOOTER, INDIE))
    for i in range(20):  # lately too: free shooters with lots of reviews, which earn nothing
        game(3000 + i, 30 + i // 2, 900 + i, (SHOOTER, INDIE), free=True, price=None)
    for i in range(60):  # this fortnight: small releases, the breakout's peers
        game(2000 + i, i % 10, i % 4, (SHOOTER, INDIE))
    game(5000, 5, 3000, (COZY, INDIE), price=1499)  # the breakout
    game(6000, 200, 120, (PIXEL, INDIE), devs=("Godot Studio",))
    game(6001, 600, 40, (PIXEL, INDIE), devs=("Godot Studio",))  # the studio's older, smaller game
    game(7000, -60, 0, (COZY,), price=None, coming_soon=True, devs=("Godot Studio",))
    s.save_list_apps(apps, NOW, full=True)
    s.save_snapshot(snaps, NOW, rng)
    s.save_tags([(COZY, "Cozy"), (SHOOTER, "Shooter"), (INDIE, "Indie"), (PIXEL, "Pixel Graphics")])
    with s.transaction():
        for a in (6000, 7000):
            s._upsert_signal(a, Signal("godot", "store_legal", 2, "Godot Engine"), int(NOW))
    s.refresh_godot(None, NOW)
    # The AI disclosure: the breakout and 2 of the small releases disclose AI, the rest of those read don't.
    for a in [5000, 2000, 2001] + list(range(2002, 2010)):
        s.save_ai(a, steam.AiDisclosure(a in (5000, 2000, 2001), "AI art." if a in (5000, 2000, 2001) else ""), NOW, rng, 60)
    # A week of history: the breakout gained 1,000 reviews this week.
    s.db.execute("INSERT INTO app_daily (day, appid, reviews) VALUES (?, 5000, 2000)", (TODAY - 7,))
    # Game 6000 sold at half price on the days most of its reviews came in.
    for back, reviews, price in ((6, 60, 999), (5, 100, 499), (4, 110, 499), (3, 112, 999)):
        s.db.execute("INSERT INTO app_daily (day, appid, reviews, price) VALUES (?, 6000, ?, ?)", (TODAY - back, reviews, price))
    # The coming-soon game has a demo: 250 players at most, 80 reviews.
    s.db.execute("UPDATE apps SET demos = '[7001]' WHERE appid = 7000")
    s.db.execute("INSERT INTO demos (appid, parent, reviews, positive_pct, players_max, players_at) VALUES (7001, 7000, 80, 90, 250, ?)", (int(NOW),))
    s.db.execute("INSERT INTO demo_daily (day, appid, players_peak) VALUES (?, 7001, 180)", (TODAY - 2,))
    s.db.commit()
    s.close()


def test_build(tmp_path, rng):
    db_path, out = tmp_path / "steam.db", tmp_path / "market"
    make_steam(str(db_path), rng)
    result = market.build(str(db_path), str(out), now=NOW, post=False, fetch=False)

    overview = read(out, "overview")
    assert overview["games"] == 204 and overview["comingSoon"] == 1 and overview["godot"] == 2
    assert overview["historyDays"] == 8 and overview["tags"][str(COZY)] == "Cozy"

    games = read(out, "games")
    rows = {r[0]: dict(zip(games["columns"], r)) for r in games["rows"]}
    assert 7000 not in rows, "coming soon isn't released yet"
    breakout = rows[5000]
    assert breakout["hit"] >= 95 and breakout["gain7"] == 1000 and breakout["tags"] == [COZY, INDIE]
    assert breakout["price"] == 1499 and breakout["flags"] & games["flags"]["linux"]
    assert rows[6000]["flags"] & games["flags"]["godot"]

    trends = read(out, "trends")
    cozy = next(t for t in trends["tags"] if t["tag"] == COZY)
    shooter = next(t for t in trends["tags"] if t["tag"] == SHOOTER)
    assert cozy["supply"] > 1 > shooter["supply"]
    assert cozy["heat"] > shooter["heat"]
    assert {"hitRateRaw", "hitGames", "hits", "topReviews", "medianRevenue", "reviewHitRate"} <= set(cozy)
    # Hits are paid games by estimated revenue: the free shooters' many reviews earn nothing.
    assert trends["hitBasis"] == "revenue" and shooter["freeGames"] == 20 and shooter["hits"] == 0
    assert shooter["reviewHitRate"] > shooter["hitRate"], "by reviews the free shooters look like hits"
    assert cozy["hitGames"] == 30 and shooter["hitGames"] == 30, "free games aren't in the paid pool"
    assert cozy["medianRevenue"] > 20 * shooter["medianRevenue"]
    assert trends["revenueModel"]["netShare"] == market.NET_SHARE
    kinds = {a["kind"] for a in result["alerts"]}
    assert "breakout" in kinds and any(a.get("appid") == 5000 for a in result["alerts"])

    godot = {g["appid"]: g for g in read(out, "godot")["games"]}
    assert set(godot) == {6000, 7000}
    assert godot[6000]["devGames"] == 2 and godot[6000]["devGodotGames"] == 1 and godot[7000]["comingSoon"]
    # The studio's best other game on its own (6001, 40 reviews), not all its games together.
    assert godot[6000]["devBest"] == 40 and godot[6000]["devBestName"] == "Game 6001" and godot[6000]["devBestRev"] > 0
    assert godot[7000]["devBest"] == 120, "6000 beats 6001"
    # Realized price: most reviews came in at half price.
    assert 499 < godot[6000]["rprice"] < 999 * market.REALIZED_DEFAULT
    assert godot[6000]["rev"] > 0 and godot[6000]["langList"] is None
    assert (godot[7000]["demoPlayers"], godot[7000]["demoPeak"], godot[7000]["demoReviews"], godot[7000]["demoPos"]) == (250, 180, 80, 90)
    assert godot[6000]["signals"][0]["source"] == "store_legal"

    assert not rows[6000]["flags"] & games["flags"]["self"], "published by Pub"

    upcoming = read(out, "upcoming")
    up = {r[0]: dict(zip(upcoming["columns"], r)) for r in upcoming["rows"]}
    assert set(up) == {7000} and up[7000]["devGames"] == 2 and up[7000]["devBest"] == 120
    assert up[7000]["devBestRev"] == godot[6000]["rev"] and up[7000]["demoPlayers"] == 250

    growth = read(out, "growth")
    assert sum(growth["total"]["y"]) == 203
    assert sum(growth["total"]["q"]["100"]) == sum(1 for r in games["rows"] if r[4] >= 100)
    ai = growth["ai"]
    assert sum(ai["mRead"]) == 11 and sum(ai["m"]) == 3 and sum(ai["mqRead"]) == 1 and sum(ai["mq"]) == 1
    assert ai["minReviews"] == 10 and len(ai["m"]) == len(growth["months"])
    assert rows[5000]["flags"] & games["flags"]["ai"] and not rows[6000]["flags"] & games["flags"]["ai"]
    assert growth["tags"][str(COZY)]["name"] == "Cozy" and sum(growth["tags"][str(COZY)]["y"]) == 10 + 30 + 1
    free_row = rows[3000]
    assert free_row["rev"] is None and free_row["earn"] is None and free_row["hit"] is not None
    assert rows[1002]["earn"] is not None and rows[1002]["rev"] > 0


def test_alerts_once_and_not_on_the_first_run(tmp_path, rng, monkeypatch):
    db_path, out = tmp_path / "steam.db", tmp_path / "market"
    make_steam(str(db_path), rng)
    posted = []
    monkeypatch.setattr(market, "post_discord", lambda hook, alerts: posted.append(list(alerts)))
    first = market.build(str(db_path), str(out), now=NOW, webhook="https://example.invalid/hook", fetch=False)
    assert first["alerts"] and first["fresh"] == [], "the first run only learns what's there"
    # Forget one alert: it's new on the next run, and only it is posted.
    state_path = out / "alerts-state.json"
    state = json.loads(state_path.read_text())
    del state["game:5000"]
    state_path.write_text(json.dumps(state))
    second = market.build(str(db_path), str(out), now=NOW + 3600, webhook="https://example.invalid/hook", fetch=False)
    assert [a["key"] for a in second["fresh"]] == ["game:5000"]
    assert [a["key"] for a in posted[-1]] == ["game:5000"]
    third = market.build(str(db_path), str(out), now=NOW + 7200, webhook="https://example.invalid/hook", fetch=False)
    assert third["fresh"] == []


def test_hit_index_compares_games_of_the_same_age():
    old = [market.Game(appid=i, release_day=100, coming_soon=False, reviews=i) for i in range(100)]
    new = [market.Game(appid=1000 + i, release_day=900, coming_soon=False, reviews=i // 10) for i in range(100)]
    market.add_hit_index(old + new, 1000)
    assert old[99].hit == 99 and old[0].hit == 0
    # 9 reviews tops the new fortnight even though it's few next to the old games.
    assert new[99].hit >= 90


def test_small_tags_are_pulled_toward_steams_hit_rate():
    """4 hits in 16 games isn't a 25% hit rate yet: it's pulled toward Steam's, more than 40 in 160 is."""
    def tag_rows(n, hits):
        gs = [market.Game(appid=i, release_day=900, coming_soon=False, reviews=0, tags=(1 if i < n else 2,),
                          earn=95 if i < hits or n <= i < n + 10 else 10) for i in range(n + 100)]
        return {t["tag"]: t for t in market.trends(gs, {}, 960, None, {})["tags"]}
    small, big = tag_rows(16, 4)[1], tag_rows(160, 40)[1]
    assert small["hitRateRaw"] == big["hitRateRaw"] == 0.25
    assert small["hitRate"] < big["hitRate"] < 0.25


def test_revenue_estimate():
    """Sales per review by year and price, realized price pulled toward the default, lifetime by age."""
    assert market.sales_per_review(1500, 2025) == 30 and market.sales_per_review(1500, 2012) == 60
    assert market.sales_per_review(299, 2025) > market.sales_per_review(1500, 2025) > market.sales_per_review(5999, 2025)
    assert market.realized_price(1000, None) == 1000 * market.REALIZED_DEFAULT
    assert market.realized_price(1000, (500.0, 10_000)) == pytest.approx(500, abs=5)
    assert market.lifetime_share(1) == market.LIFETIME_SHARE[0][1] and market.lifetime_share(5000) == 1.0
    assert market.lifetime_share(30) < market.lifetime_share(100) < market.lifetime_share(365)
    today = cadence.day_number(NOW)
    young_now, young_life = market.est_revenue(100, 1500, 1000, today - 30, today)
    old_now, old_life = market.est_revenue(100, 1500, 1000, today - 2000, today)
    assert young_now == pytest.approx(100 * 30 * 10 * market.NET_SHARE)
    assert young_life > 3 * young_now and old_life < 1.1 * old_now, "a month-old game has most sales ahead"


def test_demand_counts_players_and_never_releases():
    """Demand: each tag's share of new reviews and of players, now against the window before. A tag
    that only releases more games doesn't gain demand."""
    def g(appid, tag, before, now, p_before, p_now, day=950):
        return market.Game(appid=appid, release_day=day, coming_soon=False, reviews=now, tags=(tag,),
                           players_now=p_now, players_before=p_before)
    games = [g(i, 1, 100, 200, 50, 150) for i in range(20)] + [g(100 + i, 2, 100, 200, 100, 100) for i in range(20)]
    # Tag 2 also has 30 brand-new games with many reviews: new in the window, they don't count.
    games += [g(200 + i, 2, 0, 500, 0, 300, day=995) for i in range(30)]
    past = {7: {x.appid: x.reviews - (x.reviews - 100 if x.appid < 200 else 0) for x in games if x.appid < 200},
            14: {x.appid: 0 for x in games if x.appid < 200}}
    for x in games:
        if x.appid >= 200:
            x.players_before = None
    rows = {t["tag"]: t for t in market.trends(games, {}, 1000, 900, past)["tags"]}
    assert rows[1]["demandReviews"] == pytest.approx(1.0)
    assert rows[1]["demandPlayers"] > 1 > rows[2]["demandPlayers"]
    assert rows[1]["demand"] > rows[2]["demand"]


def test_a_game_out_of_early_access_counts_from_its_first_release():
    assert market.first_release(2000 * 86400, 1500 * 86400) == 1500
    assert market.first_release(2000 * 86400, None) == 2000
    assert market.first_release(None, None) is None


def test_read_only(tmp_path, rng):
    """The builder never writes to steam.db (the collector owns it)."""
    db_path = tmp_path / "steam.db"
    make_steam(str(db_path), rng)
    before = db_path.stat().st_mtime_ns
    market.build(str(db_path), str(tmp_path / "market"), now=NOW, post=False, fetch=False)
    assert db_path.stat().st_mtime_ns == before


def test_steam_users_from_records_and_the_feed(tmp_path, monkeypatch):
    """Records until the server measures; a measured day wins only where it's higher; days the feed
    covers only in part aren't kept."""
    import io
    day = cadence.day_number(NOW)
    start = day * DAY - DAY  # yesterday 00:00, five-minute steps up to now
    points = [[(start + i * 300) * 1000, 30_000_000 + i] for i in range(int((NOW - start) // 300))]
    feed = json.dumps([{"label": "Steam users logged in", "data": points}]).encode()
    monkeypatch.setattr(market.urllib.request, "urlopen", lambda *a, **k: io.BytesIO(feed))
    measured = market.fetch_users(str(tmp_path / "users.json"), int(NOW))
    assert list(measured) == [day - 1], "today isn't over, so only yesterday is kept"
    assert json.loads((tmp_path / "users.json").read_text()) == {str(day - 1): measured[day - 1]}

    years = [2017, 2019, 2026]
    end = lambda y: market.calendar.timegm((y + 1, 1, 1, 0, 0, 0)) // DAY - 1
    of = lambda d: market.time.gmtime(d * DAY).tm_year
    values, kinds = market.users_by(years, of, end, measured)
    assert values[:2] == [15_000_000, 18_537_490] and kinds[:2] == ["record", "record"]
    assert values[2] == 41_816_052 and kinds[2] == "record", "the January record is higher than this day"
    values, kinds = market.users_by([2026], of, end, {day - 1: 50_000_000})
    assert (values, kinds) == ([50_000_000], ["measured"])
