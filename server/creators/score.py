"""How much a creator is worth emailing, worked out the same way as the dashboard's Creators page
(src/lib/feedback/creators.js: viewsFactor, activity, fit). The server uses it where it ranks
channels itself: the Email hunt and the link follower (reveal.py, sites.py), the export (genre
profiles) and the search order (games.py, tag similarity).

Expected value of a channel = reach x activity x genre fit:
  - reach: typical views per video (the median of their game videos of 3+ minutes, a week old or
    more), not subscribers; subscribers stand in, at most 0.6, until that's known.
  - activity: from the newest upload and how many uploads in 90 days (one lone Short isn't a habit).
  - genre fit: how much their genres overlap one of our games' tags (its first tags count most),
    shrunk when few games stand behind it (n games: x n/(n+2)).
"""

from __future__ import annotations

import math
import sqlite3
import statistics
from collections import Counter
from typing import Iterable

DAY = 86400
# Tags that say how a game is sold or felt about, not what it is: left out of genre profiles and
# tag similarity.
META_TAGS = {"Indie", "Singleplayer", "Casual", "Free to Play", "Early Access", "Great Soundtrack", "Addictive",
             "Replay Value", "Classic", "Masterpiece", "Beautiful", "Funny", "Family Friendly", "Atmospheric",
             "Colorful", "Cute", "2D", "3D", "Stylized", "Pixel Graphics", "Cartoony", "Multiplayer",
             "Controller", "Steam Achievements", "Full controller support", "Short", "Difficult", "Relaxing",
             "Moddable", "Fantasy", "Realistic", "First-Person", "Third Person", "Third-Person", "Story Rich",
             "Mature", "Violent", "Gore", "Nudity", "Sexual Content", "Retro", "Old School", "Minimalist",
             "Hand-drawn", "Cartoon", "Comedy", "Memes", "Psychological"}
TOP_TAGS = 10
PROFILE_TAGS = 8
# Typical views count only videos this long (Shorts' views count people scrolling past) and this old.
LONG_VIDEO = 180
SETTLED_DAYS = 7
# Uploads in 90 days below this: "quiet" even with a recent upload.
ACTIVE_UPLOADS_90D = 3
ACTIVE_FACTOR = {"active": 1.0, "quiet": 0.6, "inactive": 0.15, "unknown": 0.5}


def tag_weights(tags: Iterable[int], meta: set[int]) -> dict[int, float]:
    """A game's tags as weights: its first (non-meta) tags count most (1, 0.875, ... at least 0.2)."""
    return {t: max(0.2, 1 - i / 8) for i, t in enumerate(t for t in tags if t not in meta)}


def similarity(tags: Iterable[int], target: Iterable[int], meta: set[int]) -> float:
    """How alike a game is to the target game, 0 to 1: their shared non-meta tags, each weighted by
    its place in both lists, over what a copy of the target would score."""
    a, b = tag_weights(tags, meta), tag_weights(target, meta)
    full = sum(w * w for w in b.values())
    return min(1.0, sum(w * b[t] for t, w in a.items() if t in b) / full) if full else 0.0


def views_factor(v: float) -> float:
    """Typical views per video -> 0.05 (200 or fewer) rising evenly per tenfold to 1 at 5,000, 1 up to
    300k, then down to 0.6 at 3M+ (too big to answer a small studio). Same as creators.js."""
    lv, lo, hi = math.log10(max(v, 1)), math.log10(200), math.log10(5000)
    if lv <= lo:
        return 0.05
    if lv < hi:
        return 0.05 + 0.95 * (lv - lo) / (hi - lo)
    if lv <= math.log10(3e5):
        return 1.0
    return max(0.6, 1 - 0.4 * (lv - math.log10(3e5)))


def size_factor(s: int | None) -> float:
    if s is None:
        return 0.5
    return 0.4 if s < 500 else 0.65 if s < 1000 else 1.0 if s <= 300_000 else 0.75 if s <= 1_000_000 else 0.5


def reach(mv: int | None, subscribers: int | None) -> float:
    return views_factor(mv) if mv is not None else 0.6 * size_factor(subscribers)


def activity(last_upload: int | None, uploads_90d: int | None, last_video: int | None, now: float) -> str:
    """active (an upload in 30 days and at least 3 in 90), quiet (30-90 days, or too few uploads),
    inactive (90+ days), unknown. Until the uploads are read, their newest video of a searched game."""
    t = last_upload or last_video
    if not t:
        return "unknown"
    days = (now - t) / DAY
    if days > 90:
        return "inactive"
    if days > 30 or (uploads_90d is not None and uploads_90d < ACTIVE_UPLOADS_90D):
        return "quiet"
    return "active"


def confidence(n: int) -> float:
    """How much to trust a genre overlap that n different games stand behind: 1 -> 0.33, 4 -> 0.67."""
    return n / (n + 2) if n > 0 else 0.0


def performance(game_mv: float | None, mv: float | None) -> float:
    """How a game's videos did against the channel's typical views, damped: 0.5 to 1.5 (1: not known)."""
    if not mv or game_mv is None:
        return 1.0
    return min(1.5, max(0.5, math.sqrt(game_mv / mv)))


def genre_profile(games: Iterable[tuple[int, int, float | None]], tags: dict[int, list[int]], meta: set[int],
                  mv: float | None = None) -> tuple[list[list], int]:
    """games: [(appid, videos, typical views of those videos or None)]. Returns ([[tag, weight]], n):
    the Steam tags of the games they covered, each game weighted by its videos (at most 3) and by how
    its videos did against their typical views, and n, the games behind it."""
    profile: Counter = Counter()
    n = 0
    for appid, videos, game_mv in games:
        game_tags = tags.get(appid) or []
        if not any(t not in meta for t in game_tags):
            continue
        n += 1
        weight = min(videos, 3) * performance(game_mv, mv)
        for i, tag in enumerate(game_tags[:TOP_TAGS]):
            if tag not in meta:
                profile[tag] += weight * (1 - i / (TOP_TAGS + 2))
    total = sum(profile.values()) or 1
    return [[t, round(w / total, 3)] for t, w in profile.most_common(PROFILE_TAGS)], n


def genre_fit(profile: list[list], weights: dict[int, float], n: int) -> float:
    """Overlap of a profile with a game's tag weights, shrunk by the evidence (n games), 0 to 1."""
    overlap = sum(pw * weights.get(t, 0) for t, pw in profile)
    return min(1.0, overlap) * confidence(n)


def typical(views: list[int]) -> int | None:
    return int(statistics.median(views)) if views else None


def load_steam(steam_db: str | None, appids: Iterable[int]) -> tuple[dict[int, list[int]], set[int], dict[int, int]]:
    """({appid: first 10 tags}, meta tag ids, {appid: reviews}) from the Steam data collector's
    database, read only. Empty when it can't be read: callers then rank without genres."""
    tags: dict[int, list[int]] = {}
    reviews: dict[int, int] = {}
    meta: set[int] = set()
    if not steam_db:
        return tags, meta, reviews
    from .games import _json, connect
    try:
        db = connect(steam_db)
    except sqlite3.Error:
        return tags, meta, reviews
    try:
        meta = {t for t, name in db.execute("SELECT tagid, name FROM tags") if name in META_TAGS}
        ids = sorted(set(appids))
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            for r in db.execute(f"SELECT appid, tags, reviews FROM apps WHERE appid IN ({','.join('?' * len(chunk))})", chunk):
                tags[r["appid"]] = [int(t) for t in _json(r["tags"]) if str(t).isdigit()][:TOP_TAGS]
                reviews[r["appid"]] = r["reviews"] or 0
    except sqlite3.Error:
        pass
    finally:
        db.close()
    return tags, meta, reviews


def channel_values(db: sqlite3.Connection, ids: Iterable[str], own: set[int], now: float,
                   steam_db: str | None = None) -> dict[str, float]:
    """Expected value per YouTube channel: reach x activity x its best genre fit to any of our games
    (1 for everyone when our games' tags can't be read). Own-game creators aren't lifted here; the
    callers put them first."""
    ids = list(dict.fromkeys(ids))
    if not ids:
        return {}
    wanted = set(ids)
    settled = now - SETTLED_DAYS * DAY
    games: dict[str, dict[int, list]] = {}
    long_all: dict[str, list[int]] = {}
    for cid, appid, views, dur, published in db.execute(
            "SELECT channel_id, appid, views, duration, published FROM youtube_videos"):
        if cid not in wanted:
            continue
        g = games.setdefault(cid, {}).setdefault(appid, [0, [], 0])  # videos, long settled views, newest
        g[0] += 1
        g[2] = max(g[2], published or 0)
        if views is not None and (dur or 0) >= LONG_VIDEO and (published or now) <= settled:
            g[1].append(views)
    for cid, views in db.execute(
            """SELECT channel_id, MAX(views) FROM youtube_videos WHERE views IS NOT NULL AND duration >= ?
               AND published <= ? GROUP BY video_id""", (LONG_VIDEO, settled)):
        if cid in wanted:
            long_all.setdefault(cid, []).append(views)
    appids = {a for g in games.values() for a in g} | set(own)
    tags, meta, _ = load_steam(steam_db, appids)
    own_weights = [w for w in (tag_weights(tags.get(a, []), meta) for a in own) if w]
    columns = {r[1] for r in db.execute("PRAGMA table_info(youtube_channels)")}
    u90 = "uploads_90d" if "uploads_90d" in columns else "NULL"
    out: dict[str, float] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for r in db.execute(f"""SELECT channel_id, subscribers, last_upload, {u90} AS u90 FROM youtube_channels
                                WHERE channel_id IN ({','.join('?' * len(chunk))})""", chunk):
            cid = r["channel_id"]
            g = games.get(cid, {})
            mv = typical(long_all.get(cid, []))
            act = activity(r["last_upload"], r["u90"], max((x[2] for x in g.values()), default=0) or None, now)
            fit = 1.0
            if own_weights:
                profile, n = genre_profile([(a, x[0], typical(x[1])) for a, x in g.items()], tags, meta, mv)
                fit = max(genre_fit(profile, w, n) for w in own_weights) ** 0.8
            out[cid] = reach(mv, r["subscribers"]) * ACTIVE_FACTOR[act] * fit
    return out
