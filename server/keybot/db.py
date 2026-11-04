"""The keys, games, requests and verify links, in one SQLite file.

Key values are only ever read to send them to the person who got them; nothing here logs them.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

REASONS = ("member", "creator", "press", "manual")

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    id                INTEGER PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE COLLATE NOCASE,
    steam_app_id      INTEGER,
    created_at        TEXT NOT NULL,
    -- JSON list of Discord role ids (as strings); any one of them lets a person /claim. Empty: the
    -- MEMBER_ROLE setting decides.
    required_role_ids TEXT NOT NULL DEFAULT '[]',
    -- Keys one person can have of this game, counting every reason and earlier KeyBot claims.
    -- 0 means no limit.
    per_user_limit    INTEGER NOT NULL DEFAULT 1,
    -- 0: private, only handed out by the team (/grant, /grantrole, approved requests).
    public            INTEGER NOT NULL DEFAULT 1,
    -- The stock warning already sent since the last restock: 0 none, 1 at 10%, 2 out of keys.
    stock_warning     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS keys (
    id         INTEGER PRIMARY KEY,
    game_id    INTEGER NOT NULL REFERENCES games(id),
    -- Unique across all games: the same key must never go out twice, even if it was added twice.
    value      TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'given')),
    given_to   TEXT,           -- Discord user id
    given_at   TEXT,
    reason     TEXT CHECK (reason IN ('member', 'creator', 'press', 'manual')),
    request_id INTEGER REFERENCES requests(id),
    added_at   TEXT NOT NULL,
    added_by   TEXT
);
-- How many keys of a game one person may have is the game's per_user_limit, checked inside the
-- handout's write transaction (give_key). Databases from before limits had a unique index here
-- instead; Store drops it.
CREATE INDEX IF NOT EXISTS keys_by_user ON keys(game_id, given_to) WHERE given_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS keys_by_status ON keys(game_id, status);

CREATE TABLE IF NOT EXISTS requests (
    id               INTEGER PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('creator', 'press')),
    game_id          INTEGER NOT NULL REFERENCES games(id),
    user_id          TEXT NOT NULL,
    -- processing: an admin pressed Approve and the key is on its way (stops a double approve).
    status           TEXT NOT NULL CHECK (status IN ('open', 'processing', 'approved', 'denied')),
    created_at       TEXT NOT NULL,
    decided_at       TEXT,
    decided_by       TEXT,     -- admin's Discord user id, or 'auto'
    channel_url      TEXT,
    details          TEXT,     -- JSON: channel stats, outlet, email, why it needs a look
    admin_message_id TEXT,
    key_id           INTEGER REFERENCES keys(id)
);
CREATE INDEX IF NOT EXISTS requests_by_user ON requests(user_id, status);

-- Claims made with the old KeyBot, recorded without the key (python -m keybot.admin mark-claimed),
-- so they count towards the per-user limit.
CREATE TABLE IF NOT EXISTS prior_claims (
    id          INTEGER PRIMARY KEY,
    game_id     INTEGER NOT NULL REFERENCES games(id),
    user_id     TEXT NOT NULL,
    note        TEXT,
    recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prior_claims_by_user ON prior_claims(game_id, user_id);

-- Who can't claim, request or be granted keys: for one game, or every game (game_id NULL).
CREATE TABLE IF NOT EXISTS bans (
    id         INTEGER PRIMARY KEY,
    user_id    TEXT NOT NULL,
    game_id    INTEGER REFERENCES games(id),
    created_at TEXT NOT NULL,
    created_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS bans_once ON bans(user_id, COALESCE(game_id, 0));

CREATE TABLE IF NOT EXISTS oauth_states (
    nonce      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    game_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,  -- unix time
    used_at    TEXT
);
"""

# Columns added to games after the first release, for databases made before them. ALTER TABLE ADD
# COLUMN with a constant default keeps every existing row and fills it in.
GAME_COLUMNS = {
    "required_role_ids": "TEXT NOT NULL DEFAULT '[]'",
    "per_user_limit": "INTEGER NOT NULL DEFAULT 1",
    "public": "INTEGER NOT NULL DEFAULT 1",
    "stock_warning": "INTEGER NOT NULL DEFAULT 0",
}
SCHEMA_VERSION = 2
MAX_PER_USER_LIMIT = 300

# Stock warning levels (games.stock_warning).
STOCK_OK, STOCK_LOW, STOCK_OUT = 0, 1, 2


def stock_level(available: int, total: int) -> int:
    """STOCK_OUT at 0 left, STOCK_LOW at 10% or less of everything imported, else STOCK_OK."""
    if total <= 0:
        return STOCK_OK
    if available <= 0:
        return STOCK_OUT
    if available * 10 <= total:
        return STOCK_LOW
    return STOCK_OK


def role_ids(game: sqlite3.Row) -> list[int]:
    """The game's required roles, as ints."""
    try:
        return [int(r) for r in json.loads(game["required_role_ids"] or "[]")]
    except (ValueError, TypeError):
        return []


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True)
class Given:
    """What give_key did. status: "given" (key is the new one), "already" (they're at the game's
    per-user limit; key is their latest, if they have one here), "none" (no keys left), or
    "banned"."""

    status: str
    key_id: int | None = None
    # repr=False: printing or logging the result never shows the key.
    value: str | None = field(default=None, repr=False)


class Store:
    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # isolation_level=None: no hidden transactions; the ones below are explicit.
        self.db = sqlite3.connect(path, isolation_level=None, timeout=10)
        self.db.row_factory = sqlite3.Row
        # WAL keeps reads from waiting on writes and is safe if the process dies mid-write.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=10000")
        self.db.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """Brings a database made by an older version up to date, keeping its data."""
        if not self._needs_migration():
            return
        # Under the write lock, and checked again: another process may have just done it.
        with self.transaction() as db:
            columns = {row["name"] for row in db.execute("PRAGMA table_info(games)")}
            for name, definition in GAME_COLUMNS.items():
                if name not in columns:
                    db.execute(f"ALTER TABLE games ADD COLUMN {name} {definition}")
            # One key per game per person was a unique index; it's the per_user_limit now.
            db.execute("DROP INDEX IF EXISTS keys_one_per_user")
            db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _needs_migration(self) -> bool:
        columns = {row["name"] for row in self.db.execute("PRAGMA table_info(games)")}
        if not set(GAME_COLUMNS) <= columns:
            return True
        if self.db.execute("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'keys_one_per_user'"
                           ).fetchone():
            return True
        return self.db.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        # IMMEDIATE takes the write lock up front, so two handouts can't both read the same
        # "available" key before either marks it given.
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield self.db
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        self.db.execute("COMMIT")

    # Games

    def add_game(self, name: str, steam_app_id: int | None = None) -> tuple[sqlite3.Row, bool]:
        """Adds the game, or updates its Steam app id. (row, whether it was new)."""
        name = name.strip()
        with self.transaction() as db:
            row = db.execute("SELECT * FROM games WHERE name = ?", (name,)).fetchone()
            if row is None:
                db.execute("INSERT INTO games (name, steam_app_id, created_at) VALUES (?, ?, ?)",
                           (name, steam_app_id, now_iso()))
                created = True
            else:
                if steam_app_id is not None:
                    db.execute("UPDATE games SET steam_app_id = ? WHERE id = ?", (steam_app_id, row["id"]))
                created = False
            return db.execute("SELECT * FROM games WHERE name = ?", (name,)).fetchone(), created

    def games(self) -> list[sqlite3.Row]:
        return self.db.execute(
            """SELECT g.*, (SELECT COUNT(*) FROM keys k WHERE k.game_id = g.id AND k.status = 'available')
                      AS available
               FROM games g ORDER BY g.name"""
        ).fetchall()

    def game(self, game_id: int) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()

    def game_by_name(self, name: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM games WHERE name = ?", (name.strip(),)).fetchone()

    def update_game_settings(self, game_id: int, *, public: bool | None = None,
                             per_user_limit: int | None = None,
                             required_role_ids: list[int] | None = None) -> sqlite3.Row:
        """Changes the settings that are given (None leaves one as it is). The updated row."""
        if per_user_limit is not None and not 0 <= per_user_limit <= MAX_PER_USER_LIMIT:
            raise ValueError(f"per_user_limit must be 0 to {MAX_PER_USER_LIMIT}")
        with self.transaction() as db:
            if public is not None:
                db.execute("UPDATE games SET public = ? WHERE id = ?", (1 if public else 0, game_id))
            if per_user_limit is not None:
                db.execute("UPDATE games SET per_user_limit = ? WHERE id = ?", (per_user_limit, game_id))
            if required_role_ids is not None:
                ids = list(dict.fromkeys(str(int(r)) for r in required_role_ids))
                db.execute("UPDATE games SET required_role_ids = ? WHERE id = ?", (json.dumps(ids), game_id))
            row = db.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
        if row is None:
            raise KeyError(game_id)
        return row

    # Keys

    def add_keys(self, game_id: int, values: list[str], added_by: str | None = None) -> tuple[int, int]:
        """(added, skipped as already in the database)."""
        added = 0
        at = now_iso()
        with self.transaction() as db:
            for value in values:
                cursor = db.execute(
                    "INSERT OR IGNORE INTO keys (game_id, value, added_at, added_by) VALUES (?, ?, ?, ?)",
                    (game_id, value, at, added_by),
                )
                added += cursor.rowcount
            if added:
                # Restocked: the stock warnings can go out again when it runs low next time.
                db.execute("UPDATE games SET stock_warning = ? WHERE id = ?", (STOCK_OK, game_id))
        return added, len(values) - added

    def available_count(self, game_id: int) -> int:
        return self.db.execute(
            "SELECT COUNT(*) FROM keys WHERE game_id = ? AND status = 'available'", (game_id,)
        ).fetchone()[0]

    def total_count(self, game_id: int) -> int:
        """Every key ever imported for the game, given out or not."""
        return self.db.execute("SELECT COUNT(*) FROM keys WHERE game_id = ?", (game_id,)).fetchone()[0]

    def unclaimed_keys(self, game_id: int) -> list[str]:
        """The values of the game's keys nobody has, oldest first (for /keys export)."""
        return [row[0] for row in self.db.execute(
            "SELECT value FROM keys WHERE game_id = ? AND status = 'available' ORDER BY id", (game_id,))]

    def next_stock_warning(self, game_id: int) -> int | None:
        """The stock warning to post now (STOCK_LOW or STOCK_OUT), or None. Each level is claimed once
        until the next restock, under the write lock, so two handouts can't both post it."""
        with self.transaction() as db:
            row = db.execute("SELECT stock_warning FROM games WHERE id = ?", (game_id,)).fetchone()
            if row is None:
                return None
            available, total = db.execute(
                "SELECT SUM(status = 'available'), COUNT(*) FROM keys WHERE game_id = ?", (game_id,)
            ).fetchone()
            level = stock_level(available or 0, total or 0)
            if level <= row["stock_warning"]:
                return None
            db.execute("UPDATE games SET stock_warning = ? WHERE id = ?", (level, game_id))
            return level

    def claimable_games(self, user_id: int) -> list[sqlite3.Row]:
        """Public games with keys left, where this person isn't banned or at the per-user limit.
        Roles aren't checked here (the bot does that)."""
        user = str(user_id)
        return self.db.execute(
            """SELECT g.*, COUNT(k.id) AS available FROM games g
               JOIN keys k ON k.game_id = g.id AND k.status = 'available'
               WHERE g.public = 1
                 AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.user_id = ?
                                 AND (b.game_id IS NULL OR b.game_id = g.id))
                 AND (g.per_user_limit = 0 OR
                      (SELECT COUNT(*) FROM keys mine WHERE mine.game_id = g.id AND mine.given_to = ?)
                      + (SELECT COUNT(*) FROM prior_claims p WHERE p.game_id = g.id AND p.user_id = ?)
                      < g.per_user_limit)
               GROUP BY g.id ORDER BY g.name""",
            (user, user, user),
        ).fetchall()

    def user_key(self, game_id: int, user_id: int) -> sqlite3.Row | None:
        """Their latest key for the game, if any."""
        return self.db.execute(
            "SELECT * FROM keys WHERE game_id = ? AND given_to = ? ORDER BY id DESC LIMIT 1",
            (game_id, str(user_id))
        ).fetchone()

    def user_keys(self, user_id: int) -> list[sqlite3.Row]:
        return self.db.execute(
            """SELECT k.id, k.value, k.given_at, k.reason, k.request_id, g.name AS game, g.steam_app_id
               FROM keys k JOIN games g ON g.id = k.game_id
               WHERE k.given_to = ? ORDER BY k.given_at, k.id""",
            (str(user_id),),
        ).fetchall()

    def user_count(self, game_id: int, user_id: int) -> int:
        """Keys of this game they have, plus claims recorded from the old KeyBot."""
        return _user_count(self.db, game_id, str(user_id))

    def at_limit(self, game_id: int, user_id: int) -> bool:
        game = self.game(game_id)
        if game is None:
            return False
        limit = game["per_user_limit"]
        return bool(limit) and self.user_count(game_id, user_id) >= limit

    def give_key(self, game_id: int, user_id: int, reason: str, request_id: int | None = None) -> Given:
        """Marks one available key as theirs, all in one transaction: the ban check, the per-user
        limit and taking the key happen under one write lock, so concurrent claims can't go over it.

        The caller sends it and calls undo_give if sending fails, so a key nobody received goes
        back on the shelf.
        """
        if reason not in REASONS:
            raise ValueError(f"unknown reason {reason!r}")
        user = str(user_id)
        with self.transaction() as db:
            game = db.execute("SELECT per_user_limit FROM games WHERE id = ?", (game_id,)).fetchone()
            if game is None:
                return Given("none")
            if _banned(db, user, game_id):
                return Given("banned")
            limit = game["per_user_limit"]
            if limit and _user_count(db, game_id, user) >= limit:
                mine = db.execute(
                    "SELECT id, value FROM keys WHERE game_id = ? AND given_to = ? ORDER BY id DESC LIMIT 1",
                    (game_id, user),
                ).fetchone()
                return Given("already", mine["id"] if mine else None, mine["value"] if mine else None)
            key = db.execute(
                "SELECT id, value FROM keys WHERE game_id = ? AND status = 'available' ORDER BY id LIMIT 1",
                (game_id,),
            ).fetchone()
            if key is None:
                return Given("none")
            cursor = db.execute(
                """UPDATE keys SET status = 'given', given_to = ?, given_at = ?, reason = ?, request_id = ?
                   WHERE id = ? AND status = 'available'""",
                (user, now_iso(), reason, request_id, key["id"]),
            )
            if cursor.rowcount != 1:  # can't happen under the write lock; refuse rather than guess
                raise RuntimeError(f"key #{key['id']} changed during handout")
            return Given("given", key["id"], key["value"])

    def undo_give(self, key_id: int, user_id: int) -> bool:
        """Puts a key back when it couldn't be delivered."""
        with self.transaction() as db:
            cursor = db.execute(
                """UPDATE keys SET status = 'available', given_to = NULL, given_at = NULL, reason = NULL,
                       request_id = NULL
                   WHERE id = ? AND given_to = ? AND status = 'given'""",
                (key_id, str(user_id)),
            )
            return cursor.rowcount == 1

    def key_by_value(self, value: str) -> sqlite3.Row | None:
        """A key and its game, by the key itself (for /keys lookup)."""
        value = value.strip()
        return self.db.execute(
            """SELECT k.*, g.name AS game FROM keys k JOIN games g ON g.id = k.game_id
               WHERE k.value = ? COLLATE NOCASE ORDER BY k.value = ? DESC LIMIT 1""",
            (value, value),
        ).fetchone()

    def key_by_id(self, key_id: int) -> sqlite3.Row | None:
        return self.db.execute(
            "SELECT k.*, g.name AS game FROM keys k JOIN games g ON g.id = k.game_id WHERE k.id = ?", (key_id,)
        ).fetchone()

    def status_summary(self) -> list[sqlite3.Row]:
        return self.db.execute(
            """SELECT g.id, g.name, g.steam_app_id, g.public, g.per_user_limit,
                      SUM(k.status = 'available') AS available,
                      SUM(k.reason = 'member') AS member,
                      SUM(k.reason = 'creator') AS creator,
                      SUM(k.reason = 'press') AS press,
                      SUM(k.reason = 'manual') AS manual,
                      (SELECT COUNT(*) FROM requests r WHERE r.game_id = g.id
                          AND r.status IN ('open', 'processing')) AS open_requests,
                      (SELECT COUNT(*) FROM prior_claims p WHERE p.game_id = g.id) AS prior
               FROM games g LEFT JOIN keys k ON k.game_id = g.id
               GROUP BY g.id ORDER BY g.name"""
        ).fetchall()

    def recent_handouts(self, limit: int = 15) -> list[sqlite3.Row]:
        # No key values here: the log shows key ids only.
        return self.db.execute(
            """SELECT k.id, k.given_to, k.given_at, k.reason, k.request_id, g.name AS game
               FROM keys k JOIN games g ON g.id = k.game_id
               WHERE k.status = 'given' ORDER BY k.given_at DESC, k.id DESC LIMIT ?""",
            (limit,),
        ).fetchall()

    # Claims from the old KeyBot

    def record_prior_claim(self, game_id: int, user_id: int, note: str | None = None) -> int:
        """Records one claim made with the old KeyBot (no key value). Their count for the game after."""
        user = str(user_id)
        with self.transaction() as db:
            db.execute("INSERT INTO prior_claims (game_id, user_id, note, recorded_at) VALUES (?, ?, ?, ?)",
                       (game_id, user, note, now_iso()))
            return _user_count(db, game_id, user)

    def prior_claims(self, user_id: int) -> list[sqlite3.Row]:
        return self.db.execute(
            """SELECT p.*, g.name AS game FROM prior_claims p JOIN games g ON g.id = p.game_id
               WHERE p.user_id = ? ORDER BY p.id""",
            (str(user_id),),
        ).fetchall()

    # Bans

    def ban(self, user_id: int, game_id: int | None = None, by: str | None = None) -> bool:
        """Bans them from one game, or every game (None). False if that ban was there already."""
        with self.transaction() as db:
            cursor = db.execute(
                "INSERT OR IGNORE INTO bans (user_id, game_id, created_at, created_by) VALUES (?, ?, ?, ?)",
                (str(user_id), game_id, now_iso(), by),
            )
            return cursor.rowcount == 1

    def unban(self, user_id: int, game_id: int | None = None) -> bool:
        """Lifts that one ban (a game's, or the server-wide one). False if there wasn't one."""
        with self.transaction() as db:
            if game_id is None:
                cursor = db.execute("DELETE FROM bans WHERE user_id = ? AND game_id IS NULL", (str(user_id),))
            else:
                cursor = db.execute("DELETE FROM bans WHERE user_id = ? AND game_id = ?", (str(user_id), game_id))
            return cursor.rowcount > 0

    def is_banned(self, user_id: int, game_id: int | None = None) -> bool:
        """Banned server-wide, or (with a game) from that game."""
        return _banned(self.db, str(user_id), game_id)

    def bans(self, game_id: int | None = None) -> list[sqlite3.Row]:
        """Every ban, or (with a game) the ones that apply to it: its own and the server-wide ones."""
        if game_id is None:
            where, args = "", ()
        else:
            where, args = "WHERE b.game_id IS NULL OR b.game_id = ?", (game_id,)
        return self.db.execute(
            f"""SELECT b.*, g.name AS game FROM bans b LEFT JOIN games g ON g.id = b.game_id
                {where} ORDER BY b.game_id IS NOT NULL, g.name, b.created_at""",
            args,
        ).fetchall()

    def user_bans(self, user_id: int) -> list[sqlite3.Row]:
        return self.db.execute(
            """SELECT b.*, g.name AS game FROM bans b LEFT JOIN games g ON g.id = b.game_id
               WHERE b.user_id = ? ORDER BY b.game_id IS NOT NULL, g.name""",
            (str(user_id),),
        ).fetchall()

    # Requests

    def create_request(self, kind: str, game_id: int, user_id: int, *, status: str = "open",
                       channel_url: str | None = None, details: dict | None = None,
                       decided_by: str | None = None) -> int:
        with self.transaction() as db:
            cursor = db.execute(
                """INSERT INTO requests (kind, game_id, user_id, status, created_at, decided_at, decided_by,
                                         channel_url, details)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (kind, game_id, str(user_id), status, now_iso(),
                 now_iso() if status in ("approved", "denied") else None, decided_by,
                 channel_url, json.dumps(details or {})),
            )
            return cursor.lastrowid

    def request(self, request_id: int) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()

    def open_request_count(self, user_id: int) -> int:
        return self.db.execute(
            "SELECT COUNT(*) FROM requests WHERE user_id = ? AND status IN ('open', 'processing')",
            (str(user_id),),
        ).fetchone()[0]

    def open_request_for(self, user_id: int, game_id: int) -> sqlite3.Row | None:
        return self.db.execute(
            "SELECT * FROM requests WHERE user_id = ? AND game_id = ? AND status IN ('open', 'processing')",
            (str(user_id), game_id),
        ).fetchone()

    def start_decision(self, request_id: int) -> bool:
        """Moves an open request to processing. False if someone else got there first."""
        with self.transaction() as db:
            cursor = db.execute(
                "UPDATE requests SET status = 'processing' WHERE id = ? AND status = 'open'", (request_id,)
            )
            return cursor.rowcount == 1

    def reopen_request(self, request_id: int) -> None:
        with self.transaction() as db:
            db.execute("UPDATE requests SET status = 'open' WHERE id = ? AND status = 'processing'", (request_id,))

    def finish_request(self, request_id: int, status: str, decided_by: str, key_id: int | None = None) -> None:
        with self.transaction() as db:
            db.execute(
                "UPDATE requests SET status = ?, decided_at = ?, decided_by = ?, key_id = ? WHERE id = ?",
                (status, now_iso(), decided_by, key_id, request_id),
            )

    def set_admin_message(self, request_id: int, message_id: int) -> None:
        with self.transaction() as db:
            db.execute("UPDATE requests SET admin_message_id = ? WHERE id = ?", (str(message_id), request_id))

    def delete_request(self, request_id: int) -> None:
        with self.transaction() as db:
            db.execute("DELETE FROM requests WHERE id = ?", (request_id,))

    def recover(self) -> int:
        """At startup: approvals cut off by a restart go back to open, so they can be pressed again.
        If the key did go out, approving again just finds the key they already have."""
        with self.transaction() as db:
            return db.execute("UPDATE requests SET status = 'open' WHERE status = 'processing'").rowcount

    # Verify links

    def save_state(self, nonce: str, user_id: int, game_id: int, expires_at: int, now: int) -> None:
        with self.transaction() as db:
            # Old links are of no use to anyone; keep the table small.
            db.execute("DELETE FROM oauth_states WHERE expires_at < ?", (now - 86400,))
            db.execute(
                "INSERT INTO oauth_states (nonce, user_id, game_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                (nonce, str(user_id), game_id, now_iso(), expires_at),
            )

    def state_usable(self, nonce: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM oauth_states WHERE nonce = ? AND used_at IS NULL", (nonce,)
        ).fetchone() is not None

    def use_state(self, nonce: str) -> bool:
        """Marks the link used. False if it was already used (or never made)."""
        with self.transaction() as db:
            cursor = db.execute(
                "UPDATE oauth_states SET used_at = ? WHERE nonce = ? AND used_at IS NULL", (now_iso(), nonce)
            )
            return cursor.rowcount == 1


def _user_count(db: sqlite3.Connection, game_id: int, user: str) -> int:
    return db.execute(
        """SELECT (SELECT COUNT(*) FROM keys WHERE game_id = ? AND given_to = ?)
                + (SELECT COUNT(*) FROM prior_claims WHERE game_id = ? AND user_id = ?)""",
        (game_id, user, game_id, user),
    ).fetchone()[0]


def _banned(db: sqlite3.Connection, user: str, game_id: int | None) -> bool:
    if game_id is None:
        query, args = "SELECT 1 FROM bans WHERE user_id = ? AND game_id IS NULL", (user,)
    else:
        query, args = "SELECT 1 FROM bans WHERE user_id = ? AND (game_id IS NULL OR game_id = ?)", (user, game_id)
    return db.execute(query, args).fetchone() is not None
