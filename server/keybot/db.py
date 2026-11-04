"""The keys, games, requests and verify links, in one SQLite file.

Key values are only ever read to send them to the person who got them; nothing here logs them.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

REASONS = ("member", "creator", "press", "manual")

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    steam_app_id INTEGER,
    created_at   TEXT NOT NULL
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
-- One key per game per person, whatever the reason, and for good: the database itself refuses a
-- second one, so no code path can get it wrong.
CREATE UNIQUE INDEX IF NOT EXISTS keys_one_per_user ON keys(game_id, given_to) WHERE given_to IS NOT NULL;
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

CREATE TABLE IF NOT EXISTS oauth_states (
    nonce      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    game_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,  -- unix time
    used_at    TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True)
class Given:
    """What give_key did. status: "given" (key is the new one), "already" (key is the one they
    had), or "none" (no keys left)."""

    status: str
    key_id: int | None = None
    value: str | None = None


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
        return added, len(values) - added

    def available_count(self, game_id: int) -> int:
        return self.db.execute(
            "SELECT COUNT(*) FROM keys WHERE game_id = ? AND status = 'available'", (game_id,)
        ).fetchone()[0]

    def claimable_games(self, user_id: int) -> list[sqlite3.Row]:
        """Games with keys left that this person hasn't had a key for."""
        return self.db.execute(
            """SELECT g.*, COUNT(k.id) AS available FROM games g
               JOIN keys k ON k.game_id = g.id AND k.status = 'available'
               WHERE NOT EXISTS (SELECT 1 FROM keys mine WHERE mine.game_id = g.id AND mine.given_to = ?)
               GROUP BY g.id ORDER BY g.name""",
            (str(user_id),),
        ).fetchall()

    def user_key(self, game_id: int, user_id: int) -> sqlite3.Row | None:
        return self.db.execute(
            "SELECT * FROM keys WHERE game_id = ? AND given_to = ?", (game_id, str(user_id))
        ).fetchone()

    def user_keys(self, user_id: int) -> list[sqlite3.Row]:
        return self.db.execute(
            """SELECT k.id, k.value, k.given_at, k.reason, g.name AS game, g.steam_app_id
               FROM keys k JOIN games g ON g.id = k.game_id
               WHERE k.given_to = ? ORDER BY k.given_at""",
            (str(user_id),),
        ).fetchall()

    def give_key(self, game_id: int, user_id: int, reason: str, request_id: int | None = None) -> Given:
        """Marks one available key as theirs, all in one transaction.

        The caller sends it and calls undo_give if sending fails, so a key nobody received goes
        back on the shelf.
        """
        if reason not in REASONS:
            raise ValueError(f"unknown reason {reason!r}")
        user = str(user_id)
        try:
            with self.transaction() as db:
                mine = db.execute(
                    "SELECT id, value FROM keys WHERE game_id = ? AND given_to = ?", (game_id, user)
                ).fetchone()
                if mine:
                    return Given("already", mine["id"], mine["value"])
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
        except sqlite3.IntegrityError:
            # The one-per-user index caught a second key for the same person (another process).
            mine = self.user_key(game_id, user_id)
            return Given("already", mine["id"] if mine else None, mine["value"] if mine else None)

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

    def status_summary(self) -> list[sqlite3.Row]:
        return self.db.execute(
            """SELECT g.id, g.name, g.steam_app_id,
                      SUM(k.status = 'available') AS available,
                      SUM(k.reason = 'member') AS member,
                      SUM(k.reason = 'creator') AS creator,
                      SUM(k.reason = 'press') AS press,
                      SUM(k.reason = 'manual') AS manual,
                      (SELECT COUNT(*) FROM requests r WHERE r.game_id = g.id
                          AND r.status IN ('open', 'processing')) AS open_requests
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
