"""Which games to search YouTube for, from the Steam data collector's database (read only).

Our own games first (every week), then the rest by how many reviews they gained lately (games people
play now are the ones creators make videos of now), with games that share tags with ours ahead.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import unicodedata
from dataclasses import dataclass

OWN_EVERY_DAYS = 7
# The tags compared with our games': a game's strongest 10 (Steam lists them strongest first).
TOP_TAGS = 10
# The gain is measured over up to this many days of history.
GAIN_DAYS = 28


@dataclass
class Game:
    appid: int
    name: str
    tags: list[int]
    reviews: int
    gain: int = 0
    own: bool = False
    priority: float = 0.0


def normalize(text: str | None) -> str:
    """Lower case, accents and ™/® gone, punctuation as spaces: "Café™: Rush!" -> "cafe rush"."""
    text = unicodedata.normalize("NFKD", re.sub(r"[™®©]", "", text or ""))
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return " ".join(re.sub(r"[^\w]+", " ", text).split())


def searchable(name: str) -> bool:
    """Names too short or too plain find mostly videos about something else ("Dig", "Home", "2048")."""
    n = normalize(name)
    return len(n) >= 4 and not n.isdigit()


def connect(path: str) -> sqlite3.Connection:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    return db


def read(steam_db: str, own_appids: tuple[int, ...], min_reviews: int, max_reviews: int = 50_000,
         own_studio: str = "Four Games") -> list[Game]:
    """Every game worth searching, best first. Ours: the app ids given, and every game whose developer
    or publisher is exactly own_studio. Games over max_reviews are left out: their videos come from
    channels far too big to answer a small studio (and from esports channels)."""
    db = connect(steam_db)
    try:
        last, first = db.execute("SELECT MAX(day), MIN(day) FROM app_daily").fetchone()
        earlier: dict[int, int] = {}
        if last is not None:
            day = max(first, last - GAIN_DAYS)
            earlier = dict(db.execute("SELECT appid, reviews FROM app_daily WHERE day = ? AND reviews IS NOT NULL",
                                      (day,)).fetchall())
        own = set(own_appids)
        rows = db.execute(
            """SELECT appid, name, tags, reviews, developers, publishers FROM apps
               WHERE name IS NOT NULL AND COALESCE(type, 'game') = 'game' AND COALESCE(coming_soon, 0) = 0
                 AND (COALESCE(reviews, 0) BETWEEN ? AND ? OR developers LIKE ? OR publishers LIKE ?)""",
            (min_reviews, max_reviews, f'%"{own_studio}"%', f'%"{own_studio}"%')).fetchall()
        if own:
            seen = {r["appid"] for r in rows}
            missing = [a for a in own if a not in seen]
            if missing:
                rows += db.execute(f"""SELECT appid, name, tags, reviews, developers, publishers FROM apps
                                       WHERE name IS NOT NULL AND appid IN ({",".join("?" * len(missing))})""",
                                   missing).fetchall()
    finally:
        db.close()
    games = []
    for r in rows:
        studios = set(_json(r["developers"])) | set(_json(r["publishers"]))
        is_own = r["appid"] in own or own_studio in studios
        if not is_own and not min_reviews <= (r["reviews"] or 0) <= max_reviews:
            continue
        try:
            tags = [int(t) for t in json.loads(r["tags"] or "[]")][:TOP_TAGS]
        except (ValueError, TypeError):
            tags = []
        reviews = r["reviews"] or 0
        games.append(Game(r["appid"], r["name"], tags, reviews,
                          gain=max(0, reviews - earlier.get(r["appid"], reviews)), own=is_own))
    rank(games)
    return games


def _json(text: str | None) -> list:
    try:
        value = json.loads(text or "[]")
    except ValueError:
        return []
    return value if isinstance(value, list) else []


def rank(games: list[Game]) -> None:
    """Sorts in place: ours first, then by recent reviews, lifted up to 3x by tags shared with ours."""
    own_tags = [set(g.tags) for g in games if g.own and g.tags]
    for g in games:
        shared = max((len(set(g.tags) & tags) for tags in own_tags), default=0)
        # Gain first; a game with no history yet counts a little by its total.
        activity = math.log1p(g.gain) + 0.2 * math.log1p(g.reviews)
        g.priority = activity * (1 + 2 * shared / TOP_TAGS)
    games.sort(key=lambda g: (not g.own, -g.priority, g.appid))
