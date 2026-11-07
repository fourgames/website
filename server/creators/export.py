"""The creators file the dashboard's Creators page reads (through the game-data server's admin API,
signed in as the owner only): every channel with its numbers, emails and where they came from, the
games it covered, a category and its genre profile from those games' Steam tags.

Written after every hourly run, gzipped: /srv/fourgames/creators/export/creators.json.gz
(EXPORT_DIR in creators.env). `python -m creators.export` writes it now.

Per creator (short keys, the file grows to thousands): id, t title, h handle, s subscribers, n videos
on the channel, c country, l language, e [[email, source]] (source: description, revealed, links),
k links {twitch, x, ...}, b hidden-email button (1/0/null), lu newest upload, lv newest video of a
game we searched, g [[appid, videos, newest, views]], cat category, p genre profile [[tagid, weight]],
ra when the hidden email was looked at (only once it was; with or without an email behind it), for
the page's Email hunt.
Also "streamers": Twitch streamers (twitch.py) in the same shape, id "tw:<user id>", pl "tw", h their
login, s followers, n broadcasts of searched games, lu their newest such broadcast, g per game
[[appid, broadcasts, newest, views]], pk partner/affiliate, yt their YouTube channel when it's on our
list, and e with source "youtube" for emails taken from that channel.
Also "press": the press list (press.py), one object per outlet, and "quota": today's YouTube units
(day, spent, limit, exhausted, reset = when YouTube's quota day ends), so the page can say when
collecting stops for the day.
"""

from __future__ import annotations

import gzip
import json
import os
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from .collector import PACIFIC, quota_day
from .config import Config, ConfigError
from .db import Store
from .games import _json, connect, own_appids
from .press import rows as press_rows
from . import twitch as twitch_mod

DEFAULT_DIR = "/srv/fourgames/creators/export"
# Tags that say how a game is sold or felt about, not what it is: left out of genre profiles.
META_TAGS = {"Indie", "Singleplayer", "Casual", "Free to Play", "Early Access", "Great Soundtrack", "Addictive",
             "Replay Value", "Classic", "Masterpiece", "Beautiful", "Funny", "Family Friendly", "Atmospheric",
             "Colorful", "Cute", "2D", "3D", "Stylized", "Pixel Graphics", "Cartoony", "Multiplayer",
             "Controller", "Steam Achievements", "Full controller support", "Short", "Difficult", "Relaxing",
             "Moddable", "Fantasy", "Realistic", "First-Person", "Third Person", "Third-Person", "Story Rich",
             "Mature", "Violent", "Gore", "Nudity", "Sexual Content", "Retro", "Old School", "Minimalist",
             "Hand-drawn", "Cartoon", "Comedy", "Memes", "Psychological"}
TOP_TAGS = 10
PROFILE_TAGS = 8


def category(games: list[tuple[int, int]], reviews: dict[int, int]) -> str:
    """games: [(appid, videos)]. One-game: one game, 3+ videos. Indie variety: 4+ games, most of them
    small (median under 5,000 reviews). Variety: 4+ games. Otherwise: a few games."""
    if len(games) == 1 and games[0][1] >= 3:
        return "one-game"
    if len(games) >= 4:
        median = statistics.median(reviews.get(a, 0) for a, _ in games)
        return "indie-variety" if median < 5000 else "variety"
    return "few-games"


def quota(store: Store, daily_units: int, now: float) -> dict:
    """Today's YouTube units and when the quota day ends (midnight Pacific)."""
    day, _ = quota_day(now)
    spent, exhausted = store.units_spent(day)
    midnight = datetime.fromtimestamp(now, PACIFIC).replace(hour=0, minute=0, second=0, microsecond=0)
    reset = midnight + timedelta(days=1)  # wall-clock arithmetic in Pacific time
    return {"day": day, "spent": spent, "limit": daily_units, "exhausted": exhausted or spent >= daily_units,
            "reset": int(reset.timestamp())}


def build(store: Store, steam_db: str, own: set[int], now: float, daily_units: int | None = None) -> dict:
    db = store.db
    covered: dict[str, list[list]] = defaultdict(list)
    appids: set[int] = set(own)
    for r in db.execute("""SELECT channel_id, appid, COUNT(*) AS n, MAX(published) AS last, SUM(COALESCE(views, 0)) AS views
                           FROM youtube_videos GROUP BY channel_id, appid"""):
        covered[r["channel_id"]].append([r["appid"], r["n"], r["last"], r["views"]])
        appids.add(r["appid"])
    langs: dict[str, Counter] = defaultdict(Counter)
    for cid, lang in db.execute("SELECT channel_id, language FROM youtube_videos WHERE language IS NOT NULL"):
        langs[cid][lang.split("-")[0].lower()] += 1
    twitch_mod.ensure(db)
    tw_covered: dict[str, list[list]] = defaultdict(list)
    for r in db.execute("""SELECT user_id, appid, COUNT(*) AS n, MAX(started) AS last, SUM(COALESCE(views, 0)) AS views
                           FROM twitch_streams GROUP BY user_id, appid"""):
        tw_covered[r["user_id"]].append([r["appid"], r["n"], r["last"], r["views"]])
        appids.add(r["appid"])
    v30 = dict(db.execute("SELECT channel_id, COUNT(*) FROM youtube_videos WHERE published >= ? GROUP BY channel_id",
                          (now - 30 * 86400,)).fetchall())
    site = defaultdict(list)
    for cid, email in db.execute("SELECT channel_id, email FROM site_emails"):
        if email not in site[cid]:
            site[cid].append(email)

    games: dict[int, dict] = {}
    tag_names: dict[int, str] = {}
    try:
        steam = connect(steam_db)
        try:
            tag_names = dict(steam.execute("SELECT tagid, name FROM tags").fetchall())
            ids = sorted(appids)
            for start in range(0, len(ids), 500):
                chunk = ids[start:start + 500]
                for r in steam.execute(f"SELECT appid, name, tags, reviews FROM apps WHERE appid IN ({','.join('?' * len(chunk))})",
                                       chunk):
                    tags = [int(t) for t in _json(r["tags"]) if str(t).isdigit()][:TOP_TAGS]
                    games[r["appid"]] = {"n": r["name"], "t": tags, "r": r["reviews"] or 0, "own": r["appid"] in own}
        finally:
            steam.close()
    except Exception:  # noqa: BLE001 - the page still works without Steam names
        pass
    meta = {t for t, name in tag_names.items() if name in META_TAGS}
    reviews = {a: g["r"] for a, g in games.items()}

    def genre_profile(g: list[list]) -> list[list]:
        profile: Counter = Counter()
        for appid, n, _, _ in g:
            for i, tag in enumerate((games.get(appid) or {}).get("t", [])):
                if tag not in meta:
                    profile[tag] += min(n, 3) * (1 - i / (TOP_TAGS + 2))
        total = sum(profile.values()) or 1
        return [[t, round(w / total, 3)] for t, w in profile.most_common(PROFILE_TAGS)]

    creators = []
    yt_emails: dict[str, list[str]] = {}
    by_twitch: dict[str, str] = {}   # twitch login (lower case) -> the YouTube channel that links it
    by_handle: dict[str, str] = {}   # "@handle" or "channel/UC..." (lower case) -> YouTube channel id
    for r in db.execute("SELECT * FROM youtube_channels WHERE gone = 0 AND refreshed_at IS NOT NULL"):
        cid = r["channel_id"]
        g = sorted(covered.get(cid, []), key=lambda x: -x[1])
        emails = [[e, "description"] for e in json.loads(r["emails"] or "[]")]
        if r["revealed_email"] and r["revealed_email"] not in [e for e, _ in emails]:
            emails.append([r["revealed_email"], "revealed"])
        emails += [[e, "links"] for e in site.get(cid, []) if e not in [x for x, _ in emails]]
        links = json.loads(r["links"] or "{}")
        yt_emails[cid] = [e for e, _ in emails]
        if links.get("twitch"):
            by_twitch.setdefault(links["twitch"].lower(), cid)
        if r["handle"]:
            by_handle[r["handle"].lower()] = cid
        by_handle[f"channel/{cid}".lower()] = cid
        lang = r["language"].split("-")[0].lower() if r["language"] else (langs[cid].most_common(1)[0][0] if langs[cid] else None)
        creators.append({
            "id": cid, "t": r["title"], "h": r["handle"], "s": r["subscribers"], "n": r["videos"],
            "c": r["country"], "l": lang, "e": emails, "k": links,
            "b": r["email_button"], "lu": r["last_upload"], "lv": max((x[2] or 0 for x in g), default=None) or None,
            "v30": v30.get(cid, 0), "g": g, "cat": category([(x[0], x[1]) for x in g], reviews),
            "p": genre_profile(g),
            "own": any(x[0] in own for x in g), "first": r["first_seen"],
            **({"ra": r["revealed_at"]} if r["revealed_at"] else {}),
        })
    streamers = []
    for r in db.execute("SELECT * FROM twitch_channels WHERE gone = 0 AND refreshed_at IS NOT NULL"):
        uid = r["user_id"]
        g = sorted(tw_covered.get(uid, []), key=lambda x: -x[1])
        links = json.loads(r["links"] or "{}")
        emails = [[e, "description"] for e in json.loads(r["emails"] or "[]")]
        # Their YouTube channel, when it's on our list (it links this Twitch, or this Twitch links it).
        yt = by_twitch.get((r["login"] or "").lower()) or by_handle.get((links.get("youtube") or "").lower())
        emails += [[e, "youtube"] for e in yt_emails.get(yt, []) if e not in [x for x, _ in emails]]
        streamers.append({
            "id": f"tw:{uid}", "pl": "tw", "t": r["name"], "h": r["login"], "s": r["followers"],
            "n": sum(x[1] for x in g), "c": None, "l": r["language"], "e": emails, "k": links,
            **({"yt": yt} if yt else {}), "pk": r["kind"] or "", "b": None,
            "lu": r["last_stream"] or None, "lv": r["last_stream"] or None,
            "v30": sum(1 for x in g if (x[2] or 0) >= now - 30 * 86400),
            "g": g, "cat": category([(x[0], x[1]) for x in g], reviews), "p": genre_profile(g),
            "own": any(x[0] in own for x in g), "first": r["first_seen"],
        })
    used = {t for c in creators + streamers for t, _ in c["p"]} | {t for g in games.values() for t in g["t"]}
    return {
        "generated": int(now),
        "tags": {t: tag_names[t] for t in used if t in tag_names},
        "meta": sorted(meta),
        "games": games,
        "creators": creators,
        "streamers": streamers,
        "searched": db.execute("SELECT COUNT(*) FROM searches").fetchone()[0],
        "press": press_rows(store),
        **({"quota": quota(store, daily_units, now)} if daily_units else {}),
    }


def write(config: Config, store: Store, now: float | None = None) -> str:
    data = build(store, config.steam_db, own_appids(config.steam_db, config.own_appids, config.own_studio),
                 now or time.time(), config.daily_units)
    folder = os.environ.get("EXPORT_DIR", "").strip() or DEFAULT_DIR
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "creators.json.gz")
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    return path


def main() -> int:
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"creators: {error}", file=sys.stderr)
        return 2
    store = Store(config.db_path)
    try:
        path = write(config, store)
    finally:
        store.close()
    print(f"wrote {path} ({os.path.getsize(path):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
