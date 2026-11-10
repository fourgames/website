"""What's in the database and what's due: python -m steamdata.stats (from server/).

Read-only, so it's fine to run while the collector runs. Uses DB_PATH like the collector. On a
database with years of data, counting the rows takes a few seconds.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

from . import cadence
from .config import DEFAULT_DB_PATH


def _size(path: Path) -> int:
    return path.stat().st_size if path.exists() else 0


def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def _when(ts: float | None, now: float) -> str:
    if not ts:
        return "now"
    left = ts - now
    if left <= 0:
        return "now"
    if left < 3600:
        return f"in {left / 60:.0f} min"
    if left < 2 * cadence.DAY:
        return f"in {left / 3600:.1f} h"
    return f"in {left / cadence.DAY:.0f} days"


def report(db: sqlite3.Connection, path: Path, now: float | None = None) -> str:
    now = time.time() if now is None else now
    today = cadence.day_number(now)
    one = lambda sql, *args: db.execute(sql, args).fetchone()[0]  # noqa: E731
    meta = {r[0]: r[1] for r in db.execute("SELECT key, value FROM meta")}
    lines = []

    wal = Path(str(path) + "-wal")
    lines.append(f"{path}: {_human(_size(path))} (+ {_human(_size(wal))} WAL)")

    types = db.execute("SELECT COALESCE(type, 'not known yet') AS t, COUNT(*) FROM apps GROUP BY t ORDER BY 2 DESC").fetchall()
    total = sum(n for _, n in types)
    lines.append(f"Apps: {total:,}" + (" (" + ", ".join(f"{t} {n:,}" for t, n in types) + ")" if types else ""))
    games = "type = 'game'"
    lines.append(
        f"Games: {one(f'SELECT COUNT(*) FROM apps WHERE {games} AND snapshot_at IS NOT NULL'):,} with a snapshot, "
        f"{one(f'SELECT COUNT(*) FROM apps WHERE {games} AND coming_soon = 1'):,} coming soon, "
        f"{one(f'SELECT COUNT(*) FROM apps WHERE {games} AND visible = 0'):,} hidden from the store, "
        f"{one(f'SELECT COUNT(*) FROM apps WHERE {games} AND in_list = 0 AND list_seen IS NOT NULL'):,} gone from the app list, "
        f"{one(f'SELECT COUNT(*) FROM apps WHERE {games} AND details_at IS NOT NULL'):,} with full metadata")

    godot = one("SELECT COUNT(*) FROM apps WHERE godot = 1")
    by_source = db.execute("""SELECT source, COUNT(*) FROM engine_signals WHERE engine = 'godot' AND strength >= 2
                              GROUP BY source ORDER BY 2 DESC""").fetchall()
    mentions = one("SELECT COUNT(DISTINCT appid) FROM engine_signals WHERE engine = 'godot' AND strength < 2")
    lines.append(f"Godot set: {godot:,} apps (" + (", ".join(f"{s} {n:,}" for s, n in by_source) or "no signals yet")
                 + f"); {mentions:,} more only mention Godot")
    engines = db.execute("""SELECT engine, COUNT(DISTINCT appid) FROM engine_signals WHERE strength >= 2
                            GROUP BY engine ORDER BY 2 DESC""").fetchall()
    if engines:
        lines.append("Engine signals: " + ", ".join(f"{e} {n:,}" for e, n in engines))

    try:
        from .db import AI_WANTED
        wanted = one(f"SELECT COUNT(*) FROM apps WHERE {AI_WANTED}")
        read = one(f"SELECT COUNT(*) FROM apps WHERE {AI_WANTED} AND ai IS NOT NULL")
        disclosed = one(f"SELECT COUNT(*) FROM apps WHERE {AI_WANTED} AND ai = 1")
        lines.append(f"AI disclosure: {read:,} of {wanted:,} recent and upcoming games read, {disclosed:,} disclose AI"
                     + (f" ({disclosed / read:.0%})" if read else ""))
    except sqlite3.OperationalError:
        pass  # a file the collector hasn't opened since the AI columns were added

    daily_today = one("SELECT COUNT(*) FROM app_daily WHERE day = ?", today)
    # From app_daily (keyed by day, so quick) rather than counting today's samples.
    sampled_today = one("SELECT COUNT(*) FROM app_daily WHERE day = ? AND players_peak IS NOT NULL", today)
    first_day = one("SELECT MIN(day) FROM app_daily")
    since = f" since {time.strftime('%Y-%m-%d', time.gmtime(first_day * cadence.DAY))}" if first_day is not None else ""
    lines.append(f"Rows: daily {one('SELECT COUNT(*) FROM app_daily'):,} ({daily_today:,} today){since}, "
                 f"player samples {one('SELECT COUNT(*) FROM players'):,} ({sampled_today:,} games sampled today), "
                 f"changes {one('SELECT COUNT(*) FROM app_changes'):,}, tags {one('SELECT COUNT(*) FROM tags'):,}")

    due = {lane: one(f"SELECT COUNT(*) FROM apps WHERE {column} <= ?", int(now))
           for lane, column in (("snapshot", "snapshot_due"), ("players", "players_due"), ("details", "details_due"))}
    pending_details = one("SELECT COUNT(*) FROM apps WHERE details_due IS NOT NULL AND details_at IS NULL")
    next_snapshot = one("SELECT MIN(snapshot_due) FROM apps WHERE snapshot_due > ?", int(now))
    lines.append(f"Due now: snapshot {due['snapshot']:,} (next batch {_when(next_snapshot, now) if next_snapshot else 'not scheduled'}), "
                 f"players {due['players']:,}, metadata {due['details']:,} ({pending_details:,} never fetched)")
    run = json.loads(meta.get("applist_run") or "null")
    applist = (f"running ({'full' if run['full'] else 'changes'}, {run['apps']:,} apps so far)" if run
               else f"changes {_when(float(meta.get('applist_due') or 0), now)}, "
                    f"full {_when(float(meta.get('applist_full_due') or 0), now)}")
    lines.append(f"Next: app list {applist}; tag names {_when(float(meta.get('tags_due') or 0), now)}; "
                 f"PCGamingWiki {_when(float(meta.get('pcgw_due') or 0), now)}")

    for label, day in (("today", today), ("yesterday", today - 1)):
        rows = db.execute("SELECT host, ok, throttled, failed, bytes FROM http_log WHERE day = ? ORDER BY ok DESC",
                          (day,)).fetchall()
        if rows:
            lines.append(f"Requests {label} (UTC): " + "; ".join(
                f"{h} {ok:,} ok, {th:,} throttled, {f:,} failed, {_human(b)}" for h, ok, th, f, b in rows))
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    path = Path(os.environ.get("DB_PATH", "").strip() or DEFAULT_DB_PATH)
    if not path.exists():
        print(f"No database at {path} yet (the collector makes it when it starts).")
        return 1
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    try:
        print(report(db, path))
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
