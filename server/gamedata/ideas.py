"""The owner's game ideas, /v1/admin/ideas*: the dashboard's "My game ideas" in the Market page.

The owner types a game idea; Claude scores it against the real Steam market data (the files
server/steamdata/market.py writes into MARKET_DIR) and says how to pivot it, what else to make
and when. Ideas are kept, with every analysis and its date, because timing changes: the same idea
can flop early and hit a year later.

- GET    /v1/admin/ideas               every idea, newest first, with its analyses and daily market score
- POST   /v1/admin/ideas               {text, notes?}: saves the idea and scores it with Claude
- POST   /v1/admin/ideas/<id>/score    asks Claude again (today's market data)
- POST   /v1/admin/ideas/generate      {direction?}: eight new ideas aimed at a high score, not saved (see
                                       candidate_pairs; the dashboard scores each through POST /ideas
                                       and keeps the best five)
- POST   /v1/admin/ideas/<id>/improve  the scored idea rewritten to fix its weakest sub-scores, keeping its
                                       hook; not saved (the dashboard scores it through POST /ideas and
                                       keeps it only when it beats the original)
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
# One analysis or one rewrite: usually about 5,000 tokens, but high effort sometimes thinks far longer, and
# 16,000 cut some off. The cap only limits; only what is used is paid for.
MAX_TOKENS = 32000
# Eight drafted ideas (and the thinking behind them) need far more room than one analysis.
GEN_MAX_TOKENS = 48000
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


# Rising tags: the dashboard's "Rising now" stages (market-merged.js, risingNow), so the scorer and
# the generator read a rise the way the dashboard does

RISE_MIN_GAMES = 12
RISE_EARLY_SHARE = 0.005   # under 0.5% of releases...
RISE_EARLY_STARTED = 2.5   # ...and it wasn't already rising the year before: early
RISE_LATE_SHARE = 0.015    # 1.5%+ of releases: late
RISE_K = 4
RISE_FEW_BIG = 0.7         # the two biggest new games hold 70%+ of the tag's new reviews: a big-release story
# The dashboard's big-build tags (HUGE and BIG): never "early" for a small team.
BIG_BUILD = {"Massively Multiplayer", "MMORPG", "Open World", "Open World Survival Craft", "Realistic", "Photorealistic",
             "Multiplayer", "Online Co-Op", "PvP", "Online PvP", "Co-op", "Third-Person Shooter", "Souls-like", "Sandbox",
             "Story Rich", "3D", "First-Person"}


def rising_tags(m: Market) -> dict[int, dict[str, Any]]:
    """Each tag whose share of releases rose 1.5x or more (the last 3 full months against the 12 before,
    from under 1.5% of releases) and whose games still hit at least as often as Steam's, with its stage:
    early (small and only just started), late (1.5%+ of releases) or crowded (between). As the
    dashboard's risingNow: a rise carried by one or two big releases is left out."""
    growth = market_file("growth")
    if not growth or not growth.get("tags") or not (growth.get("total") or {}).get("m"):
        return {}
    total = growth["total"]["m"]
    n = len(total)
    done = growth.get("monthDone") or 0
    full = n - 1 if 0 < done < 1 else n
    def span(a, i, j):
        return sum(a[k] or 0 for k in range(max(0, i), min(j, len(a))))
    now, before, prior = (full - 3, full), (full - 15, full - 3), (full - 27, full - 15)
    t_now, t_before, t_prior = span(total, *now), span(total, *before), span(total, *prior)
    if not t_now or not t_before:
        return {}
    few_big = big_release_tags(growth, full)
    out = {}
    for key, g in growth["tags"].items():
        tag = int(key)
        tr = m.tags.get(tag)
        name = (tr or {}).get("name") or g.get("name") or m.name(tag)
        # Like the dashboard's small-team view: no store words, adult or big-build tags.
        if not tr or tr.get("hitRate") is None or tr["hitRate"] < m.base_hit or name in NOT_A_BASE or name in BIG_BUILD:
            continue
        counts = g.get("m") or []
        c_now, c_before, c_prior = span(counts, *now), span(counts, *before), span(counts, *prior)
        if c_now < RISE_MIN_GAMES:
            continue
        share_now, share_before = c_now / t_now, c_before / t_before
        share_prior = c_prior / t_prior if t_prior else 0
        if share_before >= RISE_LATE_SHARE:
            continue
        mult = (c_now + RISE_K) / (share_before * t_now + RISE_K)
        if mult < 1.5:
            continue
        started = (c_before + RISE_K) / (share_prior * t_before + RISE_K)
        if tag in few_big:
            continue
        stage = ("late" if share_now >= RISE_LATE_SHARE
                 else "early" if share_now < RISE_EARLY_SHARE and started < RISE_EARLY_STARTED and name not in BIG_BUILD
                 else "crowded")
        out[tag] = {"tag": tag, "name": name, "stage": stage, "mult": round(mult, 1), "share": share_now,
                    "hitRate": tr["hitRate"], "releases": tr.get("releases")}
    return out


def big_release_tags(growth: dict[str, Any], full: int) -> set[int]:
    """The tags whose new games (released in the 3 full months) got 50+ reviews in all, 70%+ of them
    to their two biggest (newGameReviews in market-merged.js)."""
    months = growth.get("months") or []
    games = market_file("games", gen_games)
    if not games or full - 3 < 0 or full - 3 >= len(months):
        return set()
    def day_of(ym):
        y, mo = map(int, str(ym).split("-")[:2])
        return date(y, mo, 1).toordinal() - date(1970, 1, 1).toordinal()
    first = day_of(months[full - 3])
    last = day_of(months[full]) if full < len(months) else 10 ** 9
    per: dict[int, list] = {}
    for tags, day, hit, revs, name, appid in games["rows"]:
        if not first <= day < last:
            continue
        for t in tags:
            e = per.setdefault(t, [0, 0, 0])  # total, biggest, second
            e[0] += revs
            if revs > e[1]:
                e[1], e[2] = revs, e[1]
            elif revs > e[2]:
                e[2] = revs
    return {t for t, (total, a, b) in per.items() if total >= 50 and (a + b) / total >= RISE_FEW_BIG}


RISE_WORDS = {"early": "Early (small and only just started: an opening, few rivals yet)",
              "crowded": "Getting crowded (others got there first: move fast or find an angle)",
              "late": "Late (1.5%+ of all new games: the rush has arrived)"}


def rising_brief(m: Market) -> str:
    rising = sorted(rising_tags(m).values(), key=lambda r: (["early", "crowded", "late"].index(r["stage"]), -r["mult"]))
    if not rising:
        return ""
    return ("Rising tags (share of new releases, the last 3 months against the 12 before), by stage, as the owner's "
            "dashboard shows them:\n" + "\n".join(
                f"- {r['name']}: {RISE_WORDS[r['stage']]}; {r['mult']}x its share a year before, {100 * r['share']:.1f}% of new "
                f"games now, {pct(r['hitRate'])} hit" for r in rising))


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
    rising = rising_brief(m)
    if rising:
        lines.append(rising)
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
say how sure the data is. Strong demand with modest supply is the opening to look for.

A rising supply is not the same as a crowded tag: read it by the stage in the "Rising tags" list at the end of \
the data, as the owner's dashboard does. Early (a small tag, under 0.5% of new games, whose rise only just \
started, with games that still hit) is an opening: few rivals have arrived yet and players are clearly \
interested, so it counts FOR competition and timing (say "get in now"), not against them. Getting crowded \
means others got there first: competition and timing drop, more the faster it rises, unless the idea has a \
clear angle within it. Late (1.5%+ of all new games) means the rush has arrived: score competition low. For a \
tag not in that list, a supply above 1 means more rivals arriving, and well below 1 means fewer. A small early \
tag has few games, so say how sure the hit odds are, but don't count its small size as weak demand.

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


async def call_claude(client, system: str, content: str, schema: dict[str, Any], what: str = "score this idea",
                      max_tokens: int = MAX_TOKENS) -> tuple[dict[str, Any], str, dict]:
    """(Claude's JSON answer, the model that answered, usage). Refused on any failure, with a message for the owner."""
    import anthropic
    try:
        async with client.messages.stream(
            model=MODEL,
            max_tokens=max_tokens,
            output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": schema}},
            # The brief changes once a day: several calls the same day share the cached prefix.
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": content}],
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
        raise Refused(502, "claude_refused", f"Claude declined to {what}; reword it and try again")
    if message.stop_reason == "max_tokens":
        log.warning("claude cut off at %s tokens (%s)", max_tokens, getattr(getattr(message, "usage", None), "output_tokens", "?"))
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


async def ask_claude(client, idea: dict[str, Any], history: list[dict[str, Any]], m: Market) -> tuple[dict[str, Any], str, dict]:
    """Claude's analysis of one idea (see call_claude)."""
    return await call_claude(client, SYSTEM + market_brief(m), user_prompt(idea, history, m), SCHEMA)


# Generate: new ideas aimed at a high score, built on the strongest tag pairs in the data

# Drafts per run: the dashboard scores them all and keeps the best GEN_KEEP (the rest are archived),
# because the scorer's number can only be known by asking it.
GEN_COUNT = 8
GEN_KEEP = 5
GEN_CANDIDATES = 14
# A candidate pair needs this many rated games: thinner pairs make the scorer doubt the hit odds. A pair
# with an early rising tag (small by nature) needs only PAIR_MIN_GAMES, its tag GEN_EARLY_MIN_GAMES.
GEN_PAIR_MIN = 20
GEN_EARLY_MIN_GAMES = 20
# A candidate's rank moves by its tags' rising stage, as the scorer reads it (rising_tags): an early rise
# is an opening, a crowded or late one costs competition and timing.
GEN_STAGE = {"early": 6, "crowded": -5, "late": -10}
# Up to this many candidates are each early rising tag's best pair, if they didn't make the list anyway.
GEN_EARLY_SLOTS = 4
MAX_DIRECTION = 300
# A tag can be in at most this many of the candidate pairs, so the candidates aren't all one genre.
GEN_TAG_REPEAT = 2
# Tags an idea isn't built around: store and review words, adult content, and what 1-3 people can't make.
NOT_A_BASE = {
    "Indie", "Singleplayer", "Casual", "2D", "3D", "Free to Play", "Early Access", "Great Soundtrack", "Addictive",
    "Replay Value", "Classic", "Beautiful", "Masterpiece", "Multiplayer", "Nudity", "Sexual Content", "NSFW",
    "Hentai", "Mature", "Gore", "Violent", "Massively Multiplayer", "MMORPG", "Photorealistic", "Realistic",
    "Software", "Utilities", "Design & Illustration", "Animation & Modeling",
    "Game Development", "Video Production", "Audio Production", "Web Publishing", "Education", "Movie",
    "Documentary", "Episodic", "Short", "Memes", "Mod", "Benchmark", "VR", "360 Video",
    # What the scorer marks down on small-team fit: big worlds, netcode, live action, big story.
    "Open World", "Open World Survival Craft", "Online Co-Op", "PvP", "Online PvP", "Souls-like", "Story Rich",
    "FMV", "Cinematic", "MOBA", "Battle Royale", "Team-Based", "eSports", "Competitive", "Looter Shooter",
}
# The template's lines, as the fields Claude fills in.
TEMPLATE_FIELDS = [
    ("title", "Working title"), ("one_sentence", "In one sentence"), ("genre_tags", "Genre (closest Steam tags)"),
    ("camera", "2D or 3D, camera (top-down, side, first/third person)"), ("art_style", "Art style"),
    ("core_loop", "Core loop (what you do minute to minute)"), ("progression", "Progression (upgrades, skill tree, unlocks)"),
    ("modes", "Modes (story, endless, free roam, missions)"), ("players", "Players (solo, local co-op, online co-op, PvP; how many)"),
    ("hook", "Hook (what's new or different)"), ("like_these", "Like these games"),
    ("scope", "Scope (team, months to make, hours of play)"), ("price", "Price"),
    ("extras", "Extras (leaderboards, Steam Deck, mods, demo)"),
]
FIELD_CAP = 220
SIMILAR = 4  # recent games with the pair, linked under each new idea
SIMILAR_DAYS = 365


def gen_games(games: dict[str, Any]) -> dict[str, Any]:
    """games.json cut down for generating: top tags, day, hit, reviews, name, app id; and every game by its
    name (lowercase), to link the games Claude names."""
    cols = {name: i for i, name in enumerate(games.get("columns", []))}
    top = games.get("topTags", 5)
    rows, by_name = [], {}
    for row in games.get("rows", []):
        name, appid, reviews = row[cols["name"]], row[cols["appid"]], row[cols["reviews"]] or 0
        if isinstance(name, str) and (name.lower() not in by_name or reviews > by_name[name.lower()]["reviews"]):
            by_name[name.lower()] = {"appid": appid, "name": name, "reviews": reviews, "day": row[cols["day"]]}
        if row[cols["day"]] is not None:
            rows.append((frozenset((row[cols["tags"]] or [])[:top]), row[cols["day"]], row[cols["hit"]], reviews, name, appid))
    return {"rows": rows, "byName": by_name}


def game_link(appid: int, name: str, reviews: int, day: int | None) -> dict[str, Any]:
    return {"appid": appid, "name": name, "reviews": reviews, "released": iso_day(day) if isinstance(day, int) else None,
            "url": f"https://store.steampowered.com/app/{appid}/"}


def candidate_pairs(m: Market, limit: int = GEN_CANDIDATES) -> list[dict[str, Any]]:
    """The tag pairs most likely to score high: their market score (market_score of the two tags, the
    stronger first) moved by their tags' rising stage (GEN_STAGE), with GEN_PAIR_MIN rated games behind
    them, no tag in more than GEN_TAG_REPEAT of them; plus each early rising tag's best pair."""
    if not isinstance(m.today, int):
        return []
    games = market_file("games", gen_games)
    if not games:
        return []
    rising = rising_tags(m)
    early = {t for t, r in rising.items() if r["stage"] == "early"}
    pool = {t: tag_score(r, m) for t, r in m.tags.items() if r.get("name") not in NOT_A_BASE
            and (r.get("hitGames") or 0) >= (GEN_EARLY_MIN_GAMES if t in early else 30)}
    lo, hi = m.trends.get("hitRateWindow") or [14, 180]
    stats: dict[tuple[int, int], dict[str, Any]] = {}
    for tags, day, hit, revs, name, appid in games["rows"]:
        mine = sorted(t for t in tags if t in pool)
        if len(mine) < 2:
            continue
        age = m.today - day
        for i, a in enumerate(mine):
            for b in mine[i + 1:]:
                s = stats.get((a, b))
                if s is None:
                    s = stats[(a, b)] = {"n": 0, "hits": 0, "reviews": [], "recent": 0, "top": [], "similar": []}
                if age <= 90:
                    s["recent"] += 1
                if 0 <= age <= SIMILAR_DAYS and (len(s["similar"]) < SIMILAR or revs > s["similar"][-1][0]):
                    s["similar"] = sorted([*s["similar"], (revs, name, day, appid)], reverse=True)[:SIMILAR]
                if age <= COMPARABLE_DAYS and (len(s["top"]) < 3 or revs > s["top"][-1][0]):
                    s["top"] = sorted([*s["top"], (revs, name, day)], reverse=True)[:3]
                if hit is not None and lo <= age <= hi:
                    s["n"] += 1
                    s["hits"] += hit >= 90
                    s["reviews"].append(revs)
    ranked = []
    for (a, b), s in stats.items():
        if s["n"] < (PAIR_MIN_GAMES if early & {a, b} else GEN_PAIR_MIN):
            continue
        first, second = sorted((pool[a], pool[b]), key=lambda p: -p["score"])
        rate = (s["hits"] + m.prior * m.base_hit) / (s["n"] + m.prior)
        pair_score = clamp(50 + 25 * math.log2(max(rate, 1e-3) / m.base_hit))
        tags = (first["score"] + 0.8 * second["score"]) / 1.8
        score = 0.7 * tags + 0.3 * pair_score
        stages = [rising[t]["stage"] for t in (a, b) if t in rising]
        aim = score + sum(GEN_STAGE[x] for x in stages)
        ranked.append({"tags": [first["id"], second["id"]], "names": [first["name"], second["name"]],
                       "score": round(score), "aim": round(aim), "games": s["n"], "hits": s["hits"],
                       "hitRate": round(rate, 3), "median": _median(s["reviews"]), "recent": s["recent"],
                       "top": s["top"], "parts": [first, second],
                       "stages": {rising[t]["name"]: rising[t]["stage"] for t in (a, b) if t in rising},
                       "similar": [game_link(appid, n, r, d) for r, n, d, appid in s["similar"]]})
    ranked.sort(key=lambda c: (-c["aim"], -c["games"]))
    used: dict[int, int] = {}
    picked = []
    def take(c):
        for t in c["tags"]:
            used[t] = used.get(t, 0) + 1
        picked.append(c)
    # Each early rising tag's best pair first (the dashboard's "get in now"), then the best of the rest.
    for t in sorted(early, key=lambda t: -rising[t]["mult"]):
        best = next((c for c in ranked if t in c["tags"] and c not in picked
                     and all(used.get(x, 0) < GEN_TAG_REPEAT for x in c["tags"])), None)
        if best and len(picked) < min(GEN_EARLY_SLOTS, limit):
            take(best)
    for c in ranked:
        if len(picked) >= limit:
            break
        if c in picked or any(used.get(t, 0) >= GEN_TAG_REPEAT for t in c["tags"]):
            continue
        take(c)
    picked.sort(key=lambda c: (-c["aim"], -c["games"]))
    return picked


def candidate_line(i: int, c: dict[str, Any], m: Market) -> str:
    a, b = c["parts"]
    def tag(p):
        return (f"{p['name']} alone: {pct(p['hitRate'])} hit, supply {num(p['supply'])}, "
                f"demand {num(p['demand'], 2)}, {p['releases']} releases in 90 days")
    biggest = "; ".join(f"{n} ({r:,} reviews, {iso_day(d)[:4]})" for r, n, d in c["top"]) or "none"
    return (f"{i}. {c['names'][0]} + {c['names'][1]} (ids {c['tags'][0]}, {c['tags'][1]}): market score {c['score']} "
            f"(50 = average){stage_words(c)}. {c['hits']} hits of {c['games']} games released 2 weeks to 6 months ago "
            f"({pct(c['hitRate'])} allowing for chance; Steam {pct(m.base_hit)}), median {c['median']} reviews, "
            f"{c['recent']} new in the last 90 days. {tag(a)}. {tag(b)}. Biggest in 3 years: {biggest}. "
            f"Biggest in the last year: " + ("; ".join(f"{g['name']} ({g['reviews']:,} reviews)" for g in c["similar"]) or "none") + ".")


def stage_words(c: dict[str, Any]) -> str:
    if not c.get("stages"):
        return ""
    return "; rising: " + ", ".join(f"{n} {RISE_WORDS[st].split(' (')[0].lower()}" for n, st in c["stages"].items())


def idea_title(text: str) -> str:
    match = re.search(r"^\s*working title\s*:\s*(.+)$", text or "", re.I | re.M)
    title = (match.group(1) if match else (text or "").split("\n")[0]).strip().strip("()").strip()
    return (title[:67] + "...") if len(title) > 70 else title or "Untitled idea"


def owner_taste(ideas_: list[dict[str, Any]]) -> str:
    """The owner's ideas so far, rated and pinned first: what they like, and what not to repeat."""
    live = [i for i in ideas_ if not i["archived"]]
    if not live:
        return ""
    def key(i):
        return (-int(i["pinned"]), -(i["stars"] or 0), -((i.get("analysis") or {}).get("score") or 0))
    lines = []
    for i in sorted(live, key=key)[:30]:
        a = i.get("analysis") or {}
        bits = [f"Claude {a['score']}" if a.get("score") is not None else "not scored"]
        if i["stars"]:
            bits.append(f"{i['stars']} of 5 stars")
        if i["pinned"]:
            bits.append("pinned")
        hook = f"; hook: {a['hook'][:120]}" if a.get("hook") else ""
        lines.append(f"- {idea_title(i['text'])} ({', '.join(bits)}){hook}")
    out = ("The owner's ideas so far (don't repeat them; their stars and pins show their taste, which may "
           "shape one or two of the new ideas but never at the cost of the score):\n" + "\n".join(lines))
    scored = sorted((i for i in live if (i.get("analysis") or {}).get("score") is not None), key=lambda i: -i["analysis"]["score"])
    if len(scored) >= 3:
        def told(i):
            a = i["analysis"]
            subs = "; ".join(f"{x['key']} {x['score']}: {x['reason'][:160]}" for x in a.get("subscores") or [])
            return f"- {idea_title(i['text'])}, {a['score']}: {subs}"
        out += ("\n\nWhat the analyst said about the owner's best and worst scored ideas (learn what it rewards and "
                "what it marks down, and beat the best one):\n" + "\n".join(told(i) for i in scored[:3] + scored[-2:]))
    return out


GEN_RUBRIC_INTRO = "\n\nThe analyst's own instructions, word for word (this is exactly how your ideas will be judged):\n\n"

GEN_SYSTEM = """You come up with new game ideas for a small indie studio: one to three people, making small PC \
games in Godot for Steam, fast (months, not years), self-published, using AI tools heavily for art, code and \
content.

Each idea will then be scored, on its own, by an analyst who reads the same Steam market data. The analyst scores \
0-100 (50 = an average Steam idea for this team) on demand, competition (high = few rivals), hit odds, \
small-team fit and timing. Tag pairs with real hits behind them weigh most; tag numbers are a modest signal \
and the idea's own strength (a clear, specific hook that fits what players of those tags want) counts as \
much. Scope is judged by the hard systems (netcode, physics, AI, procedural generation), not by art volume. \
Your goal: the highest score this data allows, honestly. Not "good enough": every idea should be the \
highest-scoring idea you can find on its pair, and better than the owner's best so far. That means a strong \
market base AND a sharp hook AND a scope 1-3 people can finish in 3-9 months. What it marks down most: tags that are \
getting crowded or late in the Rising tags list (unless the idea has a clear angle within them), online play, \
physics, AI or procedural generation as core systems, live action or a big story, many hand-made levels, and \
pairs with few games. What it rewards: a pair with many hits and few rivals, an early rising tag (an opening the \
owner's dashboard says to get into now), demand rising, and a hook that is the reason players of those tags \
would pick this game. Use at least one or two candidates with an early rising tag when the list has them.

Build every idea on one of the candidate tag pairs given, each idea on a different pair and a different first \
tag, so the ideas are clearly different from each other: different genres, loops, camera, mood and players. \
Not variations of one game. Make each one concrete: a hook a player understands in one line, a minute-to-\
minute loop, real comparable games. No generic "X but with Y" without saying what you actually do. Prefer \
solo or simple co-op; avoid online PvP and big open worlds unless the data clearly pays for them.

Fill the template fields with short, concrete phrases (each under 25 words; "why" under 50). genre_tags lists Steam tag names exactly as in the data, \
comma separated: the pair first, then any other tags the game truly has (no more than 6 in all). \
"pair" is the two tag ids of the candidate it is built on. "why" says in one or two plain sentences why it \
should score high, quoting the pair's numbers.

"""

GEN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"ideas": {"type": "array", "items": {"type": "object", "properties": {
        "pair": {"type": "array", "items": {"type": "integer"}},
        **{k: {"type": "string"} for k, _ in TEMPLATE_FIELDS},
        "why": {"type": "string"}},
        "required": ["pair", *[k for k, _ in TEMPLATE_FIELDS], "why"], "additionalProperties": False}}},
    "required": ["ideas"],
    "additionalProperties": False,
}


def generate_prompt(candidates: list[dict[str, Any]], m: Market, taste: str, direction: str, count: int) -> str:
    parts = ["Candidate tag pairs, best market score first (games with both tags among their top 5):\n"
             + "\n".join(candidate_line(i + 1, c, m) for i, c in enumerate(candidates))]
    if taste:
        parts.append(taste)
    if direction:
        parts.append(f"The owner's direction for this batch (follow it; still aim for the highest score within it):\n{direction}")
    parts.append(f"Give exactly {count} ideas, each on a different candidate pair, as different from each other as the "
                 "data allows, each aimed at the highest score it can get. Best expected score first.")
    return "\n\n".join(parts)


def similar_games(like_these: str, c: dict[str, Any]) -> list[dict[str, Any]]:
    """Links for inspiration: the games Claude named that are in the data, then the pair's biggest recent ones."""
    by_name = (market_file("games", gen_games) or {}).get("byName", {})
    out, seen = [], set()
    for name in re.split(r",|;|/|\band\b", like_these):
        g = by_name.get(name.strip().strip(".()\"'").lower())
        if g and g["appid"] not in seen:
            seen.add(g["appid"])
            out.append(game_link(g["appid"], g["name"], g["reviews"], g["day"]))
    for g in c["similar"]:
        if g["appid"] not in seen:
            seen.add(g["appid"])
            out.append(g)
    return out[:SIMILAR + 3]


def template_values(raw: dict[str, Any]) -> dict[str, str]:
    return {k: " ".join(str(raw.get(k) or "").split())[:FIELD_CAP] for k, _ in TEMPLATE_FIELDS}


def template_text(values: dict[str, str]) -> str:
    return "\n".join(f"{label}: {values[k]}" for k, label in TEMPLATE_FIELDS)[:MAX_TEXT]


def tidy_drafts(result: dict[str, Any], m: Market, candidates: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    """Claude's ideas as template texts ready to score: known pairs only, one idea per pair, the pair's tag
    names on the Genre line (so the scorer gets its evidence), every field short."""
    by_pair = {frozenset(c["tags"]): c for c in candidates}
    drafts, seen = [], set()
    for raw in result.get("ideas") or []:
        if not isinstance(raw, dict):
            continue
        pair = frozenset(t for t in raw.get("pair") or [] if isinstance(t, int))
        c = by_pair.get(pair)
        if c is None or pair in seen:
            continue
        seen.add(pair)
        values = template_values(raw)
        named = [n.strip() for n in values["genre_tags"].split(",") if n.strip()]
        lower = {n.lower() for n in named}
        values["genre_tags"] = ", ".join([n for n in c["names"] if n.lower() not in lower] + named)[:FIELD_CAP]
        text = template_text(values)
        drafts.append({"text": text, "title": values["title"] or "Untitled idea", "why": str(raw.get("why", ""))[:600],
                       "pair": {"tags": c["tags"], "names": c["names"], "score": c["score"], "games": c["games"],
                                "hitRate": c["hitRate"]},
                       "similar": similar_games(values["like_these"], c)})
        if len(drafts) >= count:
            break
    return drafts


# Improve: one scored idea rewritten to fix what the analyst marked down, still the owner's game

IMPROVE_SYSTEM = """You improve one game idea for a small indie studio: one to three people, making small PC \
games in Godot for Steam, fast (months, not years), self-published, using AI tools heavily for art, code and \
content. The owner wants to make this game, so it must stay their game: keep its hook, its core fantasy and \
what makes it theirs. Do not swap it for a different game that happens to score higher.

The idea has been scored by an analyst who reads the same Steam market data; you get the analyst's whole \
assessment. Your job: the version of this idea that scores highest with that analyst, honestly. Fix the \
weakest sub-scores first, with concrete changes to the game: a sharper, more specific hook; a scope cut \
(fewer hard systems: netcode, physics, AI, procedural generation; fewer hand-made levels; no big story); a \
mechanic or mode that fits what players of its strongest tags want; a tag the game truly gets because the \
game changes (an early rising tag from the data is worth a lot when it really fits); a better price or \
player count. Use the analyst's pivots that keep the hook, and answer its risks. Leave alone what already \
scored well. Never add a tag the game wouldn't truly have just because it sells, and never drop the hook \
unless the analyst says the hook itself is the problem (then say so in "why").

Write the whole improved idea in the template fields, short concrete phrases (each under 25 words). \
genre_tags lists Steam tag names exactly as in the data, comma separated, the core one first, no more \
than 6. "changes" lists each change you made (a few words each) and the sub-score it is for. "why" says in \
one or two plain sentences why the new version should score higher, quoting the data.

"""

IMPROVE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        **{k: {"type": "string"} for k, _ in TEMPLATE_FIELDS},
        "changes": {"type": "array", "items": {"type": "object", "properties": {
            "change": {"type": "string"}, "aims": {"type": "string", "enum": SUBSCORES}},
            "required": ["change", "aims"], "additionalProperties": False}},
        "why": {"type": "string"}},
    "required": [*[k for k, _ in TEMPLATE_FIELDS], "changes", "why"],
    "additionalProperties": False,
}


def improve_prompt(idea: dict[str, Any], m: Market) -> str:
    a = idea["analysis"]
    parts = [f"The idea, as the owner has it now:\n{idea['text']}"]
    proof = evidence([t["id"] for t in a.get("tags") or []][:MAX_TAGS], m)
    if proof:
        parts.append(proof)
    if idea.get("notes"):
        parts.append(f"The owner's notes:\n{idea['notes'][:1500]}")
    if idea.get("stars"):
        parts.append(f"The owner rates this idea {idea['stars']} of 5 stars: the higher, the closer the new "
                     "version should stay to it.")
    subs = "\n".join(f"- {s['key']} {s['score']}: {s['reason']}" for s in sorted(
        a.get("subscores") or [], key=lambda s: s["score"] if s["score"] is not None else 101))
    lines = [f"Overall {a.get('score')}. Verdict: {a.get('verdict', '')}",
             f"Tags it mapped: {', '.join(t['name'] for t in a.get('tags') or [])}",
             f"Hook: {a.get('hook', '')}", f"Already has: {'; '.join(a.get('has') or [])}",
             f"Sub-scores, weakest first:\n{subs}"]
    if a.get("risks"):
        lines.append("Risks:\n" + "\n".join(f"- {r}" for r in a["risks"]))
    if a.get("pivots"):
        lines.append("Pivots it suggested:\n" + "\n".join(f"- {p['change']}: {p['why']}" for p in a["pivots"]))
    t = a.get("timing") or {}
    if t:
        lines.append(f"Timing: {t.get('advice')}: {t.get('detail', '')} (watch: {t.get('watch', '')})")
    parts.append("The analyst's assessment of it (" + str(a.get("day", "")) + "):\n" + "\n".join(lines))
    parts.append("Give the improved idea: same game, the weakest scores fixed, aimed at the highest score it can get.")
    return "\n\n".join(parts)


def tidy_improved(raw: dict[str, Any]) -> dict[str, Any] | None:
    values = template_values(raw)
    if not values["one_sentence"] and not values["core_loop"]:
        return None
    changes = [{"change": " ".join(str(c.get("change", "")).split())[:FIELD_CAP],
                "aims": c.get("aims") if c.get("aims") in SUBSCORES else None}
               for c in raw.get("changes") or [] if isinstance(c, dict) and str(c.get("change", "")).strip()][:8]
    return {"text": template_text(values), "title": values["title"] or "Untitled idea",
            "why": str(raw.get("why", ""))[:600], "changes": changes}


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


async def ready(store: Ideas) -> Market:
    """Today's market, with the Claude client made; refused without a key or market files."""
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip() and store.client is None:
        raise Refused(503, "claude_not_configured", "the server has no ANTHROPIC_API_KEY in its environment")
    m = await asyncio.to_thread(Market.load)
    if m is None:
        raise Refused(503, "market_not_built", "the market files aren't built yet (steamdata-market.timer)")
    if store.client is None:
        store.client = make_client()
    return m


async def score(request: web.Request, store: Ideas, idea: dict[str, Any]) -> None:
    m = await ready(store)
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


async def generate_ideas(request: web.Request) -> web.Response:
    """New ideas aimed at a high score, not saved: the dashboard scores (and so keeps) each one through
    POST /ideas, like ideas the owner typed."""
    from .admin import require_admin
    require_admin(request)
    body = await read_json(request, *BODY_CAPS, require_json_type=True)
    if not set(body) <= {"direction"}:
        raise Refused(400, "bad_request", "send {direction?}")
    direction = text_field(body, "direction", MAX_DIRECTION, False) or ""
    store = ideas_of(request)
    m = await ready(store)
    candidates = await asyncio.to_thread(candidate_pairs, m)
    if not candidates:
        raise Refused(503, "market_too_thin", "the market data has no tag pairs with enough rated games yet")
    count = min(GEN_COUNT, len(candidates))
    taste = owner_taste(await asyncio.to_thread(store.everything))
    started = time.monotonic()
    async with store.parallel:
        raw, model, usage = await call_claude(store.client, GEN_SYSTEM + GEN_RUBRIC_INTRO + SYSTEM + market_brief(m),
                                              generate_prompt(candidates, m, taste, direction, count), GEN_SCHEMA,
                                              "come up with ideas", GEN_MAX_TOKENS)
    drafts = tidy_drafts(raw, m, candidates, count)
    log.info("generated %d ideas by %s in %.0fs (%s)", len(drafts), model, time.monotonic() - started, usage)
    if not drafts:
        raise Refused(502, "claude_bad_answer", "Claude's ideas didn't use the candidate tag pairs; try again")
    return W.ok({"drafts": drafts, "keep": min(GEN_KEEP, len(drafts)), "day": m.day, "model": model})


async def improve_idea(request: web.Request) -> web.Response:
    """The idea rewritten to score higher, not saved: the dashboard scores it through POST /ideas."""
    from .admin import require_admin
    require_admin(request)
    store = ideas_of(request)
    idea = await asyncio.to_thread(one, store, found(store, request)["id"])
    if not idea.get("analysis"):
        raise Refused(409, "not_scored", "score the idea first: the improvement works from its scores")
    m = await ready(store)
    started = time.monotonic()
    async with store.parallel:
        raw, model, usage = await call_claude(store.client, IMPROVE_SYSTEM + GEN_RUBRIC_INTRO + SYSTEM + market_brief(m),
                                              improve_prompt(idea, m), IMPROVE_SCHEMA, "improve this idea")
    draft = tidy_improved(raw)
    log.info("idea %d improved by %s in %.0fs (%s)", idea["id"], model, time.monotonic() - started, usage)
    if draft is None:
        raise Refused(502, "claude_bad_answer", "Claude's improved idea came back empty; try again")
    return W.ok({"draft": draft, "from": {"id": idea["id"], "score": idea["analysis"].get("score")},
                 "day": m.day, "model": model})


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
    add("POST", f"{v1}/ideas/generate", generate_ideas)
    add("POST", f"{v1}/ideas/{{idea_id}}/score", rescore_idea)
    add("POST", f"{v1}/ideas/{{idea_id}}/improve", improve_idea)
    add("PUT", f"{v1}/ideas/{{idea_id}}", update_idea)
    add("DELETE", f"{v1}/ideas/{{idea_id}}", delete_idea)
