"""The market numbers: what the dashboard's Market section shows, worked out from steam.db once a day.

  python -m steamdata.market            builds the files (steamdata-market.timer, daily)
  python -m steamdata.market --no-post  builds them without posting alerts to Discord

It only reads steam.db (a read-only connection; the collector keeps running) and writes a few gzipped
JSON files to MARKET_DIR, which the game-data server hands to the signed-in owner
(GET /v1/admin/market/<name>, see server/gamedata/admin.py). Nothing here is public.

- growth.json: Steam's releases per year and per month, and each user tag's releases and the reviews
  they earned, for "how Steam grows and how each genre grows next to it".
- games.json: every game released in the last RECENT_DAYS, one compact row each, with its hit index.
  The dashboard's gap finder, hit list and goal search all work on this in the browser.
- godot.json: every game in the Godot set (released or not), with everything the Godot finder and the
  leads list score on.
- upcoming.json: games coming soon with a date in the next UPCOMING_DAYS (or a demo out), one compact
  row each with the studio's track record, for scouting before release.
- trends.json: each tag's momentum (supply, hits, reviews), and the alerts.
- overview.json: when it was built, how much history there is, the counts.

A game "is" a tag when the tag is in its first TOP_TAGS user tags (the strongest ones); further down
the list tags are too weak to say what a game is.

The hit index: a game's review count as a percentile among the games released within HIT_WINDOW days
of it (all of them, with or without reviews), so it compares games of the same age. 99 means it has
more reviews than 99% of the games released the same fortnight.

Alerts (trends.json and, when MARKET_DISCORD_WEBHOOK is set, a Discord post): a tag heating up,
a breakout release, a Godot game taking off. Each is posted once (a tag again after ALERT_REPEAT_DAYS),
remembered in alerts-state.json next to the files.
"""

from __future__ import annotations

import argparse
import bisect
import calendar
import gzip
import json
import logging
import math
import os
import sqlite3
import statistics
import sys
import time
import urllib.request
from collections import defaultdict
from typing import Any, Iterable

from . import cadence
from .config import DEFAULT_DB_PATH, USER_AGENT

log = logging.getLogger("steamdata.market")

DEFAULT_MARKET_DIR = "/srv/fourgames/steamdata/market"
DAY = 86400
RECENT_DAYS = 3 * 365       # games.json: released in the last three years
TOP_TAGS = 5                # a game "is" its first five tags
ROW_TAGS = 10               # games.json keeps the first ten (the gap finder can go wider)
HIT_WINDOW = 7              # hit index peers: released within a week either side
MONTHS = 72                 # growth.json: the last six years month by month
SUPPLY_WINDOW = 90          # trends: releases in the last 90 days vs the same 90 days a year earlier
HIT_RATE_WINDOW = (14, 180) # trends: games released 14-180 days ago, for the hit rate
MIN_TAG_GAMES = 15          # a tag needs this many recent releases to have a trend at all
PRIOR_GAMES = 30            # hit rates are pulled toward Steam's by this many made-up average games,
                            # so a tag with 16 games and 4 hits doesn't look like a sure thing
UPCOMING_DAYS = 540         # upcoming.json: planned within the next year and a half
TAG_ALERTS = 8              # at most this many "heating up" alerts a day, the hottest
ALERT_REPEAT_DAYS = 30
INDIE = 492  # the Indie user tag

# Steam's users logged in at once: its all-time record as reported at the time (Valve's own number,
# quoted in the press; SteamDB's charts can't be used, its terms forbid scraping). The years before
# the server started measuring use the record as of each year's end. From then on the daily job keeps
# each day's peak from Steam's own stats feed (USERS_FEED, the last 48 hours) in steam-users.json.
USER_RECORDS = [
    ("2014-06-29", 8_000_000, "https://80.lv/articles/steam-2015-record"),
    ("2015-01-01", 8_466_441, "https://80.lv/articles/steam-2015-record"),
    ("2016-01-03", 12_332_504, "https://gameranx.com/updates/id/32454/article/steam-breaks-new-record-with-over-12-million-concurrent-users/"),
    ("2017-01-08", 14_370_167, "https://pcgamer.com/steam-passes-14-million-concurrent-users-for-first-time-ever"),
    ("2017-09-17", 15_000_000, "https://www.ubergizmo.com/2017/09/steam-hits-15-million-concurrent-users"),
    ("2018-01-06", 18_537_490, "https://www.gamespot.com/articles/steam-hits-concurrent-user-record/1100-6473305/"),
    ("2020-03-14", 20_313_451, "https://www.gamespot.com/articles/steam-hits-concurrent-user-record/1100-6473305/"),
    ("2021-01-02", 25_000_000, "https://www.pcgamer.com/uk/steam-cracks-25m-concurrent-users-as-the-new-year-begins/"),
    ("2021-04-04", 26_900_000, "https://gamesradar.com/au/almost-265-million-of-us-were-on-steam-at-the-same-time-today"),
    ("2022-01-09", 28_230_853, "https://pcgamer.com/steam-smashes-28-million-concurrent-usersnearly-3-million-more-than-last-year"),
    ("2023-01-08", 33_000_000, "https://www.theverge.com/2023/1/9/23546139/steam-10-million-concurrent-players-record-breaking-valve-gaming"),
    ("2024-01-07", 33_600_000, "https://pcgamer.com/software/steam-has-just-beaten-its-concurrent-players-record-once-again-with-a-whopping-39-2-million-at-one-time"),
    ("2024-12-01", 39_200_000, "https://pcgamer.com/software/steam-has-just-beaten-its-concurrent-players-record-once-again-with-a-whopping-39-2-million-at-one-time"),
    ("2025-10-12", 41_666_455, "https://consolepcgaming.com/steam-hits-41-8-million-concurrent-players-and-sets-a-new-all-time-record"),
    ("2026-01-05", 41_816_052, "https://consolepcgaming.com/steam-hits-41-8-million-concurrent-players-and-sets-a-new-all-time-record"),
]
USERS_FEED = "https://store.steampowered.com/stats/userdata.json"


def record_day(date: str) -> int:
    return calendar.timegm(time.strptime(date, "%Y-%m-%d")) // DAY


def fetch_users(state_path: str, now: int) -> dict[int, int]:
    """Steam's users logged in, the peak of each UTC day the feed covers in full (it holds the last
    48 hours, so yesterday always is). Kept in steam-users.json: it can't be fetched again later."""
    try:
        with open(state_path) as f:
            days = {int(k): v for k, v in json.load(f).items()}
    except (OSError, ValueError):
        days = {}
    try:
        request = urllib.request.Request(USERS_FEED, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=30) as r:
            series = json.load(r)
        points = [(int(t) // 1000, int(v)) for s in series if "logged in" in str(s.get("label", "")).lower()
                  for t, v in s.get("data", [])]
    except Exception as error:  # one missed day isn't worth failing the build for
        log.warning("Steam's user count couldn't be read: %s", error)
        points = []
    if points:
        first, last = min(t for t, _ in points), max(t for t, _ in points)
        peaks: dict[int, int] = {}
        for t, v in points:
            d = t // DAY
            peaks[d] = max(peaks.get(d, 0), v)
        for d, v in peaks.items():
            # Only days the feed covers from start to end (within its 5-minute steps).
            if first <= d * DAY + 600 and last >= (d + 1) * DAY - 600:
                days[d] = max(days.get(d, 0), v)
        write_json(state_path, {str(k): v for k, v in sorted(days.items())}, gz=False)
    return days


def users_by(periods: list[int], period_of, end_of, measured: dict[int, int]) -> tuple[list, list]:
    """For each period: Steam's all-time record as of its end, or the highest daily peak measured in
    it when that's higher. Returns the values and where each came from ("measured", "record" or None)."""
    by_period: dict[int, int] = {}
    for d, v in measured.items():
        p = period_of(d)
        by_period[p] = max(by_period.get(p, 0), v)
    values, kinds = [], []
    for p in periods:
        end = end_of(p)
        record = max((v for date, v, _ in USER_RECORDS if record_day(date) <= end), default=None)
        mine = by_period.get(p)
        if mine is not None and (record is None or mine >= record):
            values.append(mine); kinds.append("measured")
        else:
            values.append(record); kinds.append("record" if record is not None else None)
    return values, kinds


# Flags in a games.json row (a bit field, so the rows stay small).
# F_SELF: self-published (no publisher besides the developers).
F_LINUX, F_MAC, F_DECK_OK, F_DECK_VERIFIED, F_EARLY, F_FREE, F_GODOT, F_DEMO, F_SELF = (1 << i for i in range(9))


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

class Game:
    """One game, the parts the market files use. Slots, not a dict per game: 200,000 of them."""

    __slots__ = ("appid", "name", "release_day", "coming_soon", "early_access", "is_free", "reviews",
                 "positive_pct",
                 "price",          # the full price (before any discount), cents
                 "tags", "genres",
                 "languages",      # how many languages (None: metadata not fetched yet)
                 "full_audio", "linux", "mac", "deck", "godot", "developers", "publishers", "players_max",
                 "achievements", "controller", "demos", "dlc_count", "metacritic", "details",
                 "release_display", "hit", "gain7", "gain28")

    def __init__(self, **values: Any):
        for name in self.__slots__:
            setattr(self, name, values.get(name))


def _json_list(text: str | None) -> list:
    if not text:
        return []
    try:
        value = json.loads(text)
    except ValueError:
        return []
    return value if isinstance(value, list) else []


def _languages(text: str | None) -> tuple[int | None, int | None]:
    if text is None:
        return None, None
    names = [n.strip() for n in text.split(",") if n.strip()]
    return len(names), sum(1 for n in names if n.endswith("*"))


def connect(db_path: str) -> sqlite3.Connection:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    return db


def read_games(db: sqlite3.Connection) -> list[Game]:
    games = []
    ids: dict[int, int] = {}  # one int object per tag id, not one per game (millions of them)
    for r in db.execute("""SELECT appid, name, release_ts, coming_soon, early_access, is_free, reviews,
                                  positive_pct, price, price_original, tags, genres, languages, linux, mac,
                                  deck, godot, developers, publishers, players_max, achievements,
                                  controller_support, demos, dlc_count, metacritic, details_at,
                                  release_display
                           FROM apps WHERE type = 'game' AND snapshot_at IS NOT NULL
                             AND COALESCE(visible, 1) = 1"""):
        langs, audio = _languages(r["languages"])
        full_price = r["price_original"] if r["price_original"] is not None else r["price"]
        games.append(Game(
            appid=r["appid"], name=r["name"] or f"App {r['appid']}",
            release_day=r["release_ts"] // DAY if r["release_ts"] else None,
            coming_soon=bool(r["coming_soon"]), early_access=bool(r["early_access"]),
            is_free=bool(r["is_free"]), reviews=r["reviews"] or 0, positive_pct=r["positive_pct"],
            price=full_price, tags=tuple(ids.setdefault(t, t) for t in _json_list(r["tags"])[:ROW_TAGS] if isinstance(t, int)),
            genres=tuple(g for g in _json_list(r["genres"]) if isinstance(g, int)),
            languages=langs, full_audio=audio, linux=bool(r["linux"]), mac=bool(r["mac"]),
            deck=r["deck"], godot=bool(r["godot"]),
            developers=tuple(sys.intern(d) for d in _json_list(r["developers"]) if isinstance(d, str)),
            publishers=tuple(sys.intern(p) for p in _json_list(r["publishers"]) if isinstance(p, str)),
            players_max=r["players_max"], achievements=r["achievements"],
            controller=r["controller_support"], demos=len(_json_list(r["demos"])) if r["demos"] else (0 if r["details_at"] else None),
            dlc_count=r["dlc_count"], metacritic=r["metacritic"], details=bool(r["details_at"]),
            release_display=r["release_display"]))
    return games


def names(db: sqlite3.Connection, table: str, key: str = "tagid") -> dict[int, str]:
    try:
        return {r[0]: r[1] for r in db.execute(f"SELECT {key}, name FROM {table}")}
    except sqlite3.OperationalError:
        return {}


def history_days(db: sqlite3.Connection) -> tuple[int | None, int | None]:
    row = db.execute("SELECT MIN(day), MAX(day) FROM app_daily").fetchone()
    return (row[0], row[1]) if row and row[0] is not None else (None, None)


def reviews_on(db: sqlite3.Connection, day: int) -> dict[int, int]:
    return {r[0]: r[1] for r in db.execute("SELECT appid, reviews FROM app_daily WHERE day = ? AND reviews IS NOT NULL", (day,))}


def add_gains(db: sqlite3.Connection, games: list[Game], today: int, first: int) -> dict[int, dict[int, int]]:
    """Reviews gained in the last 7 and 28 days, where the history reaches back that far. Returns
    the review counts of the days read, for the trend windows."""
    days = {}
    for back in (7, 14, 28, 56):
        if today - back >= first:
            days[back] = reviews_on(db, today - back)
    for g in games:
        for back, attr in ((7, "gain7"), (28, "gain28")):
            if back in days and g.appid in days[back]:
                setattr(g, attr, max(0, g.reviews - days[back][g.appid]))
    return days


# ---------------------------------------------------------------------------
# Working out
# ---------------------------------------------------------------------------

def add_hit_index(games: list[Game], today: int) -> None:
    """Each released game's review count as a percentile among the games released within
    HIT_WINDOW days of it."""
    released = sorted((g for g in games if g.release_day is not None and not g.coming_soon and g.release_day <= today),
                      key=lambda g: g.release_day)
    # Review counts sorted per release day, so each window is a merge of a few small lists.
    by_day: dict[int, list[int]] = defaultdict(list)
    released_on: dict[int, list[Game]] = defaultdict(list)
    for g in released:
        by_day[g.release_day].append(g.reviews)
        released_on[g.release_day].append(g)
    for v in by_day.values():
        v.sort()
    # One release day at a time: its peers, then each of its games' place among them.
    for d, todays in by_day.items():
        peers = sorted(x for dd in range(d - HIT_WINDOW, d + HIT_WINDOW + 1) for x in by_day.get(dd, ()))
        if len(peers) < 20:
            continue
        for g in released_on[d]:
            below = bisect.bisect_left(peers, g.reviews)
            same = bisect.bisect_right(peers, g.reviews) - below
            g.hit = min(100, int(100 * (below + same / 2) / len(peers)))


def month_index(day: int) -> int:
    t = time.gmtime(day * DAY)
    return t.tm_year * 12 + t.tm_mon - 1


def month_label(index: int) -> str:
    return f"{index // 12}-{index % 12 + 1:02d}"


def growth(games: list[Game], tag_names: dict[int, str], genre_names: dict[int, str], today: int,
           measured: dict[int, int] | None = None) -> dict[str, Any]:
    released = [g for g in games if g.release_day is not None and not g.coming_soon and g.release_day <= today]
    this_year = time.gmtime(today * DAY).tm_year
    first_year = 2006  # Steam's third-party games start here; earlier is a handful of Valve's
    years = list(range(first_year, this_year + 1))
    this_month = month_index(today)
    months = list(range(this_month - MONTHS + 1, this_month + 1))

    def series():
        return {"y": [0] * len(years), "yr": [0] * len(years), "m": [0] * len(months), "mr": [0] * len(months)}

    total = series()
    per_tag: dict[int, dict] = defaultdict(series)
    per_genre: dict[int, dict] = defaultdict(series)
    for g in released:
        y = time.gmtime(g.release_day * DAY).tm_year
        m = month_index(g.release_day)
        yi = y - first_year if y >= first_year else None
        mi = m - months[0] if m >= months[0] else None
        targets = [total] + [per_tag[t] for t in g.tags[:TOP_TAGS]] + [per_genre[x] for x in g.genres]
        for s in targets:
            if yi is not None:
                s["y"][yi] += 1
                s["yr"][yi] += g.reviews
            if mi is not None:
                s["m"][mi] += 1
                s["mr"][mi] += g.reviews
    # How far into this year (and month) we are, so the dashboard can show a full-year pace.
    start_of_year = calendar.timegm((this_year, 1, 1, 0, 0, 0)) // DAY
    year_end = lambda y: calendar.timegm((y + 1, 1, 1, 0, 0, 0)) // DAY - 1
    month_end = lambda m: calendar.timegm(((m + 1) // 12, (m + 1) % 12 + 1, 1, 0, 0, 0)) // DAY - 1
    users_y, users_y_kind = users_by(years, lambda d: time.gmtime(d * DAY).tm_year, year_end, measured or {})
    users_m, users_m_kind = users_by(months, month_index, month_end, measured or {})
    return {
        "years": years, "months": [month_label(m) for m in months],
        "yearDone": round((today - start_of_year + 1) / 365, 3),
        "monthDone": round(time.gmtime(today * DAY).tm_mday / 30.4, 3),
        "total": total,
        # Steam's users logged in at once: per period, the measured peak or the all-time record by its end.
        "users": {"y": users_y, "yKind": users_y_kind, "m": users_m, "mKind": users_m_kind,
                  "records": [{"date": d, "users": v, "source": src} for d, v, src in USER_RECORDS]},
        "tags": {str(t): {"name": tag_names.get(t, f"Tag {t}"), **s} for t, s in per_tag.items() if sum(s["y"]) >= 20},
        "genres": {str(x): {"name": genre_names.get(x, f"Genre {x}"), **s} for x, s in per_genre.items() if sum(s["y"]) >= 20},
        "note": f"A game counts for its first {TOP_TAGS} user tags. Reviews are each year's releases' review counts today.",
    }


def flags(g: Game) -> int:
    f = 0
    if g.linux: f |= F_LINUX
    if g.mac: f |= F_MAC
    if g.deck in (2, 3): f |= F_DECK_OK
    if g.deck == 3: f |= F_DECK_VERIFIED
    if g.early_access: f |= F_EARLY
    if g.is_free: f |= F_FREE
    if g.godot: f |= F_GODOT
    if g.demos: f |= F_DEMO
    if self_published(g): f |= F_SELF
    return f


def self_published(g: Game) -> bool:
    return not g.publishers or set(g.publishers) <= set(g.developers)


GAME_COLUMNS = ["appid", "name", "day", "price", "reviews", "pos", "tags", "flags", "langs", "hit", "gain7", "gain28", "players"]


def recent_rows(games: list[Game], today: int) -> dict[str, Any]:
    rows = []
    for g in games:
        if g.release_day is None or g.coming_soon or not today - RECENT_DAYS <= g.release_day <= today:
            continue
        rows.append([g.appid, g.name, g.release_day, g.price, g.reviews, g.positive_pct, list(g.tags[:ROW_TAGS]),
                     flags(g), g.languages, g.hit, g.gain7, g.gain28, g.players_max])
    rows.sort(key=lambda r: -r[2])
    return {"columns": GAME_COLUMNS, "rows": rows, "topTags": TOP_TAGS,
            "flags": {"linux": F_LINUX, "mac": F_MAC, "deckOk": F_DECK_OK, "deckVerified": F_DECK_VERIFIED,
                      "earlyAccess": F_EARLY, "free": F_FREE, "godot": F_GODOT, "demo": F_DEMO, "self": F_SELF}}


def godot_rows(db: sqlite3.Connection, games: list[Game]) -> list[dict[str, Any]]:
    signals: dict[int, list[dict]] = defaultdict(list)
    for r in db.execute("SELECT appid, source, strength, evidence FROM engine_signals WHERE engine = 'godot' ORDER BY strength DESC"):
        signals[r["appid"]].append({"source": r["source"], "strength": r["strength"], "evidence": (r["evidence"] or "")[:160]})
    about = {r[0]: r[1] or "" for r in db.execute("SELECT appid, short_description FROM apps WHERE godot = 1")}
    # Each developer's other games: a studio's track record (and whether it self-publishes).
    by_dev, by_pub = studios(games)
    out = []
    for g in games:
        if not g.godot:
            continue
        others = {o.appid: o for d in g.developers for o in by_dev.get(d, ()) if o.appid != g.appid}
        out.append({
            "appid": g.appid, "name": g.name, "day": g.release_day, "comingSoon": g.coming_soon,
            "releaseDisplay": g.release_display, "earlyAccess": g.early_access, "free": g.is_free,
            "price": g.price, "reviews": g.reviews, "pos": g.positive_pct, "hit": g.hit,
            "gain7": g.gain7, "gain28": g.gain28, "players": g.players_max,
            "tags": list(g.tags[:ROW_TAGS]), "genres": list(g.genres), "languages": g.languages, "fullAudio": g.full_audio,
            "linux": g.linux, "mac": g.mac, "deck": g.deck, "achievements": g.achievements,
            "controller": g.controller, "demos": g.demos, "dlc": g.dlc_count, "metacritic": g.metacritic,
            "details": g.details, "developers": list(g.developers), "publishers": list(g.publishers),
            "selfPublished": self_published(g),
            # The biggest outside publisher's catalog size: 1-2 is a friend's label, 50 a real publisher.
            "publisherGames": max((len(by_pub.get(p, ())) for p in g.publishers if p not in g.developers), default=0),
            "devGames": len(others), "devReviews": sum(o.reviews for o in others.values()),
            "devGodotGames": sum(1 for o in others.values() if o.godot),
            "about": about.get(g.appid, "")[:300], "signals": signals.get(g.appid, [])[:3],
        })
    out.sort(key=lambda r: -(r["reviews"] or 0))
    return out


def studios(games: list[Game]) -> tuple[dict[str, list[Game]], dict[str, list[Game]]]:
    by_dev: dict[str, list[Game]] = defaultdict(list)
    by_pub: dict[str, list[Game]] = defaultdict(list)
    for g in games:
        for d in g.developers:
            by_dev[d].append(g)
        for p in g.publishers:
            by_pub[p].append(g)
    return by_dev, by_pub


UPCOMING_COLUMNS = ["appid", "name", "day", "display", "price", "tags", "flags", "langs", "devs", "pubs",
                    "devGames", "devBest", "devReviews", "pubGames", "players"]


def upcoming_rows(games: list[Game], today: int) -> dict[str, Any]:
    """Coming soon with a date from a month ago (late, still coming) to UPCOMING_DAYS ahead, or with a
    demo out: the rest are mostly pages nobody works on. devBest: the studio's best released game's
    reviews; pubGames: the biggest outside publisher's catalog (0 when self-published)."""
    by_dev, by_pub = studios(games)
    rows = []
    for g in games:
        if not g.coming_soon:
            continue
        dated = g.release_day is not None and today - 30 <= g.release_day <= today + UPCOMING_DAYS
        if not dated and not g.demos:
            continue
        others = {o.appid: o for d in g.developers for o in by_dev.get(d, ()) if o.appid != g.appid and not o.coming_soon}
        rows.append([g.appid, g.name, g.release_day, g.release_display, g.price, list(g.tags[:ROW_TAGS]), flags(g),
                     g.languages, list(g.developers)[:3], list(g.publishers)[:3], len(others),
                     max((o.reviews for o in others.values()), default=0), sum(o.reviews for o in others.values()),
                     max((len(by_pub.get(p, ())) for p in g.publishers if p not in g.developers), default=0),
                     g.players_max])
    rows.sort(key=lambda r: (r[2] is None, r[2] or 0))
    return {"columns": UPCOMING_COLUMNS, "rows": rows}


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def trends(games: list[Game], tag_names: dict[int, str], today: int, first: int | None,
           past: dict[int, dict[int, int]]) -> dict[str, Any]:
    released = [g for g in games if g.release_day is not None and not g.coming_soon and g.release_day <= today]
    w = SUPPLY_WINDOW
    now_set = [g for g in released if today - w < g.release_day <= today]
    year_ago = [g for g in released if today - 365 - w < g.release_day <= today - 365]
    hit_set = [g for g in released if today - HIT_RATE_WINDOW[1] <= g.release_day <= today - HIT_RATE_WINDOW[0] and g.hit is not None]

    # Reviews gained per tag: the latest window against the one before it, when the history has both.
    window = 28 if 56 in past else 7 if 14 in past else None
    gains_now: dict[int, int] = defaultdict(int)
    gains_before: dict[int, int] = defaultdict(int)
    total_now = total_before = 0
    if window:
        a, b = past[window], past[2 * window]
        for g in released:
            if g.appid not in a:
                continue
            now_gain = max(0, g.reviews - a[g.appid])
            before_gain = max(0, a[g.appid] - b[g.appid]) if g.appid in b else None
            if before_gain is None:
                continue  # new in the window: it would only ever count as growth
            total_now += now_gain
            total_before += before_gain
            for t in g.tags[:TOP_TAGS]:
                gains_now[t] += now_gain
                gains_before[t] += before_gain

    def count(gs: Iterable[Game]) -> dict[int, int]:
        c: dict[int, int] = defaultdict(int)
        for g in gs:
            for t in g.tags[:TOP_TAGS]:
                c[t] += 1
        return c

    n_now, n_ago = count(now_set), count(year_ago)
    hits: dict[int, list[int]] = defaultdict(list)
    for g in hit_set:
        for t in g.tags[:TOP_TAGS]:
            hits[t].append(g.hit)
    base_hit_rate = sum(1 for g in hit_set if g.hit >= 90) / len(hit_set) if hit_set else 0.1

    rows = []
    for t, n in n_now.items():
        if n < MIN_TAG_GAMES:
            continue
        supply = None
        if year_ago:
            # +1 on both sides, so a tag that barely existed a year ago gets a big but finite number.
            supply = ((n + 1) / len(now_set)) / ((n_ago.get(t, 0) + 1) / len(year_ago))
        hs = hits.get(t, [])
        n_hits = sum(1 for x in hs if x >= 90)
        raw_rate = n_hits / len(hs) if len(hs) >= MIN_TAG_GAMES else None
        # The rate pulled toward Steam's (PRIOR_GAMES average games added): few games, little pull away.
        hit_rate = (n_hits + PRIOR_GAMES * base_hit_rate) / (len(hs) + PRIOR_GAMES) if raw_rate is not None else None
        hit_lift = hit_rate / base_hit_rate if hit_rate is not None and base_hit_rate else None
        demand = None
        if window and total_now and total_before and gains_before.get(t, 0) >= 20:
            demand = (gains_now[t] / total_now) / (gains_before[t] / total_before)
        parts = [x for x in (supply, hit_lift, demand) if x is not None]
        heat = math.exp(sum(math.log(max(x, 0.05)) for x in parts) / len(parts)) if parts else None
        rows.append({"tag": t, "name": tag_names.get(t, f"Tag {t}"), "releases": n, "releasesYearAgo": n_ago.get(t, 0),
                     "supply": _r(supply), "hitRate": _r(hit_rate), "hitRateRaw": _r(raw_rate), "hitGames": len(hs),
                     "hits": n_hits, "hitLift": _r(hit_lift), "demand": _r(demand),
                     "gainsNow": gains_now.get(t), "heat": _r(heat),
                     "medianReviews": _median([g.reviews for g in hit_set if t in g.tags[:TOP_TAGS]]),
                     # The 90th percentile: what a game in the top tenth of the tag got.
                     "topReviews": _quantile([g.reviews for g in hit_set if t in g.tags[:TOP_TAGS]], 0.9)})
    rows.sort(key=lambda r: -(r["heat"] or 0))
    return {"window": window, "supplyWindow": w, "hitRateWindow": list(HIT_RATE_WINDOW), "baseHitRate": _r(base_hit_rate),
            "priorGames": PRIOR_GAMES, "baseMedianReviews": _median([g.reviews for g in hit_set]),
            "releasesNow": len(now_set), "releasesYearAgo": len(year_ago), "tags": rows,
            "historyDays": (today - first + 1) if first is not None else 0}


def _quantile(values: list[int], q: float) -> int | None:
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, int(q * len(s)))]


def _r(x: float | None, digits: int = 3) -> float | None:
    return None if x is None else round(x, digits)


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------

def find_alerts(games: list[Game], trend: dict[str, Any], today: int) -> list[dict[str, Any]]:
    alerts = []
    tag_alerts = 0
    for t in trend["tags"]:  # hottest first
        if tag_alerts >= TAG_ALERTS:
            break
        heat = t["heat"] or 0
        signals = [x for x in (t["supply"], t["hitLift"], t["demand"]) if x is not None]
        if heat >= 2 and len(signals) >= 2 and t["releases"] >= 20 and (t["hitLift"] or 0) >= 1.5:
            why = []
            if t["supply"] is not None: why.append(f"releases ×{t['supply']:.1f} vs a year ago (share of Steam)")
            if t["hitLift"] is not None: why.append(f"hit rate ×{t['hitLift']:.1f} vs all new games")
            if t["demand"] is not None: why.append(f"share of new reviews ×{t['demand']:.1f} vs the window before")
            alerts.append({"key": f"tag:{t['tag']}", "kind": "tag", "tag": t["tag"], "title": f"{t['name']} is heating up",
                           "detail": "; ".join(why) + f". {t['releases']} releases in the last {trend['supplyWindow']} days.",
                           "score": heat})
            tag_alerts += 1
    for g in games:
        if g.release_day is None or g.coming_soon or g.hit is None:
            continue
        age = today - g.release_day
        fast = g.gain7 is not None and g.gain7 >= 100
        # Indie games only (the user tag), under $30: the big studios' launches aren't news for us.
        if 0 <= age <= 30 and g.hit >= 99 and (g.reviews >= 300 or fast) and INDIE in g.tags \
                and (g.price or 0) <= 3000:
            alerts.append({"key": f"game:{g.appid}", "kind": "breakout", "appid": g.appid,
                           "title": f"Breakout: {g.name}",
                           "detail": f"{g.reviews:,} reviews ({g.positive_pct or '?'}% positive) {age} days after release; hit index {g.hit}"
                                     + (f"; +{g.gain7:,} reviews this week" if g.gain7 else "") + ".",
                           "score": g.reviews})
        # Self-published only: a Godot hit that already has a publisher isn't ours to sign.
        if g.godot and self_published(g) and (g.hit >= 90 and age <= 90 and g.reviews >= 30 or (g.gain7 or 0) >= 30):
            alerts.append({"key": f"godot:{g.appid}", "kind": "godot", "appid": g.appid,
                           "title": f"Godot game taking off: {g.name}",
                           "detail": f"{g.reviews:,} reviews ({g.positive_pct or '?'}% positive), hit index {g.hit}"
                                     + (f", +{g.gain7:,} this week" if g.gain7 else "") + f"; by {', '.join(g.developers) or '?'}.",
                           "score": g.reviews})
    alerts.sort(key=lambda a: ({"tag": 0, "godot": 1, "breakout": 2}[a["kind"]], -a["score"]))
    return alerts


def remember_alerts(alerts: list[dict[str, Any]], state_path: str, now: int) -> list[dict[str, Any]]:
    """Marks each alert with when it was first seen; returns the ones that are new (or a tag's,
    again after ALERT_REPEAT_DAYS)."""
    try:
        with open(state_path) as f:
            seen = json.load(f)
        first_run = False
    except (OSError, ValueError):
        seen, first_run = {}, True
    fresh = []
    for a in alerts:
        last = seen.get(a["key"])
        repeat = a["kind"] == "tag" and last is not None and now - last >= ALERT_REPEAT_DAYS * DAY
        if last is None or repeat:
            fresh.append(a)
            seen[a["key"]] = now
            a["since"] = now
        else:
            a["since"] = last
    write_json(state_path, seen, gz=False)
    # The first run only learns what's already true: nothing is "new" yet.
    return [] if first_run else fresh


def post_discord(webhook: str, alerts: list[dict[str, Any]]) -> None:
    """One message per run, up to ten alerts (Discord's embed limit)."""
    if not webhook or not alerts:
        return
    embeds = []
    for a in alerts[:10]:
        e = {"title": a["title"][:256], "description": a["detail"][:2000],
             "color": {"godot": 0x478CBF, "tag": 0xEB6834, "breakout": 0x1BAF7A}[a["kind"]]}
        if a.get("appid"):
            e["url"] = f"https://store.steampowered.com/app/{a['appid']}/"
        embeds.append(e)
    more = len(alerts) - len(embeds)
    body = {"username": "Market alerts", "embeds": embeds,
            "content": f"{len(alerts)} new market alert{'s' if len(alerts) != 1 else ''}" + (f" ({more} more in the dashboard)" if more > 0 else ""),
            "allowed_mentions": {"parse": []}}
    request = urllib.request.Request(webhook, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as r:
            r.read()
    except Exception as error:  # a failed post must not lose the day's files
        log.warning("posting the alerts to Discord failed: %s", error)


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def write_json(path: str, data: Any, gz: bool = True) -> int:
    raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode()
    body = gzip.compress(raw, 6, mtime=0) if gz else raw
    tmp = f"{path}.tmp"
    with open(tmp, "wb") as f:
        f.write(body)
    os.replace(tmp, path)
    return len(body)


FILES = ("overview", "growth", "games", "godot", "trends", "upcoming")


def build(db_path: str, out_dir: str, now: float | None = None, webhook: str = "", post: bool = True,
          fetch: bool = True) -> dict[str, Any]:
    started = time.time()
    now = int(now if now is not None else started)
    today = cadence.day_number(now)
    os.makedirs(out_dir, exist_ok=True)
    db = connect(db_path)
    try:
        tag_names = names(db, "tags")
        genre_names = names(db, "genres", "id")
        games = read_games(db)
        first, last = history_days(db)
        # The snapshot of "today" may not have run yet: the gains count back from the newest day.
        latest = last if last is not None else today
        past = add_gains(db, games, latest, first) if first is not None else {}
        add_hit_index(games, today)
        trend = trends(games, tag_names, latest, first, past)
        godot = godot_rows(db, games)
    finally:
        db.close()
    measured = fetch_users(os.path.join(out_dir, "steam-users.json"), now) if fetch else {}
    alerts = find_alerts(games, trend, today)
    fresh = remember_alerts(alerts, os.path.join(out_dir, "alerts-state.json"), now)
    trend["alerts"] = alerts
    if post:
        post_discord(webhook, fresh)
    released = sum(1 for g in games if not g.coming_soon)
    overview = {"builtAt": now, "today": today, "historyFrom": first, "historyTo": last,
                "historyDays": (last - first + 1) if first is not None else 0,
                "games": len(games), "released": released, "comingSoon": len(games) - released,
                "withMetadata": sum(1 for g in games if g.details), "godot": len(godot),
                "tags": {str(k): v for k, v in tag_names.items()}, "genres": {str(k): v for k, v in genre_names.items()},
                "newAlerts": len(fresh)}
    sizes = {
        "growth": write_json(os.path.join(out_dir, "growth.json.gz"), growth(games, tag_names, genre_names, today, measured)),
        "games": write_json(os.path.join(out_dir, "games.json.gz"), recent_rows(games, today)),
        "godot": write_json(os.path.join(out_dir, "godot.json.gz"), {"games": godot}),
        "upcoming": write_json(os.path.join(out_dir, "upcoming.json.gz"), upcoming_rows(games, today)),
        "trends": write_json(os.path.join(out_dir, "trends.json.gz"), trend),
    }
    overview["seconds"] = round(time.time() - started, 1)
    sizes["overview"] = write_json(os.path.join(out_dir, "overview.json.gz"), overview)
    log.info("market files built in %.1f s: %s; %d alerts (%d new)", time.time() - started,
             ", ".join(f"{k} {v / 1024:.0f} KB" for k, v in sizes.items()), len(alerts), len(fresh))
    return {"overview": overview, "sizes": sizes, "alerts": alerts, "fresh": fresh}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m steamdata.market", description="Builds the dashboard's market files from steam.db.")
    parser.add_argument("--no-post", action="store_true", help="don't post new alerts to Discord")
    args = parser.parse_args(argv)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(levelname)s %(name)s: %(message)s")
    db_path = os.environ.get("DB_PATH", "").strip() or DEFAULT_DB_PATH
    out_dir = os.environ.get("MARKET_DIR", "").strip() or DEFAULT_MARKET_DIR
    webhook = os.environ.get("MARKET_DISCORD_WEBHOOK", "").strip()
    build(db_path, out_dir, webhook=webhook, post=not args.no_post)
    return 0


if __name__ == "__main__":
    sys.exit(main())
