"""Where the data lives: one SQLite file (WAL) for players, sessions, hardware, settings, the index
of event batches and crash reports; the event batches and crash logs themselves as gzip files next
to it. Nothing is ever deleted automatically; see retention.py for how data is unlinked instead.

    DATA_DIR/gamedata.db
    DATA_DIR/raw/<app_id>/<yyyy-mm>/<session_id>/<seq>.json.gz     (month the session started)
    DATA_DIR/crashes/<app_id>/<yyyy-mm>/<crash_id>.json.gz         (month it was reported)
    DATA_DIR/tmp/                                                  (exports being built)

The files never hold a pid: they're keyed by session id, and the sessions table says whose session
it is. So anonymising rewrites rows only. Times are unix seconds (UTC).
"""

from __future__ import annotations

import gzip
import json
import os
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .signing import random_pid

SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
    pid       TEXT PRIMARY KEY,
    opted_out INTEGER NOT NULL DEFAULT 0,
    created   INTEGER NOT NULL,
    updated   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id       TEXT PRIMARY KEY,
    pid              TEXT NOT NULL,
    app_id           INTEGER NOT NULL,
    started          INTEGER NOT NULL,
    last_seen        INTEGER NOT NULL,
    ended            INTEGER,
    game_version     TEXT,
    build_id         TEXT,
    godot_version    TEXT,
    platform         TEXT,
    locale           TEXT,
    country          TEXT,              -- ISO code, from the IP at start (the IP isn't kept)
    region           TEXT,              -- the region's (subdivision's) English name, likewise
    consent_hardware INTEGER NOT NULL,
    previous_crash   TEXT,              -- JSON, as the game sent it at start
    boot_kind        TEXT,              -- first_install, first_after_update or normal
    input_type       TEXT,              -- what the player plays with (only with hardware consent)
    input_controller TEXT,
    dlc              TEXT,              -- JSON: [{app_id, owned}]
    owns_full_game   INTEGER,           -- for a demo (GAMEDATA_DEMO_OF): Steam says they own the game
    batches          INTEGER NOT NULL DEFAULT 0,
    events           INTEGER NOT NULL DEFAULT 0,
    last_t           REAL,              -- the latest event time seen: playtime until session/end
    last_progress    TEXT,              -- JSON: the data of the latest progress event
    last_progress_t  REAL,              -- that event's t
    playtime_s       REAL,              -- from session/end
    end_seq          INTEGER,
    summary          TEXT,              -- JSON, from session/end
    active_s         REAL,              -- the rest from session/end too
    idle_s           REAL,
    first_session    INTEGER,
    last_scene       TEXT,
    last_screen      TEXT
);
CREATE INDEX IF NOT EXISTS sessions_by_pid ON sessions(pid, app_id);
CREATE INDEX IF NOT EXISTS sessions_by_app ON sessions(app_id, started);

CREATE TABLE IF NOT EXISTS hardware (
    session_id  TEXT PRIMARY KEY,
    pid         TEXT NOT NULL,
    app_id      INTEGER NOT NULL,
    created     INTEGER NOT NULL,
    os          TEXT,
    cpu         TEXT,
    cpu_cores   INTEGER,
    ram_mb      INTEGER,
    gpu         TEXT,
    gpu_driver  TEXT,
    renderer    TEXT,
    screen_w    INTEGER,
    screen_h    INTEGER,
    refresh_hz  REAL,
    steam_deck  INTEGER
);
CREATE INDEX IF NOT EXISTS hardware_by_pid ON hardware(pid);

CREATE TABLE IF NOT EXISTS settings (
    session_id TEXT PRIMARY KEY,
    pid        TEXT NOT NULL,
    app_id     INTEGER NOT NULL,
    created    INTEGER NOT NULL,
    data       TEXT NOT NULL            -- JSON object, flat key -> scalar
);
CREATE INDEX IF NOT EXISTS settings_by_pid ON settings(pid);

-- The event batches on disk. (session_id, seq) makes uploads idempotent.
CREATE TABLE IF NOT EXISTS batches (
    session_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    pid        TEXT NOT NULL,
    app_id     INTEGER NOT NULL,
    received   INTEGER NOT NULL,
    events     INTEGER NOT NULL,
    bytes      INTEGER NOT NULL,        -- the gzip file's size
    path       TEXT NOT NULL,           -- relative to DATA_DIR
    PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS batches_by_pid ON batches(pid, received);

-- Crash reports; the log (log_tail and last_events) is a file next to the database.
CREATE TABLE IF NOT EXISTS crashes (
    crash_id           TEXT PRIMARY KEY,
    pid                TEXT NOT NULL,
    app_id             INTEGER NOT NULL,
    session_id         TEXT NOT NULL UNIQUE,  -- the session that reported it: one report per launch
    crashed_session_id TEXT,
    game_version       TEXT,
    signal             TEXT,
    os                 TEXT,
    received           INTEGER NOT NULL,
    events             INTEGER NOT NULL,
    bytes              INTEGER,
    path               TEXT
);
CREATE INDEX IF NOT EXISTS crashes_by_pid ON crashes(pid);

-- The random pids anonymised data was given, so the automatic unlinking skips them. Nothing else:
-- no time, no link to the player's pid.
CREATE TABLE IF NOT EXISTS anonymised (
    pid TEXT PRIMARY KEY
) WITHOUT ROWID;

"""

# Every table with a pid column: anonymising rewrites them all.
PID_TABLES = ("sessions", "hardware", "settings", "batches", "crashes")

# What session/start and session/end may fill in, besides the ids and times.
SESSION_INFO = ("game_version", "build_id", "godot_version", "platform", "locale", "country", "region",
                "consent_hardware", "previous_crash", "boot_kind", "input_type", "input_controller", "dlc",
                "owns_full_game")
SESSION_END = ("active_s", "idle_s", "first_session", "last_scene", "last_screen")

HARDWARE_COLUMNS = ("os", "cpu", "cpu_cores", "ram_mb", "gpu", "gpu_driver", "renderer",
                    "screen_w", "screen_h", "refresh_hz", "steam_deck")


def hardware_dict(row: sqlite3.Row) -> dict[str, Any]:
    """A hardware row in the shape the game sends it."""
    screen = [row["screen_w"], row["screen_h"]] if row["screen_w"] is not None else None
    deck = row["steam_deck"]
    return {"os": row["os"], "cpu": row["cpu"], "cpu_cores": row["cpu_cores"], "ram_mb": row["ram_mb"],
            "gpu": row["gpu"], "gpu_driver": row["gpu_driver"], "renderer": row["renderer"], "screen": screen,
            "refresh_hz": row["refresh_hz"], "steam_deck": bool(deck) if deck is not None else None}


def month(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m")


def iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_gzip_json(path: Path, value: Any) -> int:
    """Writes the file whole or not at all (a temp file renamed over it). Its size in bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = gzip.compress(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode(),
                         compresslevel=6, mtime=0)
    temp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    with open(temp, "wb") as file:
        file.write(data)
    os.replace(temp, path)
    return len(data)


def read_gzip_json(path: Path) -> Any:
    with gzip.open(path, "rb") as file:
        return json.loads(file.read())


@dataclass(frozen=True)
class Session:
    session_id: str
    pid: str
    app_id: int
    started: int
    ended: int | None


class Store:
    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir)
        self.root.mkdir(parents=True, exist_ok=True)
        for sub in ("raw", "crashes", "tmp"):
            (self.root / sub).mkdir(exist_ok=True)
        # isolation_level=None: no hidden transactions; the ones below are explicit.
        self.db = sqlite3.connect(self.root / "gamedata.db", isolation_level=None, timeout=10)
        self.db.row_factory = sqlite3.Row
        # WAL keeps reads from waiting on writes and is safe if the process dies mid-write.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        # Deleted and rewritten values are overwritten on disk, so an anonymised pid doesn't linger
        # in free pages.
        self.db.execute("PRAGMA secure_delete=ON")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield self.db
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        self.db.execute("COMMIT")

    # Players

    def player(self, pid: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM players WHERE pid = ?", (pid,)).fetchone()

    def opted_out(self, pid: str) -> bool:
        row = self.player(pid)
        return bool(row and row["opted_out"])

    def set_opted_out(self, pid: str, opted_out: bool, now: float | None = None) -> None:
        now = int(time.time() if now is None else now)
        self.db.execute(
            """INSERT INTO players (pid, opted_out, created, updated) VALUES (?, ?, ?, ?)
               ON CONFLICT(pid) DO UPDATE SET opted_out = excluded.opted_out, updated = excluded.updated""",
            (pid, int(opted_out), now, now))

    # Sessions

    def start_session(self, pid: str, app_id: int, info: dict[str, Any],
                      hardware: dict[str, Any] | None, settings: dict[str, Any] | None,
                      now: float | None = None) -> str | None:
        """A new session's id, or None if the player has opted out (checked inside the same
        transaction, so an opt-out at the same moment can't slip past)."""
        now = int(time.time() if now is None else now)
        session_id = str(uuid.uuid4())
        with self.transaction() as db:
            row = db.execute("SELECT opted_out FROM players WHERE pid = ?", (pid,)).fetchone()
            if row is not None and row["opted_out"]:
                return None
            if row is None:
                db.execute("INSERT INTO players (pid, opted_out, created, updated) VALUES (?, 0, ?, ?)",
                           (pid, now, now))
            else:
                db.execute("UPDATE players SET updated = ? WHERE pid = ?", (now, pid))
            values = {column: info.get(column) for column in SESSION_INFO}
            values["consent_hardware"] = int(bool(info.get("consent_hardware")))
            for column in ("previous_crash", "dlc"):
                if values[column] is not None:
                    values[column] = json.dumps(values[column], ensure_ascii=False)
            if isinstance(values["owns_full_game"], bool):
                values["owns_full_game"] = int(values["owns_full_game"])
            db.execute(
                f"""INSERT INTO sessions (session_id, pid, app_id, started, last_seen, {", ".join(SESSION_INFO)})
                    VALUES (?, ?, ?, ?, ?, {", ".join("?" * len(SESSION_INFO))})""",
                (session_id, pid, app_id, now, now, *values.values()))
            if hardware is not None:
                screen = hardware.get("screen") or [None, None]
                values = {**hardware, "screen_w": screen[0], "screen_h": screen[1]}
                if isinstance(values.get("steam_deck"), bool):
                    values["steam_deck"] = int(values["steam_deck"])
                db.execute(
                    f"""INSERT INTO hardware (session_id, pid, app_id, created, {", ".join(HARDWARE_COLUMNS)})
                        VALUES (?, ?, ?, ?, {", ".join("?" * len(HARDWARE_COLUMNS))})""",
                    (session_id, pid, app_id, now, *(values.get(c) for c in HARDWARE_COLUMNS)))
            if settings is not None:
                db.execute("INSERT INTO settings (session_id, pid, app_id, created, data) VALUES (?, ?, ?, ?, ?)",
                           (session_id, pid, app_id, now, json.dumps(settings, ensure_ascii=False)))
        return session_id

    def session(self, session_id: str) -> Session | None:
        row = self.db.execute("SELECT session_id, pid, app_id, started, ended FROM sessions WHERE session_id = ?",
                              (session_id,)).fetchone()
        return Session(*row) if row else None

    def end_session(self, session_id: str, seq: int | None, playtime_s: float | None,
                    summary: dict[str, Any] | None, now: float | None = None, **more: Any) -> bool:
        """False if it had already ended (a retry): the first end stays. `more`: the other
        session/end fields (SESSION_END)."""
        now = int(time.time() if now is None else now)
        extra = {column: more.get(column) for column in SESSION_END}
        if isinstance(extra["first_session"], bool):
            extra["first_session"] = int(extra["first_session"])
        cursor = self.db.execute(
            f"""UPDATE sessions SET ended = ?, last_seen = ?, end_seq = ?, playtime_s = ?, summary = ?,
                                   {", ".join(f"{c} = ?" for c in SESSION_END)}
                WHERE session_id = ? AND ended IS NULL""",
            (now, now, seq, playtime_s, json.dumps(summary, ensure_ascii=False) if summary is not None else None,
             *extra.values(), session_id))
        return cursor.rowcount == 1

    # Event batches

    def batch_path(self, session: Session, seq: int) -> str:
        return f"raw/{session.app_id}/{month(session.started)}/{session.session_id}/{seq}.json.gz"

    def has_batch(self, session_id: str, seq: int) -> bool:
        return self.db.execute("SELECT 1 FROM batches WHERE session_id = ? AND seq = ?",
                               (session_id, seq)).fetchone() is not None

    def bytes_since(self, pid: str, since: float) -> int:
        return self.db.execute("SELECT COALESCE(SUM(bytes), 0) FROM batches WHERE pid = ? AND received >= ?",
                               (pid, int(since))).fetchone()[0]

    def add_batch(self, session: Session, seq: int, events: int, last_t: float | None,
                  size: int, path: str, now: float | None = None,
                  progress: tuple[float, dict[str, Any]] | None = None) -> bool:
        """Indexes a batch whose file is written. False if (session, seq) was already there.
        `progress` is the batch's latest progress event (t, data): the session keeps the latest one
        it has seen, whatever order the batches arrive in."""
        now = int(time.time() if now is None else now)
        with self.transaction() as db:
            cursor = db.execute(
                """INSERT OR IGNORE INTO batches (session_id, seq, pid, app_id, received, events, bytes, path)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (session.session_id, seq, session.pid, session.app_id, now, events, size, path))
            if cursor.rowcount != 1:
                return False
            db.execute(
                """UPDATE sessions SET batches = batches + 1, events = events + ?, last_seen = ?,
                                       last_t = MAX(COALESCE(last_t, 0), COALESCE(?, 0))
                   WHERE session_id = ?""",
                (events, now, last_t, session.session_id))
            if progress is not None:
                db.execute(
                    """UPDATE sessions SET last_progress = ?, last_progress_t = ?
                       WHERE session_id = ? AND (last_progress_t IS NULL OR last_progress_t <= ?)""",
                    (json.dumps(progress[1], ensure_ascii=False), progress[0], session.session_id, progress[0]))
        return True

    # Crashes

    def crash_reported(self, session_id: str) -> bool:
        return self.db.execute("SELECT 1 FROM crashes WHERE session_id = ?", (session_id,)).fetchone() is not None

    def crashed_session_of(self, pid: str, session_id: str | None) -> str | None:
        """The crashed session's id if it's this player's, else None (a client can't tie its crash
        to someone else's session)."""
        if session_id is None:
            return None
        row = self.db.execute("SELECT 1 FROM sessions WHERE session_id = ? AND pid = ?", (session_id, pid)).fetchone()
        return session_id if row else None

    def add_crash(self, crash_id: str, session: Session, crashed_session_id: str | None,
                  details: dict[str, Any], events: int, size: int, path: str,
                  now: float | None = None) -> bool:
        now = int(time.time() if now is None else now)
        cursor = self.db.execute(
            """INSERT OR IGNORE INTO crashes (crash_id, pid, app_id, session_id, crashed_session_id, game_version,
                                              signal, os, received, events, bytes, path)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (crash_id, session.pid, session.app_id, session.session_id, crashed_session_id,
             details.get("game_version"), details.get("signal"), details.get("os"), now, events, size, path))
        return cursor.rowcount == 1

    # What a player sees

    def _games(self, pids: list[str], demo_of: dict[int, int]) -> dict[str, dict[int, dict[str, Any]]]:
        """pid -> app_id -> the per-game summary both /v1/me and the lookup show: sessions,
        playtime, first and last seen (unix seconds), the countries played from, and for demos
        (GAMEDATA_DEMO_OF) which game they're the demo of and whether the player owns it (they've
        played it, or Steam said so at a demo session's start); full games with a demo say whether
        the player played it."""
        marks = ",".join("?" * len(pids))
        games: dict[str, dict[int, dict[str, Any]]] = {}
        owns: dict[tuple[str, int], bool] = {}
        for row in self.db.execute(
                f"""SELECT pid, app_id, COUNT(*) AS sessions, SUM(COALESCE(playtime_s, last_t, 0)) AS playtime_s,
                           MIN(started) AS first_seen, MAX(last_seen) AS last_seen,
                           GROUP_CONCAT(DISTINCT country) AS countries, MAX(owns_full_game) AS owns_full_game
                    FROM sessions WHERE pid IN ({marks}) GROUP BY pid, app_id ORDER BY pid, app_id""", pids):
            games.setdefault(row["pid"], {})[row["app_id"]] = {
                "app_id": row["app_id"], "sessions": row["sessions"], "playtime_s": round(row["playtime_s"] or 0),
                "first_seen": row["first_seen"], "last_seen": row["last_seen"],
                "countries": sorted(set(row["countries"].split(","))) if row["countries"] else []}
            owns[(row["pid"], row["app_id"])] = bool(row["owns_full_game"])
        demos_of = {game: demo for demo, game in demo_of.items()}
        for pid, by_app in games.items():
            for app_id, game in by_app.items():
                if app_id in demo_of:
                    full = demo_of[app_id]
                    game["demo_of"] = full
                    game["owns_game"] = full in by_app or owns[(pid, app_id)]
                if app_id in demos_of:
                    game["played_demo"] = demos_of[app_id] in by_app
        return games

    def summary(self, pid: str, demo_of: dict[int, int] | None = None) -> dict[str, Any]:
        """The /v1/me shape (without ok and signed_in): see _games for each game's fields."""
        by_app = self._games([pid], demo_of or {}).get(pid, {})
        return {"opted_out": self.opted_out(pid), "games": [by_app[app] for app in sorted(by_app)]}

    def lookup(self, pids: list[str], demo_of: dict[int, int] | None = None) -> dict[str, dict[str, Any]]:
        """For the internal lookup, per pid: {"opted_out": True} for opted-out (and anonymised)
        players, with nothing else; {"opted_out": False, "games": [...]} for players with data.
        Pids with neither are left out. Each game has _games's fields, plus the latest version,
        crash count, latest progress, latest hardware, regions and boot kinds. A few grouped
        queries for all the pids at once."""
        pids = list(dict.fromkeys(pids))
        if not pids:
            return {}
        marks = ",".join("?" * len(pids))
        db = self.db
        opted = {row[0] for row in db.execute(
            f"SELECT pid FROM players WHERE opted_out = 1 AND pid IN ({marks})", pids)}
        wanted = [pid for pid in pids if pid not in opted]
        games = self._games(wanted, demo_of or {}) if wanted else {}
        for by_app in games.values():
            for game in by_app.values():
                game.update({"last_version": None, "crashes": 0, "progress": None, "hardware": None,
                             "regions": [], "boot_kinds": {}})
        marks = ",".join("?" * len(wanted))

        def each(sql: str) -> Iterator[tuple[sqlite3.Row, dict[str, Any]]]:
            for row in db.execute(sql, wanted):
                game = games.get(row["pid"], {}).get(row["app_id"])
                if game is not None:
                    yield row, game

        def latest(sql: str) -> Iterator[tuple[sqlite3.Row, dict[str, Any]]]:
            """The rows of `sql` (which numbers them as rn per pid and game) that come first."""
            return each(f"SELECT * FROM ({sql}) WHERE rn = 1")

        if games:
            for row, game in latest(
                    f"""SELECT pid, app_id, game_version, ROW_NUMBER() OVER (
                               PARTITION BY pid, app_id ORDER BY started DESC, rowid DESC) AS rn
                        FROM sessions WHERE pid IN ({marks}) AND game_version IS NOT NULL"""):
                game["last_version"] = row["game_version"]
            for row, game in latest(
                    f"""SELECT pid, app_id, last_progress, ROW_NUMBER() OVER (
                               PARTITION BY pid, app_id ORDER BY started DESC, rowid DESC) AS rn
                        FROM sessions WHERE pid IN ({marks}) AND last_progress IS NOT NULL"""):
                game["progress"] = json.loads(row["last_progress"])
            for row, game in latest(
                    f"""SELECT *, ROW_NUMBER() OVER (
                               PARTITION BY pid, app_id ORDER BY created DESC, rowid DESC) AS rn
                        FROM hardware WHERE pid IN ({marks})"""):
                game["hardware"] = hardware_dict(row)
            for row, game in each(
                    f"""SELECT DISTINCT pid, app_id, country, region FROM sessions
                        WHERE pid IN ({marks}) AND country IS NOT NULL AND region IS NOT NULL
                        ORDER BY country, region"""):
                game["regions"].append({"country": row["country"], "region": row["region"]})
            for row, game in each(
                    f"""SELECT pid, app_id, boot_kind, COUNT(*) AS n FROM sessions
                        WHERE pid IN ({marks}) AND boot_kind IS NOT NULL GROUP BY pid, app_id, boot_kind"""):
                game["boot_kinds"][row["boot_kind"]] = row["n"]
            for row, game in each(
                    f"SELECT pid, app_id, COUNT(*) AS n FROM crashes WHERE pid IN ({marks}) GROUP BY pid, app_id"):
                game["crashes"] = row["n"]

        out: dict[str, dict[str, Any]] = {pid: {"opted_out": True} for pid in pids if pid in opted}
        for pid, by_app in games.items():
            out[pid] = {"opted_out": False, "games": [by_app[app] for app in sorted(by_app)]}
        return out

    def rows(self, table: str, pid: str) -> list[sqlite3.Row]:
        assert table in PID_TABLES
        order = {"sessions": "started", "hardware": "created", "settings": "created",
                 "batches": "session_id, seq", "crashes": "received"}[table]
        return self.db.execute(f"SELECT * FROM {table} WHERE pid = ? ORDER BY {order}", (pid,)).fetchall()

    # Anonymising

    def anonymise(self, pid: str, now: float | None = None, opt_out: bool = True) -> tuple[str, dict[str, int]]:
        """Gives every row of `pid` one new random pid, the same for all of them (so the data stays
        grouped, but nothing links it to the player any more), in one transaction. Nothing is
        deleted. (new pid, rows changed per table); the new pid is never logged or returned to
        anyone outside this process.

        opt_out=True (the player asked, on the privacy page): `pid` is marked opted out, and its
        row's times become now. opt_out=False (the automatic unlinking after GAMEDATA_LINK_MONTHS):
        the opt-out stays as it was, and the row's times become 0, because "now" would be about
        the data's last session plus GAMEDATA_LINK_MONTHS and so point back at it. Either way the
        row no longer holds the times of the player's first and last session."""
        now = int(time.time() if now is None else now)
        new = random_pid()
        counts: dict[str, int] = {}
        with self.transaction() as db:
            for table in PID_TABLES:
                counts[table] = db.execute(f"UPDATE {table} SET pid = ? WHERE pid = ?", (new, pid)).rowcount
            if opt_out:
                db.execute(
                    """INSERT INTO players (pid, opted_out, created, updated) VALUES (?, 1, ?, ?)
                       ON CONFLICT(pid) DO UPDATE SET opted_out = 1, created = excluded.created,
                                                      updated = excluded.updated""",
                    (pid, now, now))
            else:
                db.execute("UPDATE players SET created = 0, updated = 0 WHERE pid = ?", (pid,))
            # So the unlinking never picks it up again. No time here: it would match the above.
            db.execute("INSERT OR IGNORE INTO anonymised (pid) VALUES (?)", (new,))
        return new, counts

    def stale_pids(self, last_seen_before: float, limit: int = 100) -> list[str]:
        """Players whose last session ended before the cutoff and whose data still carries their
        own pid."""
        return [row[0] for row in self.db.execute(
            """SELECT pid FROM sessions WHERE pid NOT IN (SELECT pid FROM anonymised)
               GROUP BY pid HAVING MAX(last_seen) < ? LIMIT ?""", (int(last_seen_before), limit))]

    # Disk use

    def used_bytes(self) -> int:
        """The database plus the event and crash files, from the sizes in the index (no walk over
        the folders)."""
        files = self.db.execute(
            "SELECT (SELECT COALESCE(SUM(bytes), 0) FROM batches) + (SELECT COALESCE(SUM(bytes), 0) FROM crashes)"
        ).fetchone()[0]
        database = 0
        for suffix in ("", "-wal", "-shm"):
            try:
                database += (self.root / f"gamedata.db{suffix}").stat().st_size
            except FileNotFoundError:
                pass
        return files + database
