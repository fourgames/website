#!/usr/bin/env python3
"""The status page's 90-day history: checks every part of Four Games once, from the server, the way
status.fourgames.se judges it in the visitor's browser (server/status-page/status.js), adds the
minute to /srv/fourgames/uptime/uptime.db and writes /srv/fourgames/status/history.json for the page.

Run every minute by uptime-check.timer. Python 3 standard library only, so the system python3 runs it.
Each part is up, degraded or down for the minute; a part that can't be judged (Steam broadcasts while
none is set up, or their own status gone stale) isn't counted at all that minute.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import date, datetime, timedelta
from datetime import time as day_start
from typing import Callable, NamedTuple
from zoneinfo import ZoneInfo

TIMEZONE = "Europe/Stockholm"
TZ = ZoneInfo(TIMEZONE)
DB_PATH = os.environ.get("UPTIME_DB", "/srv/fourgames/uptime/uptime.db")
STATUS_DIR = os.environ.get("UPTIME_STATUS_DIR", "/srv/fourgames/status")
API = "https://api.fourgames.se"

DAYS_SHOWN = 90
KEEP_DAYS = 100
MAX_OUTAGES = 50
# A pause between two checks of a part longer than this (the server was off, or the part wasn't
# judged) ends its outage at the last check, rather than stretching it over the pause.
GAP_SECONDS = 3 * 60
TIMEOUT = 8
WEBSITE_TIMEOUT = 10
RUN_DEADLINE = 20  # a check still going after this counts as down

UP, DEGRADED, DOWN = "up", "degraded", "down"
COLUMNS = {UP: "up", DEGRADED: "degraded", DOWN: "down"}
SEVERITY = {UP: 0, DEGRADED: 1, DOWN: 2}

# The same order as the rows on the status page.
PARTS = ("website", "own", "research", "keybot", "contact", "alerts", "gamedata", "broadcast", "links")
# As in status.js: up while the last good run is this recent, degraded up to the second limit,
# down after it. Research runs can take up to an hour, so it gets more room.
LIMITS = {"own": (15 * 60, 60 * 60), "research": (75 * 60, 2 * 60 * 60)}
BROADCAST_STALE = 10 * 60


class Response(NamedTuple):
    status: int
    body: bytes


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # the 30x then comes back as an HTTPError, with its code


def http_get(url: str, timeout: float = TIMEOUT, follow_redirects: bool = True) -> Response:
    """GET through the public URL (so DNS, Caddy and TLS are part of the check). An HTTP error status
    is returned; a network error, timeout or bad certificate raises."""
    request = urllib.request.Request(url, headers={
        "User-Agent": "FourGamesUptime/1 (+https://status.fourgames.se)",
        "Cache-Control": "no-cache",
    })
    opener = urllib.request.build_opener(*([] if follow_redirects else [_NoRedirect]))
    try:
        with opener.open(request, timeout=timeout) as response:
            return Response(response.status, response.read(1_000_000))
    except urllib.error.HTTPError as error:
        error.close()
        return Response(error.code, b"")


def read_json(path: str):
    """The file's JSON, or None when there's no such file. Unreadable or broken JSON raises."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


# --- Judging, one part at a time (the same rules as status.js) ---------------------------------

def judge_feedback(data, part: str, now: float) -> str:
    """The feedback loop's own report (feedback/loop.sh, write_status). No report, or one without a
    time, is down here: on the server the loop always writes one."""
    if not isinstance(data, dict):
        return DOWN
    try:
        at = float(data.get("lastRunAt"))
    except (TypeError, ValueError):
        return DOWN
    if not at > 0:
        return DOWN
    fresh, late = LIMITS.get(part, LIMITS["own"])
    age = now - at
    if data.get("lastRunOk") is True and age <= fresh:
        return UP
    return DEGRADED if age <= late else DOWN


def judge_alerts(data: dict) -> str | None:
    """Degraded while YouTube or Twitch isn't sending to it (posts still go out within 5 minutes)."""
    youtube = (data.get("youtube") or {}).get("subscribed") is True
    twitch = (data.get("twitch") or {}).get("subscription") == "enabled"
    return None if youtube and twitch else DEGRADED


def judge_gamedata(data: dict) -> str | None:
    """Degraded while its disk is nearly full."""
    return DEGRADED if (data.get("disk") or {}).get("low_space") else None


def judge_health(response: Response, judge: Callable[[dict], str | None] | None = None) -> str:
    """A service's /health: 200 with {"ok": true}. Caddy answers 502 when the service is stopped."""
    if response.status != 200:
        return DOWN
    try:
        data = json.loads(response.body)
    except ValueError:
        return DOWN
    if not isinstance(data, dict) or data.get("ok") is not True:
        return DOWN
    return (judge(data) if judge else None) or UP


def judge_broadcast(data, now: float) -> str | None:
    """server/broadcast/status.sh's report. None (not counted) while no stream is set up, as the row
    is hidden then, and while the report itself is stale, as nothing is known about the streams."""
    if not isinstance(data, dict):
        return None
    streams = data.get("streams")
    if not isinstance(streams, list) or not streams:
        return None
    try:
        checked = float(data.get("checkedAt"))
    except (TypeError, ValueError):
        return None
    if now - checked > BROADCAST_STALE:
        return None
    sending = sum(1 for s in streams if isinstance(s, dict) and s.get("sending") is True)
    if sending == len(streams):
        return UP
    return DOWN if sending == 0 else DEGRADED


class Checker:
    """Every part's check. `get`, `read` and `now` are swapped out in the tests."""

    def __init__(self, get=http_get, read=read_json, now: Callable[[], float] = time.time,
                 status_dir: str = STATUS_DIR):
        self.get, self.read, self.now, self.status_dir = get, read, now, status_dir

    def website(self) -> str:
        try:
            return UP if self.get("https://fourgames.se/", timeout=WEBSITE_TIMEOUT).status == 200 else DOWN
        except Exception:
            return DOWN

    def feedback(self, part: str) -> str:
        try:
            data = self.read(os.path.join(self.status_dir, f"{part}.json"))
        except Exception:
            return DOWN
        return judge_feedback(data, part, self.now())

    def health(self, path: str, judge=None) -> str:
        try:
            response = self.get(f"{API}{path}", timeout=TIMEOUT)
        except Exception:
            return DOWN
        return judge_health(response, judge)

    def broadcast(self) -> str | None:
        try:
            data = self.read(os.path.join(self.status_dir, "broadcast.json"))
        except Exception:
            return None
        return judge_broadcast(data, self.now())

    def links(self) -> str:
        """The short links: discord.fourgames.se answers with a redirect (not followed)."""
        try:
            status = self.get("https://discord.fourgames.se/", timeout=TIMEOUT, follow_redirects=False).status
        except Exception:
            return DOWN
        return UP if 300 <= status < 400 else DOWN

    def checks(self) -> dict[str, Callable[[], str | None]]:
        return {
            "website": self.website,
            "own": lambda: self.feedback("own"),
            "research": lambda: self.feedback("research"),
            "keybot": lambda: self.health("/keybot/health"),
            "contact": lambda: self.health("/contact/health"),
            "alerts": lambda: self.health("/alerts/health", judge_alerts),
            "gamedata": lambda: self.health("/gamedata/health", judge_gamedata),
            "broadcast": self.broadcast,
            "links": self.links,
        }


def run_checks(checks: dict[str, Callable[[], str | None]], deadline: float = RUN_DEADLINE) -> dict[str, str]:
    """All checks at once, in threads. A check that raises or is still going at the deadline counts as
    down; one that answers None isn't counted."""
    pool = ThreadPoolExecutor(max_workers=max(1, len(checks)))
    futures = {part: pool.submit(check) for part, check in checks.items()}
    wait(futures.values(), timeout=deadline)
    pool.shutdown(wait=False, cancel_futures=True)
    results = {}
    for part, future in futures.items():
        if not future.done():
            results[part] = DOWN
            continue
        try:
            state = future.result()
        except Exception:
            state = DOWN
        if state is not None:
            results[part] = state
    return results


# --- Storage --------------------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS daily (
    part TEXT NOT NULL,
    day TEXT NOT NULL,             -- local date in Europe/Stockholm, YYYY-MM-DD
    up INTEGER NOT NULL DEFAULT 0, -- minutes
    degraded INTEGER NOT NULL DEFAULT 0,
    down INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (part, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS outages (
    id INTEGER PRIMARY KEY,
    part TEXT NOT NULL,
    state TEXT NOT NULL,           -- the worst minute in it: degraded or down
    started_at INTEGER NOT NULL,   -- epoch seconds, on the minute
    ended_at INTEGER               -- NULL while it lasts
);
CREATE INDEX IF NOT EXISTS outages_by_part ON outages (part, started_at);
CREATE TABLE IF NOT EXISTS last_check (
    part TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    at INTEGER NOT NULL            -- the minute last counted
);
"""


def connect(path: str = DB_PATH) -> sqlite3.Connection:
    db = sqlite3.connect(path, timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    return db


def local_day(at: float) -> date:
    return datetime.fromtimestamp(at, TZ).date()


def day_starts_at(day: date) -> int:
    return int(datetime.combine(day, day_start.min, TZ).timestamp())


def record(db: sqlite3.Connection, results: dict[str, str], now: float) -> None:
    """Counts this minute for each part, opens, worsens or closes its outage, and prunes old data."""
    minute = int(now) // 60 * 60
    day = local_day(minute).isoformat()
    with db:
        # Outages of parts not counted for a while end at their last counted minute.
        db.execute(
            "UPDATE outages SET ended_at = (SELECT at + 60 FROM last_check l WHERE l.part = outages.part)"
            " WHERE ended_at IS NULL AND (SELECT at FROM last_check l WHERE l.part = outages.part) < ?",
            (minute - GAP_SECONDS,),
        )
        for part, state in results.items():
            last = db.execute("SELECT at FROM last_check WHERE part = ?", (part,)).fetchone()
            if last and last[0] >= minute:
                continue  # this minute is already counted (a second run in the same minute)
            column = COLUMNS[state]
            db.execute(
                f"INSERT INTO daily (part, day, {column}) VALUES (?, ?, 1)"
                f" ON CONFLICT (part, day) DO UPDATE SET {column} = {column} + 1",
                (part, day),
            )
            outage = db.execute(
                "SELECT id, state FROM outages WHERE part = ? AND ended_at IS NULL", (part,)
            ).fetchone()
            if state == UP:
                if outage:
                    db.execute("UPDATE outages SET ended_at = ? WHERE id = ?", (minute, outage[0]))
            elif outage is None:
                db.execute("INSERT INTO outages (part, state, started_at) VALUES (?, ?, ?)", (part, state, minute))
            elif SEVERITY[state] > SEVERITY[outage[1]]:
                db.execute("UPDATE outages SET state = ? WHERE id = ?", (state, outage[0]))
            db.execute(
                "INSERT INTO last_check (part, state, at) VALUES (?, ?, ?)"
                " ON CONFLICT (part) DO UPDATE SET state = excluded.state, at = excluded.at",
                (part, state, minute),
            )
        prune(db, now)


def prune(db: sqlite3.Connection, now: float) -> None:
    """Keeps KEEP_DAYS days: older days and outages that ended before them are deleted."""
    cutoff = local_day(now) - timedelta(days=KEEP_DAYS)
    db.execute("DELETE FROM daily WHERE day < ?", (cutoff.isoformat(),))
    db.execute("DELETE FROM outages WHERE ended_at IS NOT NULL AND ended_at < ?", (day_starts_at(cutoff),))


def uptime_percent(daily: list) -> float | None:
    """Minutes not down out of the minutes checked (degraded counts as up), rounded down to two
    decimals so any time down never shows as 100. None without any checks."""
    checked = sum(sum(d) for d in daily if d)
    if not checked:
        return None
    down = sum(d[2] for d in daily if d)
    return (checked - down) * 10_000 // checked / 100


def history(db: sqlite3.Connection, now: float) -> dict:
    """What history.json holds: the last DAYS_SHOWN local days, oldest first, today last."""
    today = local_day(now)
    days = [(today - timedelta(days=n)).isoformat() for n in range(DAYS_SHOWN - 1, -1, -1)]
    window_start = day_starts_at(date.fromisoformat(days[0]))
    counts = {
        (part, day): [up, degraded, down]
        for part, day, up, degraded, down in db.execute(
            "SELECT part, day, up, degraded, down FROM daily WHERE day >= ?", (days[0],)
        )
    }
    parts = {}
    for part in PARTS:
        daily = [counts.get((part, day)) for day in days]
        outages = db.execute(
            "SELECT state, started_at, ended_at FROM outages WHERE part = ? AND (ended_at IS NULL OR ended_at > ?)"
            " ORDER BY started_at DESC LIMIT ?",
            (part, window_start, MAX_OUTAGES),
        ).fetchall()
        parts[part] = {
            "uptime": uptime_percent(daily),
            "daily": daily,
            "outages": [{"state": s, "start": start, "end": end} for s, start, end in outages],
        }
    return {"generatedAt": int(now), "timezone": TIMEZONE, "days": days, "parts": parts}


def write_json(path: str, data) -> None:
    """Whole or not at all: the page never reads half a file."""
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)


def main() -> int:
    now = time.time()
    results = run_checks(Checker().checks())
    db = connect(DB_PATH)
    try:
        record(db, results, now)
        write_json(os.path.join(STATUS_DIR, "history.json"), history(db, time.time()))
    finally:
        db.close()
    problems = [f"{part} {state}" for part, state in results.items() if state != UP]
    if problems:
        print("Not up:", ", ".join(problems))  # quiet in the journal while everything is up
    return 0


if __name__ == "__main__":
    sys.exit(main())
