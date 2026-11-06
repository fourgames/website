"""The owner's game ideas, /v1/admin/ideas*: the dashboard's "My game ideas" in the Market page.

The owner types a game idea; Claude scores it against the real Steam market data (the files
server/steamdata/market.py writes into MARKET_DIR) and says how to pivot it, what else to make
and when. Ideas are kept, with every analysis and its date, because timing changes: the same idea
can flop early and hit a year later.

- GET    /v1/admin/ideas               every idea, newest first, with its analyses and daily market score
- POST   /v1/admin/ideas               {text, notes?}: saves the idea and scores it with Claude
- POST   /v1/admin/ideas/<id>/score    asks Claude again (today's market data)
- PUT    /v1/admin/ideas/<id>          {text?, notes?, archived?, pinned?, stars?}
- DELETE /v1/admin/ideas/<id>          the idea and its history

All behind admin.require_admin (Steam sign-in, Origin, a JSON body on writes).

The daily market score (no Claude): Claude maps an idea to Steam tags; those ids are kept. At each
GET, an idea without a point for the market files' day gets one, worked out from that day's
trends.json (and games.json for the best pair of its tags), so the history builds up as the market
moves. See market_score() for the formula.

The owner's own ranking: pinned (kept on top of the list) and stars (0 = not rated, 1-5). The
dashboard sorts by them with Claude's score; Claude hears the stars as taste, not as evidence.

Storage: SQLite at IDEAS_DB (default DATA_DIR/ideas.db). The key is ANTHROPIC_API_KEY in the
service's environment; without it, scoring answers 503 claude_not_configured (the list still works).
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import math
import os
import re
import sqlite3
import threading
import time
from datetime import date, datetime, timezone
from typing import Any

from aiohttp import web

from . import web as W
from .limits import Refused, read_json

log = logging.getLogger("gamedata.ideas")

# Haiku 5.5, the model the feedback loop already uses: about $0.003 an idea (Opus 5.5 would be ~40x that).
MODEL = "claude-haiku-5-5"
# Haiku 5.5's default is medium; high costs a little more output and judges the market data more carefully.
EFFORT = "high"
MAX_TOKENS = 16000
CLAUDE_TIMEOUT = 300.0
# The dashboard waits up to two minutes per call; at most two Claude calls at once.
CLAUDE_PARALLEL = 2

MARKET_DIR = "/srv/fourgames/steamdata/market"  # the same default as admin.market
KB = 1024
BODY_CAPS = (16 * KB, 16 * KB)
MAX_TEXT = 2000
MAX_NOTES = 5000
MAX_TAGS = 6
# A tag pair counts only with at least this many rated games behind it.
PAIR_MIN_GAMES = 10

IDEAS = web.AppKey("ideas", object)


def utc_now() -> int:
    return int(time.time())


def iso_day(day_number: int) -> str:
    return date.fromordinal(date(1970, 1, 1).toordinal() + day_number).isoformat()


# The market files, read once per build (cached by mtime)


def market_dir() -> str:
    return os.environ.get("MARKET_DIR", "").strip() or MARKET_DIR


_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()


def market_file(name: str, transform=None) -> Any:
    """A market file parsed (and transformed), or None when it isn't built. Cached until it changes."""
    path = os.path.join(market_dir(), f"{name}.json.gz")
    try:
        mtime = os.stat(path).st_mtime
    except FileNotFoundError:
        return None
    key = f"{path}:{transform.__name__ if transform else ''}"
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
    with gzip.open(path, "rb") as f:
        data = json.load(f)
    if transform:
        data = transform(data)
    with _cache_lock:
        _cache[key] = (mtime, data)
    return data


def rated_games(games: dict[str, Any]) -> dict[str, Any]:
    """games.json cut down to what the pair stats need: the top tags of every rated game."""
    cols = {name: i for i, name in enumerate(games.get("columns", []))}
    top = games.get("topTags", 5)
    rows = [(frozenset((row[cols["tags"]] or [])[:top]), row[cols["day"]], row[cols["hit"]])
            for row in games.get("rows", []) if row[cols["hit"]] is not None and row[cols["day"]] is not None]
    return {"rows": rows}


class Market:
    """Today's market, as the scoring needs it."""

    def __init__(self, trends: dict[str, Any], overview: dict[str, Any] | None):
        self.trends = trends
        self.overview = overview or {}
        self.tags = {t["tag"]: t for t in trends.get("tags", [])}
        names = {int(k): v for k, v in (self.overview.get("tags") or {}).items()}
        names.update({t["tag"]: t["name"] for t in trends.get("tags", [])})
        self.names = names
        self.base_hit = trends.get("baseHitRate") or 0.1
        self.base_median = trends.get("baseMedianReviews") or 0
        self.prior = trends.get("priorGames") or 30
        today = self.overview.get("today")
        self.today = today
        self.day = iso_day(today) if isinstance(today, int) else datetime.now(timezone.utc).date().isoformat()

    @classmethod
    def load(cls) -> "Market | None":
        trends = market_file("trends")
        if trends is None:
            return None
        return cls(trends, market_file("overview"))

    def name(self, tag: int) -> str:
        return self.names.get(tag, f"Tag {tag}")


# The daily market score

def clamp(x: float) -> float:
    return max(0.0, min(100.0, x))


def tag_score(t: dict[str, Any], m: Market) -> dict[str, Any]:
    """One tag's 0-100 market score: 50 is an average Steam tag.

    hit      = 50 + 25 * log2(hitRate / baseHitRate)            (twice Steam's hit rate: 75)
    crowd    = 50 - 20 * log2(supply)                           (share of releases doubled in a year: 30)
    demand   = 50 + 25 * log2(demand), or 50 while it's unknown (share of new reviews vs the window before)
    reviews  = 50 + 12 * log2((median + 1) / (baseMedian + 1))  (what a typical game in it gets)
    score    = 0.45 hit + 0.20 crowd + 0.15 demand + 0.20 reviews, each part clamped to 0-100
    """
    def log2(x):
        return math.log2(max(x, 1e-3))
    hit = clamp(50 + 25 * log2((t.get("hitRate") or m.base_hit) / m.base_hit))
    crowd = clamp(50 - 20 * log2(t["supply"])) if t.get("supply") else 50.0
    demand = clamp(50 + 25 * log2(t["demand"])) if t.get("demand") else 50.0
    reviews = clamp(50 + 12 * log2(((t.get("medianReviews") or 0) + 1) / (m.base_median + 1)))
    score = 0.45 * hit + 0.20 * crowd + 0.15 * demand + 0.20 * reviews
    return {"id": t["tag"], "name": t["name"], "score": round(score, 1), "hitRate": t.get("hitRate"),
            "supply": t.get("supply"), "demand": t.get("demand"), "medianReviews": t.get("medianReviews"),
            "topReviews": t.get("topReviews"), "releases": t.get("releases")}


def best_pair(tag_ids: list[int], m: Market) -> dict[str, Any] | None:
    """The pair of the idea's tags whose games hit most often (shrunk like trends' hit rate), from
    the games released 14-180 days before the market day (trends' hit-rate window)."""
    if len(tag_ids) < 2 or not isinstance(m.today, int):
        return None
    games = market_file("games", rated_games)
    if not games:
        return None
    low, high = (m.trends.get("hitRateWindow") or [14, 180])
    first, last = m.today - high, m.today - low
    pairs = [(a, b) for i, a in enumerate(tag_ids) for b in tag_ids[i + 1:]]
    stats = {p: [0, 0] for p in pairs}
    for tags, day, hit in games["rows"]:
        if not first <= day <= last:
            continue
        for p in pairs:
            if p[0] in tags and p[1] in tags:
                stats[p][0] += 1
                stats[p][1] += hit >= 90
    best = None
    for (a, b), (n, hits) in stats.items():
        if n < PAIR_MIN_GAMES:
            continue
        rate = (hits + m.prior * m.base_hit) / (n + m.prior)
        if best is None or rate > best["hitRate"]:
            best = {"tags": [a, b], "names": [m.name(a), m.name(b)], "games": n, "hits": hits, "hitRate": round(rate, 3)}
    if best:
        best["score"] = round(clamp(50 + 25 * math.log2(max(best["hitRate"], 1e-3) / m.base_hit)), 1)
    return best


def market_score(tag_ids: list[int], m: Market) -> dict[str, Any] | None:
    """The idea's 0-100 market score for the market's day, or None when none of its tags is rated.

    tags  = the tags' scores (tag_score), weighted 1, 1/1.25, 1/1.5, ... in the order Claude
            mapped them (the first is the idea's core)
    score = 0.7 tags + 0.3 pair when its best tag pair has PAIR_MIN_GAMES rated games
            (pair = 50 + 25 * log2(pairHitRate / baseHitRate)), else tags alone
    """
    parts = [tag_score(m.tags[t], m) for t in tag_ids if t in m.tags]
    if not parts:
        return None
    weights = [1 / (1 + 0.25 * i) for i in range(len(parts))]
    tags = sum(w * p["score"] for w, p in zip(weights, parts)) / sum(weights)
    pair = best_pair([t for t in tag_ids if t in m.names], m)
    score = 0.7 * tags + 0.3 * pair["score"] if pair else tags
    return {"score": round(score), "tagsScore": round(tags, 1), "tags": parts, "pair": pair}


# The evidence for one idea: the tags the owner listed, how their pairs did, the biggest similar games

EVIDENCE_DAYS = 365   # pairs: games released 14 days to a year before the market day
COMPARABLE_DAYS = 3 * 365  # comparable games: the whole of games.json (three years)


def evidence_games(games: dict[str, Any]) -> dict[str, Any]:
    """games.json cut down to what the evidence needs: top tags, day, hit, reviews, name."""
    cols = {name: i for i, name in enumerate(games.get("columns", []))}
    top = games.get("topTags", 5)
    rows = [(frozenset((row[cols["tags"]] or [])[:top]), row[cols["day"]], row[cols["hit"]], row[cols["reviews"]] or 0,
             row[cols["name"]]) for row in games.get("rows", []) if row[cols["day"]] is not None]
    return {"rows": rows}


def listed_tags(text: str, m: Market) -> list[int]:
    """The Steam tags the owner named on the template's "Genre (closest Steam tags):" line, as ids."""
    by_name = {n.lower(): i for i, n in m.names.items()}
    out: list[int] = []
    for line in text.splitlines():
        head, _, rest = line.partition(":")
        if not rest or not head.strip().lower().startswith(("genre", "tags", "steam tags")):
            continue
        for part in rest.replace("/", ",").replace(";", ",").split(","):
            tag = by_name.get(part.strip().strip(".").lower())
            if tag is not None and tag not in out:
                out.append(tag)
    return out[:8]


def _median(xs: list[int]) -> int | None:
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def evidence(tag_ids: list[int], m: Market) -> str:
    """For the listed tags: each pair's hit rate (shrunk like the brief's), median reviews and new games in
    90 days, and the biggest games of the last three years with the pair, and with each tag alone."""
    if not tag_ids or not isinstance(m.today, int):
        return ""
    games = market_file("games", evidence_games)
    if not games:
        return ""
    lo = (m.trends.get("hitRateWindow") or [14, 180])[0]
    pairs = [(a, b) for i, a in enumerate(tag_ids) for b in tag_ids[i + 1:]]
    lines = []
    stats = []
    for a, b in pairs:
        rated, reviews, recent, biggest = 0, [], 0, []
        hits = 0
        for tags, day, hit, revs, name in games["rows"]:
            if a not in tags or b not in tags:
                continue
            age = m.today - day
            if age <= 90:
                recent += 1
            if age <= COMPARABLE_DAYS:
                biggest.append((revs, name, day))
            if hit is not None and lo <= age <= EVIDENCE_DAYS:
                rated += 1
                hits += hit >= 90
                reviews.append(revs)
        if not rated and not biggest:
            continue
        rate = (hits + m.prior * m.base_hit) / (rated + m.prior)
        top = sorted(biggest, reverse=True)[:3]
        stats.append((rate, rated, f"{m.name(a)} + {m.name(b)}: {hits} hits of {rated} games released 2 weeks to a year ago "
                      f"({pct(hits / rated) if rated else '-'} raw, {pct(rate)} allowing for chance), median {_median(reviews)} reviews, "
                      f"{recent} new in the last 90 days; biggest in 3 years: "
                      + ("; ".join(f"{n} ({r:,} reviews, {iso_day(d)[:4]})" for r, n, d in top) or "none")))
    if stats:
        lines.append("Tag pairs from the tags the owner listed (games with both tags among their top 5). These are the "
                     "closest match to the idea: weigh them above single tags, and say when a pair has few games:")
        lines += [f"- {t}" for _, _, t in sorted(stats, key=lambda x: -x[0])[:10]]
    singles = []
    for t in tag_ids:
        top = sorted(((revs, name, day) for tags, day, hit, revs, name in games["rows"]
                      if t in tags and m.today - day <= COMPARABLE_DAYS), reverse=True)[:3]
        if top:
            singles.append(f"- {m.name(t)}: " + "; ".join(f"{n} ({r:,} reviews, {iso_day(d)[:4]})" for r, n, d in top))
    if singles:
        lines.append("The biggest games of the last three years with each listed tag (proof that buyers exist; they "
                     "are outliers, not what a typical game gets):")
        lines += singles
    return "\n".join(lines)


# The market brief Claude reads


def pct(x: float | None) -> str:
    return "-" if x is None else f"{100 * x:.0f}%"


def num(x: float | None, digits: int = 1) -> str:
    return "-" if x is None else f"{x:.{digits}f}"


def market_brief(m: Market) -> str:
    """Every rated tag as one line, the rest of Steam's tag names, and Steam's growth in one line each."""
    t = m.trends
    lines = [
        f"Steam market data, built {m.day}. Over the last {t.get('supplyWindow', 90)} days {t.get('releasesNow')} games "
        f"were released ({t.get('releasesYearAgo')} in the same window a year ago).",
        f"Hit = a game in the top 10% of reviews among games released within a week of it. Steam's base hit rate is "
        f"{pct(m.base_hit)}; a typical (median) new game gets {m.base_median} reviews. Hit rates are for games "
        f"released {t.get('hitRateWindow', [14, 180])[0]}-{t.get('hitRateWindow', [14, 180])[1]} days ago, shrunk toward "
        f"the base rate with {m.prior} average games so small tags can't top the list.",
        "Columns: id|tag|releases last 90d|releases same 90d a year ago|supply (share of releases vs a year ago; "
        ">1 = more crowded)|hit rate|hits/rated games|median reviews|top-10% reviews|demand (share of new reviews "
        "vs the window before; - = not known yet)",
    ]
    for r in sorted(t.get("tags", []), key=lambda r: -(r.get("releases") or 0)):
        lines.append(f"{r['tag']}|{r['name']}|{r.get('releases')}|{r.get('releasesYearAgo')}|{num(r.get('supply'))}|"
                     f"{pct(r.get('hitRate'))}|{r.get('hits')}/{r.get('hitGames')}|{r.get('medianReviews')}|"
                     f"{r.get('topReviews')}|{num(r.get('demand'), 2)}")
    rare = [f"{i}:{n}" for i, n in sorted(m.names.items()) if i not in m.tags]
    if rare:
        lines.append("Other Steam tags (too few recent games to rate; you may still map to them): " + ", ".join(rare))
    growth = market_file("growth")
    if growth and growth.get("years"):
        years = growth["years"][-8:]
        released = (growth.get("total") or {}).get("y", [])[-8:]
        users = (growth.get("users") or {}).get("y", [])[-8:]
        lines.append("Steam per year (" + ", ".join(map(str, years)) + "): games released "
                     + ", ".join(map(str, released)) + "; peak concurrent users "
                     + ", ".join("-" if u is None else f"{u / 1e6:.1f}M" for u in users)
                     + f" (the last year is {pct(growth.get('yearDone'))} done).")
    return "\n".join(lines)


SYSTEM = """You assess game ideas for a small indie studio: one to three people, making small PC games in \
Godot for Steam, fast (months, not years), self-published, using AI tools heavily for art, code and content. \
They want ideas that can find players on Steam now, and they also want to know when timing would be better.

How to weigh the evidence, strongest first: (1) the idea's own tag pairs and the real games that did well with \
them (given with the idea), (2) single-tag numbers, (3) general knowledge. A pair with a few games but a famous \
hit is a real signal that buyers exist, though not a promise; say both. The overall score is about the market \
opportunity (demand, competition, hit odds, timing); small_team_fit is reported on its own and moves the overall \
score only a little (at most about 10 points), because the studio decides scope separately. Judge scope by how \
many hard systems it has (netcode, physics, AI, procedural generation), not by art or content volume.

Tag numbers are correlation, not cause. Good games do well whatever their tags, and Steam tags are added by \
players: a game that sells is played by more people, so it collects more tags and more fitting ones, which \
puts hits into more tags' numbers. So a tag's hit rate shows that buyers exist and how crowded it is; it does \
not show that a game with the tag will hit, or that adding a tag helps. Treat tag numbers as a modest signal, \
let the idea's own strength (its hook, its fit with what players of these tags want) count as much, and say \
so when a score leans on tag numbers alone. Never suggest adding a tag the game wouldn't truly have just \
because it sells; a pivot that adds a tag must change the game itself.

Judge with the market data below, not general hype. Quote its numbers in your reasons (hit rates, median and \
top-10% reviews, releases, supply, demand) in plain words a non-analyst understands. Small tags have few games: \
say how sure the data is. A rising supply means more competition arriving; strong demand with modest supply is \
the opening to look for. Being early can mean no audience yet; being late means a crowded tag.

Map the idea to 2-6 Steam tags from the data, the core one first, using the ids exactly as listed. Include \
every tag the owner listed that fits the idea (you may reorder them or add better ones). \
Scores are 0-100, where 50 is an average Steam idea for a team like this. Sub-scores, in this order: \
demand, competition (high = little competition), hit_odds, small_team_fit (scope, art, multiplayer and \
content load for 1-3 people in Godot), timing. Each reason is one line.

Before the pivots, read the idea closely. "hook" is what makes this idea interesting, in the owner's terms (a \
mechanic, a feel, a twist: e.g. "physics-driven car crashes"), and the tags should cover it too where Steam has \
a tag for it (Physics, Destruction, Driving...). "has" lists what the idea already is: its setting, genres, \
camera, mode, players and key mechanics, each a few words. Pivots are concrete changes to this idea (a tag, a \
mechanic, a scope cut, a platform or a price) with the data behind them. A pivot must change something: never \
suggest a setting, genre, tag or mechanic that is already in "has" or among the idea's tags (if a post-apocalyptic \
game should stay post-apocalyptic, that is not a pivot; at most say what to do differently within it). Pivots \
keep the hook and build on it; drop or swap the hook only when the data says the hook itself is the problem, \
and then say so plainly. Alternatives are \
different small ideas the data favours. Timing says now, soon or wait, why, and which signal in this data to \
watch (a tag's supply, hit rate or demand moving past a level).

"""

SUBSCORES = ["demand", "competition", "hit_odds", "small_team_fit", "timing"]

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "tags": {"type": "array", "items": {"type": "object", "properties": {
            "id": {"type": "integer"}, "name": {"type": "string"}, "why": {"type": "string"}},
            "required": ["id", "name", "why"], "additionalProperties": False}},
        "hook": {"type": "string"},
        "has": {"type": "array", "items": {"type": "string"}},
        "score": {"type": "integer"},
        "subscores": {"type": "array", "items": {"type": "object", "properties": {
            "key": {"type": "string", "enum": SUBSCORES}, "score": {"type": "integer"}, "reason": {"type": "string"}},
            "required": ["key", "score", "reason"], "additionalProperties": False}},
        "verdict": {"type": "string"},
        "risks": {"type": "array", "items": {"type": "string"}},
        "pivots": {"type": "array", "items": {"type": "object", "properties": {
            "change": {"type": "string"}, "why": {"type": "string"}},
            "required": ["change", "why"], "additionalProperties": False}},
        "alternatives": {"type": "array", "items": {"type": "object", "properties": {
            "idea": {"type": "string"}, "why": {"type": "string"}},
            "required": ["idea", "why"], "additionalProperties": False}},
        "timing": {"type": "object", "properties": {
            "advice": {"type": "string", "enum": ["now", "soon", "wait"]},
            "detail": {"type": "string"}, "watch": {"type": "string"}},
            "required": ["advice", "detail", "watch"], "additionalProperties": False},
    },
    "required": ["tags", "hook", "has", "score", "subscores", "verdict", "risks", "pivots", "alternatives", "timing"],
    "additionalProperties": False,
}


def user_prompt(idea: dict[str, Any], history: list[dict[str, Any]], m: Market | None = None) -> str:
    parts = [f"The idea:\n{idea['text']}"]
    proof = evidence(listed_tags(idea["text"], m), m) if m else ""
    if proof:
        parts.append(proof)
    if idea.get("notes"):
        parts.append(f"The owner's notes:\n{idea['notes']}")
    if idea.get("stars"):
        parts.append(f"The owner rates this idea {idea['stars']} of 5 stars. That is their taste, not market evidence: "
                     "it must not move the scores. The higher it is, the closer the pivots should stay to the idea.")
    # No earlier score here: told its last number, the model anchors on it ("the 52 stands") instead of
    # judging the evidence afresh. The dashboard shows the score history itself.
    parts.append("Score it from scratch on the evidence here.")
    parts.append("Give 2-4 pivots, 2-3 alternatives and 2-5 risks.")
    return "\n\n".join(parts)


def tidy(result: dict[str, Any], m: Market, listed: list[int] | None = None) -> dict[str, Any]:
    """Claude's answer kept to the shape the dashboard draws: known tags only, scores 0-100, the
    sub-scores in their fixed order, the lists capped."""
    def score(x):
        try:
            return int(max(0, min(100, round(float(x)))))
        except (TypeError, ValueError):
            return None
    tags, seen = [], set()
    for t in result.get("tags") or []:
        if isinstance(t.get("id"), int) and t["id"] in m.names and t["id"] not in seen:
            seen.add(t["id"])
            tags.append({"id": t["id"], "name": m.name(t["id"]), "why": str(t.get("why", ""))})
    # The tags the owner listed stay, even when Claude left one out (they know their game).
    for t in listed or []:
        if t not in seen and t in m.names:
            seen.add(t)
            tags.append({"id": t, "name": m.name(t), "why": "listed by you"})
    has = [str(x) for x in (result.get("has") or []) if str(x).strip()][:12]
    by_key = {s.get("key"): s for s in result.get("subscores") or []}
    subscores = [{"key": k, "score": score(by_key[k].get("score")), "reason": str(by_key[k].get("reason", ""))}
                 for k in SUBSCORES if k in by_key]
    timing = result.get("timing") or {}
    return {
        "tags": tags[:MAX_TAGS + 2],
        "score": score(result.get("score")),
        "subscores": subscores,
        "hook": str(result.get("hook", "")),
        "has": has,
        "verdict": str(result.get("verdict", "")),
        "risks": [str(r) for r in (result.get("risks") or [])][:6],
        "pivots": [{"change": str(p.get("change", "")), "why": str(p.get("why", ""))} for p in result.get("pivots") or []
                   if not already_there(str(p.get("change", "")), [t["name"] for t in tags] + has)][:5],
        "alternatives": [{"idea": str(a.get("idea", "")), "why": str(a.get("why", ""))} for a in result.get("alternatives") or []][:4],
        "timing": {"advice": timing.get("advice") if timing.get("advice") in ("now", "soon", "wait") else "soon",
                   "detail": str(timing.get("detail", "")), "watch": str(timing.get("watch", ""))},
    }


# "Add Post-apocalyptic", "Pivot to a post-apocalyptic setting": a pivot that names, right after its verb,
# something the idea already is.
PIVOT_VERB = r"(?:add(?:ing)?|pivot(?:ing)?\s+(?:in)?to|switch(?:ing)?\s+to|chang(?:e|ing)\s+(?:it\s+)?to|turn(?:ing)?\s+it\s+into|make\s+it|go(?:ing)?)"


def already_there(change: str, have: list[str]) -> bool:
    """True when the pivot only proposes a tag or trait the idea already has (Claude sometimes does)."""
    text = " ".join(change.lower().replace("-", " ").split())
    for name in have:
        name = " ".join(name.lower().replace("-", " ").split())
        if len(name) < 3:
            continue
        if re.search(rf"^\s*{PIVOT_VERB}\s+(?:an?\s+|the\s+|more\s+)?{re.escape(name)}(?:\s+(?:setting|theme|tag|genre|world|style|game))?\s*$", text):
            return True
    return False


def make_client():
    """The Anthropic client (a test swaps Ideas.client for a fake)."""
    import anthropic
    return anthropic.AsyncAnthropic(timeout=CLAUDE_TIMEOUT, max_retries=1)


async def ask_claude(client, idea: dict[str, Any], history: list[dict[str, Any]], m: Market) -> tuple[dict[str, Any], str, dict]:
    """(the analysis, the model that answered, usage). Refused on any failure, with a message for the owner."""
    import anthropic
    try:
        async with client.messages.stream(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": SCHEMA}},
            # The brief changes once a day: several ideas scored the same day share the cached prefix.
            system=[{"type": "text", "text": SYSTEM + market_brief(m), "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_prompt(idea, history, m)}],
        ) as stream:
            message = await stream.get_final_message()
    except anthropic.AuthenticationError:
        raise Refused(503, "claude_key_refused", "Anthropic refused the server's ANTHROPIC_API_KEY") from None
    except anthropic.RateLimitError:
        raise Refused(429, "claude_busy", "Claude's rate limit is used up; try again in a minute",
                      {"Retry-After": "60"}) from None
    except anthropic.APIStatusError as error:
        log.warning("claude answered %s", error.status_code)
        raise Refused(502, "claude_error", f"Claude had a problem (HTTP {error.status_code}); try again") from None
    except anthropic.APITimeoutError:
        raise Refused(504, "claude_timeout", "Claude didn't answer in time; try again") from None
    except anthropic.APIConnectionError:
        raise Refused(502, "claude_unavailable", "Claude can't be reached; try again") from None
    if message.stop_reason == "refusal":
        raise Refused(502, "claude_refused", "Claude declined to score this idea; reword it and try again")
    if message.stop_reason == "max_tokens":
        raise Refused(502, "claude_cut_off", "Claude's answer was cut off; try again")
    text = next((b.text for b in message.content if b.type == "text"), "")
    try:
        result = json.loads(text)
    except ValueError:
        raise Refused(502, "claude_bad_answer", "Claude's answer wasn't readable; try again") from None
    if not isinstance(result, dict):
        raise Refused(502, "claude_bad_answer", "Claude's answer wasn't readable; try again")
    usage = getattr(message, "usage", None)
    used = {k: getattr(usage, k, None) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens")} if usage else {}
    return result, getattr(message, "model", MODEL) or MODEL, used


# The store


class Ideas:
    """The ideas database and the Claude client, made on first use."""

    def __init__(self, path: str):
        self.path = path
        self._db: sqlite3.Connection | None = None
        self.lock = threading.Lock()
        self.client = None
        self._parallel: asyncio.Semaphore | None = None

    @property
    def parallel(self) -> asyncio.Semaphore:
        if self._parallel is None:
            self._parallel = asyncio.Semaphore(CLAUDE_PARALLEL)
        return self._parallel

    @property
    def db(self) -> sqlite3.Connection:
        if self._db is None:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            db = sqlite3.connect(self.path, check_same_thread=False)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS ideas (
                    id INTEGER PRIMARY KEY, text TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
                    archived INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
                    created INTEGER NOT NULL, updated INTEGER NOT NULL);
                -- Every Claude analysis, kept: the idea's text as it was scored, the market day, the answer.
                CREATE TABLE IF NOT EXISTS analyses (
                    id INTEGER PRIMARY KEY, idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
                    at INTEGER NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL, text TEXT NOT NULL,
                    score INTEGER, result TEXT NOT NULL, usage TEXT NOT NULL DEFAULT '{}');
                -- One market score per idea per market day (market_score), no Claude.
                CREATE TABLE IF NOT EXISTS points (
                    idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE, day TEXT NOT NULL,
                    score INTEGER NOT NULL, detail TEXT NOT NULL, PRIMARY KEY (idea_id, day));
                CREATE INDEX IF NOT EXISTS analyses_idea ON analyses (idea_id, at);
            """)
            # The owner's ranking, added later: older databases get the columns here.
            have = {r[1] for r in db.execute("PRAGMA table_info(ideas)")}
            for column in ("pinned", "stars"):
                if column not in have:
                    db.execute(f"ALTER TABLE ideas ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
            db.commit()
            self._db = db
        return self._db

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    def create(self, text: str, notes: str) -> int:
        now = utc_now()
        with self.lock, self.db:
            return self.db.execute("INSERT INTO ideas (text, notes, created, updated) VALUES (?, ?, ?, ?)",
                                   (text, notes, now, now)).lastrowid

    def get(self, idea_id: int) -> dict[str, Any] | None:
        with self.lock:
            row = self.db.execute("SELECT * FROM ideas WHERE id = ?", (idea_id,)).fetchone()
        return self._idea(row) if row else None

    def _idea(self, row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "text": row["text"], "notes": row["notes"], "archived": bool(row["archived"]),
                "pinned": bool(row["pinned"]), "stars": row["stars"],
                "tags": json.loads(row["tags"]), "created": row["created"], "updated": row["updated"]}

    def update(self, idea_id: int, changes: dict[str, Any]) -> None:
        sets = {k: (int(v) if k in ("archived", "pinned") else v) for k, v in changes.items()}
        sets["updated"] = utc_now()
        with self.lock, self.db:
            self.db.execute(f"UPDATE ideas SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",
                            (*sets.values(), idea_id))

    def delete(self, idea_id: int) -> bool:
        with self.lock, self.db:
            return self.db.execute("DELETE FROM ideas WHERE id = ?", (idea_id,)).rowcount > 0

    def add_analysis(self, idea: dict[str, Any], day: str, model: str, result: dict[str, Any], usage: dict) -> None:
        tags = [t["id"] for t in result["tags"]]
        now = utc_now()
        with self.lock, self.db:
            self.db.execute("INSERT INTO analyses (idea_id, at, day, model, text, score, result, usage) "
                            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            (idea["id"], now, day, model, idea["text"], result["score"], json.dumps(result), json.dumps(usage)))
            self.db.execute("UPDATE ideas SET tags = ?, updated = ? WHERE id = ?", (json.dumps(tags), now, idea["id"]))
            # New tags: today's point is worked out again from them.
            self.db.execute("DELETE FROM points WHERE idea_id = ? AND day = ?", (idea["id"], day))

    def history(self, idea_id: int) -> list[dict[str, Any]]:
        with self.lock:
            rows = self.db.execute("SELECT id, at, day, model, text, score FROM analyses WHERE idea_id = ? ORDER BY at, id",
                                   (idea_id,)).fetchall()
        return [dict(r) for r in rows]

    def add_point(self, idea_id: int, day: str, point: dict[str, Any]) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO points (idea_id, day, score, detail) VALUES (?, ?, ?, ?)",
                            (idea_id, day, point["score"], json.dumps(point)))

    def everything(self) -> list[dict[str, Any]]:
        """Every idea, newest first, with its latest analysis in full, the earlier ones' scores and its points."""
        with self.lock:
            ideas = [self._idea(r) for r in self.db.execute("SELECT * FROM ideas ORDER BY created DESC, id DESC")]
            analyses = self.db.execute("SELECT * FROM analyses ORDER BY at, id").fetchall()
            points = self.db.execute("SELECT * FROM points ORDER BY day").fetchall()
        by_id = {i["id"]: {**i, "analysis": None, "analyses": [], "points": []} for i in ideas}
        for a in analyses:
            idea = by_id.get(a["idea_id"])
            if idea is None:
                continue
            idea["analyses"].append({"id": a["id"], "at": a["at"], "day": a["day"], "model": a["model"],
                                     "text": a["text"], "score": a["score"]})
            idea["analysis"] = {"id": a["id"], "at": a["at"], "day": a["day"], "model": a["model"],
                                **json.loads(a["result"])}
        for p in points:
            idea = by_id.get(p["idea_id"])
            if idea is not None:
                detail = json.loads(p["detail"])
                idea["points"].append({"day": p["day"], "score": p["score"], "tagsScore": detail.get("tagsScore"),
                                       "pair": detail.get("pair"), "tags": detail.get("tags")})
        return [by_id[i["id"]] for i in ideas]

    def days_with_points(self, day: str) -> set[int]:
        with self.lock:
            return {r[0] for r in self.db.execute("SELECT idea_id FROM points WHERE day = ?", (day,))}


def ideas_of(request: web.Request) -> Ideas:
    return request.app[IDEAS]


def idea_id(request: web.Request) -> int:
    raw = request.match_info["idea_id"]
    if not raw.isdigit() or len(raw) > 12:
        raise Refused(404, "not_found", "no idea with that id")
    return int(raw)


def found(store: Ideas, request: web.Request) -> dict[str, Any]:
    idea = store.get(idea_id(request))
    if idea is None:
        raise Refused(404, "not_found", "no idea with that id")
    return idea


def text_field(body: dict[str, Any], name: str, cap: int, required: bool) -> str | None:
    value = body.get(name)
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > cap:
        raise Refused(400, "bad_request", f"{name} must be text of at most {cap} characters"
                      + (", not empty" if required else ""))
    return value.strip()


def update_points(store: Ideas, m: Market) -> None:
    """A market point for the market day for every live idea that has tags and none yet."""
    done = store.days_with_points(m.day)
    for idea in store.everything():
        if idea["archived"] or not idea["tags"] or idea["id"] in done:
            continue
        point = market_score(idea["tags"], m)
        if point is not None:
            store.add_point(idea["id"], m.day, point)


def listing(store: Ideas) -> dict[str, Any]:
    m = Market.load()
    if m is not None:
        update_points(store, m)
    return {"ideas": store.everything(),
            "market": {"day": m.day, "builtAt": m.overview.get("builtAt")} if m else None,
            "model": MODEL, "claude": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())}


async def score(request: web.Request, store: Ideas, idea: dict[str, Any]) -> None:
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip() and store.client is None:
        raise Refused(503, "claude_not_configured", "the server has no ANTHROPIC_API_KEY in its environment")
    m = await asyncio.to_thread(Market.load)
    if m is None:
        raise Refused(503, "market_not_built", "the market files aren't built yet (steamdata-market.timer)")
    if store.client is None:
        store.client = make_client()
    history = [{"score": a["score"], "day": a["day"]} for a in await asyncio.to_thread(store.history, idea["id"])]
    started = time.monotonic()
    async with store.parallel:
        raw, model, usage = await ask_claude(store.client, idea, history, m)
    result = tidy(raw, m, listed_tags(idea["text"], m))
    log.info("idea %d scored %s by %s in %.0fs (%s)", idea["id"], result["score"], model,
             time.monotonic() - started, usage)
    await asyncio.to_thread(store.add_analysis, idea, m.day, model, result, usage)
    point = await asyncio.to_thread(market_score, [t["id"] for t in result["tags"]], m)
    if point is not None:
        await asyncio.to_thread(store.add_point, idea["id"], m.day, point)


def one(store: Ideas, idea_id_: int) -> dict[str, Any]:
    return next(i for i in store.everything() if i["id"] == idea_id_)


# The routes


async def list_ideas(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    return W.ok(await asyncio.to_thread(listing, ideas_of(request)))


async def create_idea(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    body = await read_json(request, *BODY_CAPS, require_json_type=True)
    if not set(body) <= {"text", "notes"}:
        raise Refused(400, "bad_request", "send {text, notes?}")
    text = text_field(body, "text", MAX_TEXT, True)
    notes = text_field(body, "notes", MAX_NOTES, False) or ""
    store = ideas_of(request)
    new_id = await asyncio.to_thread(store.create, text, notes)
    try:
        await score(request, store, store.get(new_id))
    except BaseException:
        # Not scored: not kept either (the dashboard keeps the text in its box for another try).
        store.delete(new_id)
        raise
    return W.ok({"idea": await asyncio.to_thread(one, store, new_id)}, status=201)


async def rescore_idea(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    store = ideas_of(request)
    idea = found(store, request)
    await score(request, store, idea)
    return W.ok({"idea": await asyncio.to_thread(one, store, idea["id"])})


async def update_idea(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    store = ideas_of(request)
    idea = found(store, request)
    body = await read_json(request, *BODY_CAPS, require_json_type=True)
    if not body or not set(body) <= {"text", "notes", "archived", "pinned", "stars"}:
        raise Refused(400, "bad_request", "send {text?, notes?, archived?, pinned?, stars?}")
    changes: dict[str, Any] = {}
    if "text" in body:
        changes["text"] = text_field(body, "text", MAX_TEXT, True)
    if "notes" in body:
        changes["notes"] = text_field(body, "notes", MAX_NOTES, False) or ""
    if "archived" in body:
        if not isinstance(body["archived"], bool):
            raise Refused(400, "bad_request", "archived must be true or false")
        changes["archived"] = body["archived"]
    if "pinned" in body:
        if not isinstance(body["pinned"], bool):
            raise Refused(400, "bad_request", "pinned must be true or false")
        changes["pinned"] = body["pinned"]
    if "stars" in body:
        if type(body["stars"]) is not int or not 0 <= body["stars"] <= 5:
            raise Refused(400, "bad_request", "stars must be a whole number from 0 (not rated) to 5")
        changes["stars"] = body["stars"]
    await asyncio.to_thread(store.update, idea["id"], changes)
    return W.ok({"idea": await asyncio.to_thread(one, store, idea["id"])})


async def delete_idea(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    store = ideas_of(request)
    if not await asyncio.to_thread(store.delete, idea_id(request)):
        raise Refused(404, "not_found", "no idea with that id")
    return W.ok({"deleted": True})


async def _close(app: web.Application) -> None:
    app[IDEAS].close()


def add_routes(app: web.Application, v1: str) -> None:
    """The routes under v1 (= <prefix>/v1/admin). The store is made once per app."""
    if IDEAS not in app:
        cfg = app[W.CONFIG]
        app[IDEAS] = Ideas(os.environ.get("IDEAS_DB", "").strip() or os.path.join(cfg.data_dir, "ideas.db"))
        app.on_cleanup.append(_close)
    add = app.router.add_route
    add("GET", f"{v1}/ideas", list_ideas)
    add("POST", f"{v1}/ideas", create_idea)
    add("POST", f"{v1}/ideas/{{idea_id}}/score", rescore_idea)
    add("PUT", f"{v1}/ideas/{{idea_id}}", update_idea)
    add("DELETE", f"{v1}/ideas/{{idea_id}}", delete_idea)
