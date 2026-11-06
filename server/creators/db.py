"""The creators database: one SQLite file with the YouTube channels found and the videos that found them."""

from __future__ import annotations

import json
import sqlite3
from typing import Iterable

SCHEMA = """
-- One row per YouTube channel that has made a video of a game on Steam.
CREATE TABLE IF NOT EXISTS youtube_channels (
    channel_id      TEXT PRIMARY KEY,
    title           TEXT,
    handle          TEXT,               -- e.g. @somecreator
    description     TEXT,
    country         TEXT,               -- the channel's own setting, often empty
    language        TEXT,               -- the channel's default language, often empty
    subscribers     INTEGER,            -- NULL when hidden
    videos          INTEGER,
    views           INTEGER,
    created         INTEGER,            -- unix time
    emails          TEXT,               -- JSON list found in the description
    links           TEXT,               -- JSON {"twitch": "...", "x": "...", ...} from the description
    -- The email behind YouTube's "View email address" button, saved by hand (the Chrome skill).
    revealed_email  TEXT,
    revealed_at     INTEGER,            -- when it was looked at (also when nothing was there)
    email_button    INTEGER,            -- the About panel has a "View email address" button: 1 yes, 0 no, NULL not checked
    button_checked_at INTEGER,          -- when that was checked
    first_seen      INTEGER NOT NULL,
    refreshed_at    INTEGER,            -- when the numbers above were last read; NULL: not yet
    gone            INTEGER NOT NULL DEFAULT 0   -- the API no longer finds it
);

-- Every video that names a game we searched for. One video can name several games.
CREATE TABLE IF NOT EXISTS youtube_videos (
    video_id    TEXT NOT NULL,
    appid       INTEGER NOT NULL,
    channel_id  TEXT NOT NULL,
    title       TEXT,
    published   INTEGER,
    views       INTEGER,
    likes       INTEGER,
    comments    INTEGER,
    duration    INTEGER,                -- seconds
    language    TEXT,                   -- the video's audio or default language, when set
    found_at    INTEGER NOT NULL,
    PRIMARY KEY (video_id, appid)
);
CREATE INDEX IF NOT EXISTS youtube_videos_channel ON youtube_videos (channel_id);
CREATE INDEX IF NOT EXISTS youtube_videos_app ON youtube_videos (appid);

-- Which games were searched, and when each is due again.
CREATE TABLE IF NOT EXISTS searches (
    appid       INTEGER PRIMARY KEY,
    name        TEXT,
    searched_at INTEGER,
    due_at      INTEGER NOT NULL,
    results     INTEGER NOT NULL DEFAULT 0,  -- videos YouTube returned, all searches together
    kept        INTEGER NOT NULL DEFAULT 0   -- of those, the ones that really name the game
);

-- YouTube API units spent per quota day (Pacific date).
CREATE TABLE IF NOT EXISTS quota (
    day        TEXT PRIMARY KEY,
    units      INTEGER NOT NULL DEFAULT 0,
    exhausted  INTEGER NOT NULL DEFAULT 0       -- YouTube said the quota is used up
);

-- Web pages a channel links to (its description and its About panel's links), followed for emails.
CREATE TABLE IF NOT EXISTS channel_links (
    channel_id  TEXT NOT NULL,
    url         TEXT NOT NULL,
    source      TEXT NOT NULL,          -- 'description' or 'about'
    PRIMARY KEY (channel_id, url)
);
CREATE INDEX IF NOT EXISTS channel_links_url ON channel_links (url);

-- Each followed page: when, how it went, and the emails on it (and on its contact page).
CREATE TABLE IF NOT EXISTS sites (
    url         TEXT PRIMARY KEY,
    fetched_at  INTEGER NOT NULL,
    status      TEXT NOT NULL,          -- 'ok', 'skipped' (not a page that could have an email), or the error
    emails      TEXT                    -- JSON list
);

-- Emails found by following a channel's links.
CREATE VIEW IF NOT EXISTS site_emails AS
    SELECT DISTINCT l.channel_id, e.value AS email, l.url
    FROM channel_links l JOIN sites s ON s.url = l.url, json_each(s.emails) e
    WHERE s.emails IS NOT NULL AND s.emails != '[]';

-- Per channel and game: how many videos, the latest, their views.
CREATE VIEW IF NOT EXISTS channel_games AS
    SELECT channel_id, appid, COUNT(*) AS videos, MAX(published) AS last_video, SUM(views) AS views
    FROM youtube_videos GROUP BY channel_id, appid;
"""


class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)
        columns = {r[1] for r in self.db.execute("PRAGMA table_info(youtube_channels)")}
        for name in ("email_button", "button_checked_at"):  # added after the first databases were made
            if name not in columns:
                self.db.execute(f"ALTER TABLE youtube_channels ADD COLUMN {name} INTEGER")

    def close(self) -> None:
        self.db.close()

    # Quota
    def units_spent(self, day: str) -> tuple[int, bool]:
        row = self.db.execute("SELECT units, exhausted FROM quota WHERE day = ?", (day,)).fetchone()
        return (row["units"], bool(row["exhausted"])) if row else (0, False)

    def spend(self, day: str, units: int, exhausted: bool = False) -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO quota (day, units, exhausted) VALUES (?, ?, ?)
                   ON CONFLICT(day) DO UPDATE SET units = units + excluded.units,
                                                  exhausted = MAX(exhausted, excluded.exhausted)""",
                (day, units, int(exhausted)))

    # Searches
    def searches(self) -> dict[int, sqlite3.Row]:
        return {r["appid"]: r for r in self.db.execute("SELECT * FROM searches")}

    def searched(self, appid: int, name: str, now: int, due_at: int, results: int, kept: int) -> None:
        with self.db:
            self.db.execute(
                """INSERT INTO searches (appid, name, searched_at, due_at, results, kept)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(appid) DO UPDATE SET name = excluded.name, searched_at = excluded.searched_at,
                       due_at = excluded.due_at, results = results + excluded.results, kept = kept + excluded.kept""",
                (appid, name, now, due_at, results, kept))

    # Videos and channels
    def save_videos(self, rows: Iterable[dict], now: int) -> int:
        """Adds or updates videos; new channels get a stub row to be filled in. Returns new videos."""
        rows = list(rows)
        new = 0
        with self.db:
            for r in rows:
                self.db.execute("INSERT OR IGNORE INTO youtube_channels (channel_id, title, first_seen) VALUES (?, ?, ?)",
                                (r["channel_id"], r.get("channel_title"), now))
                new += self.db.execute("SELECT 1 FROM youtube_videos WHERE video_id = ? AND appid = ?",
                                       (r["video_id"], r["appid"])).fetchone() is None
                self.db.execute(
                    """INSERT INTO youtube_videos (video_id, appid, channel_id, title, published, views, likes,
                                                   comments, duration, language, found_at)
                       VALUES (:video_id, :appid, :channel_id, :title, :published, :views, :likes, :comments,
                               :duration, :language, :now)
                       ON CONFLICT(video_id, appid) DO UPDATE SET views = excluded.views, likes = excluded.likes,
                           comments = excluded.comments, title = excluded.title""",
                    {**{k: r.get(k) for k in ("video_id", "appid", "channel_id", "title", "published", "views",
                                              "likes", "comments", "duration", "language")}, "now": now})
        return new

    def channels_to_refresh(self, now: int, refresh_days: int, limit: int) -> list[str]:
        """Channels never read first, then the stalest."""
        return [r[0] for r in self.db.execute(
            """SELECT channel_id FROM youtube_channels
               WHERE gone = 0 AND (refreshed_at IS NULL OR refreshed_at < ?)
               ORDER BY refreshed_at IS NOT NULL, refreshed_at LIMIT ?""",
            (now - refresh_days * 86400, limit))]

    def save_channels(self, rows: Iterable[dict], asked: Iterable[str], now: int) -> None:
        rows = list(rows)
        found = {r["channel_id"] for r in rows}
        with self.db:
            for r in rows:
                self.db.execute(
                    """UPDATE youtube_channels SET title = :title, handle = :handle, description = :description,
                           country = :country, language = :language, subscribers = :subscribers, videos = :videos,
                           views = :views, created = :created, emails = :emails, links = :links,
                           refreshed_at = :now, gone = 0
                       WHERE channel_id = :channel_id""",
                    {**r, "emails": json.dumps(r["emails"]), "links": json.dumps(r["links"]), "now": now})
            for channel_id in set(asked) - found:
                self.db.execute("UPDATE youtube_channels SET gone = 1, refreshed_at = ? WHERE channel_id = ?",
                                (now, channel_id))
