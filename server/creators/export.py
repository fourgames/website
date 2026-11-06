"""The creators file the dashboard's Creators page reads (through the game-data server's admin API,
signed in as the owner only): every channel with its numbers, emails and where they came from, the
games it covered, a category and its genre profile from those games' Steam tags.

Written after every hourly run, gzipped: /srv/fourgames/creators/export/creators.json.gz
(EXPORT_DIR in creators.env). `python -m creators.export` writes it now.

Per creator (short keys, the file grows to thousands): id, t title, h handle, s subscribers, n videos
on the channel, c country, l language, e [[email, source]] (source: description, revealed, links),
k links {twitch, x, ...}, b hidden-email button (1/0/null), lu newest upload, lv newest video of a
game we searched, g [[appid, videos, newest, views]], cat category, p genre profile [[tagid, weight]].
"""

from __future__ import annotations

import gzip
import json
import os
import statistics
import sys
import time
from collections import Counter, defaultdict

from .config import Config, ConfigError
from .db import Store
from .games import _json, connect, own_appids

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


def build(store: Store, steam_db: str, own: set[int], now: float) -> dict:
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

    creators = []
    for r in db.execute("SELECT * FROM youtube_channels WHERE gone = 0 AND refreshed_at IS NOT NULL"):
        cid = r["channel_id"]
        g = sorted(covered.get(cid, []), key=lambda x: -x[1])
        emails = [[e, "description"] for e in json.loads(r["emails"] or "[]")]
        if r["revealed_email"] and r["revealed_email"] not in [e for e, _ in emails]:
            emails.append([r["revealed_email"], "revealed"])
        emails += [[e, "links"] for e in site.get(cid, []) if e not in [x for x, _ in emails]]
        profile: Counter = Counter()
        for appid, n, _, _ in g:
            for i, tag in enumerate((games.get(appid) or {}).get("t", [])):
                if tag not in meta:
                    profile[tag] += min(n, 3) * (1 - i / (TOP_TAGS + 2))
        total = sum(profile.values()) or 1
        lang = r["language"].split("-")[0].lower() if r["language"] else (langs[cid].most_common(1)[0][0] if langs[cid] else None)
        creators.append({
            "id": cid, "t": r["title"], "h": r["handle"], "s": r["subscribers"], "n": r["videos"],
            "c": r["country"], "l": lang, "e": emails, "k": json.loads(r["links"] or "{}"),
            "b": r["email_button"], "lu": r["last_upload"], "lv": max((x[2] or 0 for x in g), default=None) or None,
            "v30": v30.get(cid, 0), "g": g, "cat": category([(x[0], x[1]) for x in g], reviews),
            "p": [[t, round(w / total, 3)] for t, w in profile.most_common(PROFILE_TAGS)],
            "own": any(x[0] in own for x in g), "first": r["first_seen"],
        })
    used = {t for c in creators for t, _ in c["p"]} | {t for g in games.values() for t in g["t"]}
    return {
        "generated": int(now),
        "tags": {t: tag_names[t] for t in used if t in tag_names},
        "meta": sorted(meta),
        "games": games,
        "creators": creators,
        "searched": db.execute("SELECT COUNT(*) FROM searches").fetchone()[0],
    }


def write(config: Config, store: Store, now: float | None = None) -> str:
    data = build(store, config.steam_db, own_appids(config.steam_db, config.own_appids, config.own_studio),
                 now or time.time())
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
