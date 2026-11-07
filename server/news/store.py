"""The list itself: one SQLite file (NEWS_DIR/news.db), plus stats.json for the dashboard.

A signup is stored unconfirmed with the hash of its confirm token. Only the confirm link (a
button press on the page it opens) makes it count. Unconfirmed signups are deleted after
PENDING_DAYS, and unsubscribing deletes the row, so the list only ever holds people who said yes.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timezone

# How long a confirm link works, and how long an unconfirmed address is kept.
PENDING_DAYS = 7
# Confirm emails to one unconfirmed address: at most this many, this far apart. Someone retrying
# because the first one went to spam gets another; someone typing a stranger's address over and
# over doesn't flood them.
MAX_CONFIRM_MAILS = 3
RESEND_AFTER = 15 * 60
# Daily counts kept for the dashboard.
KEEP_DAYS = 400

SCHEMA = """
CREATE TABLE IF NOT EXISTS subscribers (
    email TEXT PRIMARY KEY,           -- lower case
    lang TEXT NOT NULL,               -- the site language they signed up in
    created REAL NOT NULL,
    confirmed REAL,                   -- NULL until they press the confirm button
    confirm_hash TEXT UNIQUE,         -- sha256 of the confirm token; NULL once confirmed
    unsub_token TEXT NOT NULL UNIQUE, -- goes in every email's unsubscribe link
    mails INTEGER NOT NULL DEFAULT 0, -- confirm emails sent while unconfirmed
    last_mail REAL
);
CREATE TABLE IF NOT EXISTS daily (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,               -- signup, mail, confirmed, unsubscribed
    n INTEGER NOT NULL,
    PRIMARY KEY (day, kind)
);
"""


# The codes in the email links (news.fourgames.se/c/<code>): 10 letters and digits, about 59 bits,
# far past guessing with the rate limits; no look-alike characters (0/O, 1/l/I).
CODE_CHARS = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"


def short_token() -> str:
    return "".join(secrets.choice(CODE_CHARS) for _ in range(10))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def day_of(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")


@dataclass(frozen=True)
class Pending:
    """A confirm email about to go out. Saved only once it's sent."""
    email: str
    lang: str
    confirm_token: str
    unsub_token: str
    new: bool


class Store:
    def __init__(self, data_dir: str, clock=time.time):
        os.makedirs(data_dir, exist_ok=True)
        self.data_dir = data_dir
        self.clock = clock
        self.db = sqlite3.connect(os.path.join(data_dir, "news.db"), isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    def _count(self, kind: str, now: float) -> None:
        self.db.execute("INSERT INTO daily (day, kind, n) VALUES (?, ?, 1) "
                        "ON CONFLICT (day, kind) DO UPDATE SET n = n + 1", (day_of(now), kind))

    def cleanup(self) -> int:
        """Deletes unconfirmed signups older than PENDING_DAYS, and old daily counts."""
        now = self.clock()
        gone = self.db.execute("DELETE FROM subscribers WHERE confirmed IS NULL AND created < ?",
                               (now - PENDING_DAYS * 86400,)).rowcount
        self.db.execute("DELETE FROM daily WHERE day < ?", (day_of(now - KEEP_DAYS * 86400),))
        return gone

    def mails_today(self) -> int:
        row = self.db.execute("SELECT n FROM daily WHERE day = ? AND kind = 'mail'", (day_of(self.clock()),)).fetchone()
        return row["n"] if row else 0

    def prepare(self, email: str, lang: str) -> Pending | None:
        """The confirm email to send for a signup, or None when there's nothing to send: already
        confirmed, or this unconfirmed address got one recently or enough already."""
        self.cleanup()
        now = self.clock()
        key = email.lower()
        row = self.db.execute("SELECT * FROM subscribers WHERE email = ?", (key,)).fetchone()
        if row is None:
            return Pending(key, lang, short_token(), short_token(), new=True)
        if row["confirmed"] is not None:
            return None
        if row["mails"] >= MAX_CONFIRM_MAILS or (row["last_mail"] or 0) > now - RESEND_AFTER:
            return None
        return Pending(key, lang, short_token(), row["unsub_token"], new=False)

    def sent(self, p: Pending) -> None:
        """Records a confirm email that went out. A resend replaces the old link."""
        now = self.clock()
        if p.new:
            self.db.execute("INSERT OR REPLACE INTO subscribers (email, lang, created, confirm_hash, unsub_token, mails, last_mail) "
                            "VALUES (?, ?, ?, ?, ?, 1, ?)", (p.email, p.lang, now, token_hash(p.confirm_token), p.unsub_token, now))
            self._count("signup", now)
        else:
            self.db.execute("UPDATE subscribers SET lang = ?, confirm_hash = ?, mails = mails + 1, last_mail = ? WHERE email = ?",
                            (p.lang, token_hash(p.confirm_token), now, p.email))
        self._count("mail", now)
        self.write_stats()

    def pending_lang(self, token: str) -> str | None:
        """The language of the unconfirmed signup this confirm token belongs to, or None."""
        self.cleanup()
        row = self.db.execute("SELECT lang FROM subscribers WHERE confirm_hash = ? AND confirmed IS NULL",
                              (token_hash(token),)).fetchone()
        return row["lang"] if row else None

    def confirm(self, token: str) -> str | None:
        """Confirms the signup; its language, or None when the link is unknown, used or expired."""
        lang = self.pending_lang(token)
        if lang is None:
            return None
        now = self.clock()
        self.db.execute("UPDATE subscribers SET confirmed = ?, confirm_hash = NULL WHERE confirm_hash = ?",
                        (now, token_hash(token)))
        self._count("confirmed", now)
        self.write_stats()
        return lang

    def lang_of(self, unsub_token: str) -> str | None:
        row = self.db.execute("SELECT lang FROM subscribers WHERE unsub_token = ?", (unsub_token,)).fetchone()
        return row["lang"] if row else None

    def unsubscribe(self, unsub_token: str) -> bool:
        """Deletes the address. False when it isn't on the list (any more)."""
        row = self.db.execute("DELETE FROM subscribers WHERE unsub_token = ? RETURNING confirmed", (unsub_token,)).fetchone()
        if row is None:
            return False
        if row["confirmed"] is not None:
            self._count("unsubscribed", self.clock())
        self.write_stats()
        return True

    def confirmed_emails(self) -> list[tuple[str, str, str]]:
        """(email, lang, unsub_token) of everyone confirmed, for a future send."""
        return [tuple(r) for r in self.db.execute(
            "SELECT email, lang, unsub_token FROM subscribers WHERE confirmed IS NOT NULL ORDER BY confirmed")]

    def stats(self) -> dict:
        """Numbers only, never an address: what the dashboard shows."""
        confirmed, pending = self.db.execute(
            "SELECT COUNT(confirmed), COUNT(*) - COUNT(confirmed) FROM subscribers").fetchone()
        days: dict[str, dict[str, int]] = {}
        for r in self.db.execute("SELECT day, kind, n FROM daily WHERE kind != 'mail' ORDER BY day"):
            days.setdefault(r["day"], {})[r["kind"]] = r["n"]
        by_lang = {r["lang"]: r["n"] for r in self.db.execute(
            "SELECT lang, COUNT(*) AS n FROM subscribers WHERE confirmed IS NOT NULL GROUP BY lang")}
        return {"generated": datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(timespec="seconds"),
                "confirmed": confirmed, "pending": pending, "languages": by_lang, "days": days}

    def write_stats(self) -> None:
        path = os.path.join(self.data_dir, "stats.json")
        with open(path + ".tmp", "w") as f:
            json.dump(self.stats(), f)
        os.replace(path + ".tmp", path)
