"""The market files (market.py): a small made-up Steam, built and read back."""

import gzip
import json

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
    for i in range(60):  # lately: half cozy, and the cozy ones get more reviews
        cozy = i % 2 == 0
        game(appid := appid + 1, 30 + i, 400 + i if cozy else 5 + i % 7, (COZY, PIXEL, INDIE) if cozy else (SHOOTER, INDIE))
    for i in range(60):  # this fortnight: small releases, the breakout's peers
        game(2000 + i, i % 10, i % 4, (SHOOTER, INDIE))
    game(5000, 5, 3000, (COZY, INDIE), price=1499)  # the breakout
    game(6000, 200, 120, (PIXEL, INDIE), devs=("Godot Studio",))
    game(7000, -60, 0, (COZY,), price=None, coming_soon=True, devs=("Godot Studio",))
    s.save_list_apps(apps, NOW, full=True)
    s.save_snapshot(snaps, NOW, rng)
    s.save_tags([(COZY, "Cozy"), (SHOOTER, "Shooter"), (INDIE, "Indie"), (PIXEL, "Pixel Graphics")])
    with s.transaction():
        for a in (6000, 7000):
            s._upsert_signal(a, Signal("godot", "store_legal", 2, "Godot Engine"), int(NOW))
    s.refresh_godot(None, NOW)
    # A week of history: the breakout gained 1,000 reviews this week.
    s.db.execute("INSERT INTO app_daily (day, appid, reviews) VALUES (?, 5000, 2000)", (TODAY - 7,))
    s.db.commit()
    s.close()


def test_build(tmp_path, rng):
    db_path, out = tmp_path / "steam.db", tmp_path / "market"
    make_steam(str(db_path), rng)
    result = market.build(str(db_path), str(out), now=NOW, post=False, fetch=False)

    overview = read(out, "overview")
    assert overview["games"] == 183 and overview["comingSoon"] == 1 and overview["godot"] == 2
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
    kinds = {a["kind"] for a in result["alerts"]}
    assert "breakout" in kinds and any(a.get("appid") == 5000 for a in result["alerts"])

    godot = {g["appid"]: g for g in read(out, "godot")["games"]}
    assert set(godot) == {6000, 7000}
    assert godot[6000]["devGames"] == 1 and godot[6000]["devGodotGames"] == 1 and godot[7000]["comingSoon"]
    assert godot[6000]["signals"][0]["source"] == "store_legal"

    growth = read(out, "growth")
    assert sum(growth["total"]["y"]) == 182
    assert growth["tags"][str(COZY)]["name"] == "Cozy" and sum(growth["tags"][str(COZY)]["y"]) == 10 + 30 + 1


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
