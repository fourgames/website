"""Everything collected, in one SQLite file (WAL mode).

Every write is one short transaction, so a crash or restart loses at most the request in flight;
what's due next is in the apps table, so a restart carries on where it stopped.
"""

from __future__ import annotations

import json
import logging
import random
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Iterator

from . import cadence
from .engine import STRONG, Signal
from .pcgw import PageInfo
from .steam import Details, ListApp, Snapshot

log = logging.getLogger("steamdata.db")

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
) WITHOUT ROWID;

-- One row per app: the latest of everything, plus when each kind of fetch is due next.
CREATE TABLE IF NOT EXISTS apps (
    appid               INTEGER PRIMARY KEY,
    name                TEXT,
    -- game, dlc, demo, music, ...; 'game' when the app list (games only) brought it in, NULL for
    -- an app only PCGamingWiki named, until the snapshot says. Only games are collected.
    type                TEXT,
    first_seen          INTEGER NOT NULL,   -- when this collector first saw it (unix time)
    in_list             INTEGER NOT NULL DEFAULT 1,  -- 0: not in the latest full app list
    list_seen           INTEGER,            -- the last full app list it was in
    list_modified       INTEGER,            -- GetAppList's last_modified (the store data's last change)
    price_change        INTEGER,            -- GetAppList's price_change_number
    -- The latest daily snapshot (IStoreBrowseService/GetItems)
    visible             INTEGER,
    unlisted            INTEGER,
    release_ts          INTEGER,            -- Steam release date (planned, while coming soon)
    original_release_ts INTEGER,            -- the first release, for re-releases
    coming_soon         INTEGER,
    early_access        INTEGER,
    release_display     TEXT,               -- e.g. "Q3 2027", or how vague the planned date is
    is_free             INTEGER,
    reviews             INTEGER,            -- the store's review count (all languages, off-topic filtered)
    positive_pct        INTEGER,            -- % of them positive
    review_score        INTEGER,            -- 0-9, 9 = Overwhelmingly Positive
    price               INTEGER,            -- cents in the COUNTRY's currency; 0 free; NULL not sold
    price_original      INTEGER,            -- the undiscounted price, only while discounted
    discount            INTEGER,            -- percent
    developers          TEXT,               -- JSON list of names
    publishers          TEXT,               -- JSON list of names
    tags                TEXT,               -- JSON list of user-tag ids, strongest first (names in tags)
    categories          TEXT,               -- JSON list of store category ids (names in categories)
    windows             INTEGER,
    mac                 INTEGER,
    linux               INTEGER,
    deck                INTEGER,            -- Steam Deck: 0 unknown, 1 unsupported, 2 playable, 3 verified
    parent_appid        INTEGER,            -- for DLC and demos
    content_descriptors TEXT,               -- JSON list of mature-content ids
    short_description   TEXT,
    -- The monthly metadata (store appdetails)
    genres              TEXT,               -- JSON list of genre ids (names in genres)
    languages           TEXT,               -- "English*,French,..." (* = full audio)
    required_age        INTEGER,
    controller_support  TEXT,
    metacritic          INTEGER,
    achievements        INTEGER,
    dlc_count           INTEGER,
    demos               TEXT,               -- JSON list of demo appids
    release_text        TEXT,               -- the store's release date as written
    details_status      TEXT,               -- ok, or unavailable (the store had nothing for COUNTRY)
    -- Players
    players_last        INTEGER,
    players_at          INTEGER,
    players_max         INTEGER,            -- the most this collector has seen
    players_max_at      INTEGER,
    players_zero        INTEGER NOT NULL DEFAULT 0,  -- samples in a row with nobody playing
    -- 1: a strong Godot signal in engine_signals (sampled most often)
    godot               INTEGER NOT NULL DEFAULT 0,
    -- When each is due next and was last done (unix time). NULL due: not collected.
    snapshot_due        INTEGER,
    snapshot_at         INTEGER,
    players_due         INTEGER,
    details_due         INTEGER,
    details_at          INTEGER
);
CREATE INDEX IF NOT EXISTS apps_snapshot_due ON apps(snapshot_due) WHERE snapshot_due IS NOT NULL;
CREATE INDEX IF NOT EXISTS apps_players_due ON apps(players_due) WHERE players_due IS NOT NULL;
CREATE INDEX IF NOT EXISTS apps_details_due ON apps(details_due, appid DESC) WHERE details_due IS NOT NULL;
CREATE INDEX IF NOT EXISTS apps_godot ON apps(godot) WHERE godot = 1;

-- One row per game per UTC day: day = days since 1970-01-01 (date(day * 86400, 'unixepoch')).
-- Rows only for games with reviews, a price or players that day. Keyed (day, appid) so each
-- day's rows go at the end of the table and pack tightly.
CREATE TABLE IF NOT EXISTS app_daily (
    day            INTEGER NOT NULL,
    appid          INTEGER NOT NULL,
    reviews        INTEGER,
    positive_pct   INTEGER,
    review_score   INTEGER,
    price          INTEGER,
    price_original INTEGER,     -- only while discounted
    discount       INTEGER,
    players_peak   INTEGER,     -- the highest player-count sample that day
    PRIMARY KEY (day, appid)
) WITHOUT ROWID;

-- Every player-count sample.
CREATE TABLE IF NOT EXISTS players (
    appid   INTEGER NOT NULL,
    ts      INTEGER NOT NULL,
    players INTEGER NOT NULL,
    PRIMARY KEY (appid, ts)
) WITHOUT ROWID;

-- What changed on a store page, from one snapshot or metadata fetch to the next: release dates
-- moving, coming soon -> released, names, developers, tags, Steam Deck rating, leaving the store...
CREATE TABLE IF NOT EXISTS app_changes (
    id    INTEGER PRIMARY KEY,
    appid INTEGER NOT NULL,
    ts    INTEGER NOT NULL,
    field TEXT NOT NULL,
    old   TEXT,
    new   TEXT
);
CREATE INDEX IF NOT EXISTS app_changes_by_app ON app_changes(appid, ts);

-- Hints about the engine a game uses (see engine.py). strength 2: stated, 1: only mentioned.
CREATE TABLE IF NOT EXISTS engine_signals (
    appid      INTEGER NOT NULL,
    engine     TEXT NOT NULL,     -- godot, unity, unreal, ...
    source     TEXT NOT NULL,     -- pcgamingwiki, store_legal, store_text, manual
    strength   INTEGER NOT NULL,
    evidence   TEXT,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    PRIMARY KEY (appid, engine, source)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS engine_signals_by_engine ON engine_signals(engine, strength);

-- The PCGamingWiki pages linking an engine, so unchanged pages aren't fetched again.
CREATE TABLE IF NOT EXISTS pcgw_pages (
    engine     TEXT NOT NULL,
    pageid     INTEGER NOT NULL,
    title      TEXT,
    revid      INTEGER,
    appids     TEXT,              -- JSON list of Steam app ids from the infobox
    strength   INTEGER,
    evidence   TEXT,
    checked_at INTEGER,
    PRIMARY KEY (engine, pageid)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tags (tagid INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS genres (id INTEGER PRIMARY KEY, name TEXT NOT NULL);

-- Requests per UTC day and host: how close to the limits we run.
CREATE TABLE IF NOT EXISTS http_log (
    day       INTEGER NOT NULL,
    host      TEXT NOT NULL,
    ok        INTEGER NOT NULL DEFAULT 0,
    throttled INTEGER NOT NULL DEFAULT 0,
    failed    INTEGER NOT NULL DEFAULT 0,
    bytes     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, host)
) WITHOUT ROWID;
"""

# Made again at every start, so a new version's views replace the old ones.
VIEWS = """
DROP VIEW IF EXISTS daily;
CREATE VIEW daily AS
SELECT date(d.day * 86400, 'unixepoch') AS date, d.appid, a.name, d.reviews,
       CAST(round(d.reviews * d.positive_pct / 100.0) AS INTEGER) AS positive_est,
       d.reviews - CAST(round(d.reviews * d.positive_pct / 100.0) AS INTEGER) AS negative_est,
       d.positive_pct, d.review_score, d.price, COALESCE(d.price_original, d.price) AS price_base,
       d.discount, d.players_peak
FROM app_daily d LEFT JOIN apps a USING (appid);

DROP VIEW IF EXISTS player_samples;
CREATE VIEW player_samples AS
SELECT appid, datetime(ts, 'unixepoch') AS time, players FROM players;

DROP VIEW IF EXISTS godot_games;
CREATE VIEW godot_games AS
SELECT a.appid, a.name, a.type, date(a.release_ts, 'unixepoch') AS release_date, a.coming_soon,
       a.reviews, a.positive_pct, a.price, a.players_last, a.players_max,
       (SELECT group_concat(s.source, ',') FROM engine_signals s
        WHERE s.appid = a.appid AND s.engine = 'godot' AND s.strength >= 2) AS sources
FROM apps a WHERE a.godot = 1;
"""

DUE_COLUMNS = {"snapshot": "snapshot_due", "players": "players_due", "details": "details_due"}

# Snapshot fields that go into app_changes when they change (not on the first fill).
TRACKED = ("name", "visible", "unlisted", "release_ts", "coming_soon", "early_access",
           "release_display", "is_free", "developers", "publishers", "deck", "windows", "mac", "linux")


def _json(values: Iterable) -> str:
    return json.dumps(list(values), separators=(",", ":"), ensure_ascii=False)


def _ids(text: str | None) -> set:
    try:
        return set(json.loads(text or "[]"))
    except ValueError:
        return set()


class Store:
    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # isolation_level=None: no hidden transactions; the ones below are explicit.
        self.db = sqlite3.connect(path, isolation_level=None, timeout=30)
        self.db.row_factory = sqlite3.Row
        # WAL: readers (python -m steamdata.stats) never wait for the collector, and a crash
        # mid-write can't damage what's committed. FULL: each commit is on disk before we go on.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=30000")
        # Keeps the -wal file from staying big after a checkpoint.
        self.db.execute("PRAGMA journal_size_limit=67108864")
        self.db.executescript(SCHEMA)
        self.db.executescript(VIEWS)
        if self.db.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
            self.db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def close(self) -> None:
        try:
            self.db.execute("PRAGMA optimize")
        except sqlite3.Error:
            pass
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

    # Meta

    def meta(self, key: str, default: str | None = None) -> str | None:
        row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default

    def meta_float(self, key: str) -> float:
        try:
            return float(self.meta(key) or 0)
        except ValueError:
            return 0.0

    def set_meta(self, key: str, value: str | float | None) -> None:
        if value is None:
            self.db.execute("DELETE FROM meta WHERE key = ?", (key,))
        else:
            self.db.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE "
                            "SET value = excluded.value", (key, str(value)))

    def _change(self, appid: int, now: float, field: str, old, new) -> None:
        self.db.execute("INSERT INTO app_changes (appid, ts, field, old, new) VALUES (?, ?, ?, ?, ?)",
                        (appid, int(now), field, None if old is None else str(old),
                         None if new is None else str(new)))

    # The app list

    def save_list_apps(self, apps: list[ListApp], now: float, full: bool) -> int:
        """Adds the new ones, updates the rest. Returns how many were new."""
        if not apps:
            return 0
        now = int(now)
        ids = [a.appid for a in apps]
        with self.transaction() as db:
            known = {}
            for start in range(0, len(ids), 5000):
                chunk = ids[start:start + 5000]
                marks = ",".join("?" * len(chunk))
                for row in db.execute(f"SELECT appid, in_list, list_seen FROM apps WHERE appid IN ({marks})", chunk):
                    known[row["appid"]] = row
            for appid, row in known.items():
                if row["in_list"] == 0 and row["list_seen"] is not None:
                    self._change(appid, now, "in_list", 0, 1)
            db.executemany(
                """INSERT INTO apps (appid, name, type, first_seen, in_list, list_seen, list_modified,
                                     price_change, snapshot_due, details_due, godot)
                   VALUES (:appid, :name, 'game', :now, 1, :seen, :modified, :price_change, :now, 0,
                           EXISTS (SELECT 1 FROM engine_signals s WHERE s.appid = :appid
                                   AND s.engine = 'godot' AND s.strength >= 2))
                   ON CONFLICT(appid) DO UPDATE SET
                       name = COALESCE(NULLIF(apps.name, ''), excluded.name),
                       type = COALESCE(apps.type, 'game'),
                       in_list = 1,
                       list_seen = COALESCE(excluded.list_seen, apps.list_seen),
                       list_modified = excluded.list_modified,
                       price_change = excluded.price_change,
                       snapshot_due = CASE WHEN apps.type IS NULL THEN COALESCE(apps.snapshot_due, :now)
                                           ELSE apps.snapshot_due END""",
                [{"appid": a.appid, "name": a.name, "now": now, "seen": now if full else None,
                  "modified": a.last_modified, "price_change": a.price_change} for a in apps])
        return len(apps) - len(known)

    def finish_full_list(self, started: float, now: float) -> int:
        """After a complete full list: the apps that weren't in it are marked in_list = 0.
        Returns how many. Skipped if the list looks cut short (under 90% of the apps we had)."""
        started = int(started)
        seen = self.db.execute("SELECT COUNT(*) FROM apps WHERE list_seen >= ?", (started,)).fetchone()[0]
        listed = self.db.execute("SELECT COUNT(*) FROM apps WHERE in_list = 1 AND list_seen IS NOT NULL").fetchone()[0]
        if seen < 0.9 * listed:
            log.warning("the full app list had %d apps, under 90%% of the %d listed before: "
                        "not marking any as gone", seen, listed)
            return 0
        with self.transaction() as db:
            gone = [r[0] for r in db.execute(
                "SELECT appid FROM apps WHERE in_list = 1 AND list_seen IS NOT NULL AND list_seen < ?", (started,))]
            for appid in gone:
                self._change(appid, now, "in_list", 1, 0)
            db.executemany("UPDATE apps SET in_list = 0 WHERE appid = ?", [(a,) for a in gone])
        return len(gone)

    def add_stub_apps(self, appids: Iterable[int], now: float) -> int:
        """Apps known from elsewhere (PCGamingWiki) but not from the app list: the snapshot finds
        out what they are."""
        rows = [(a, int(now), int(now)) for a in set(appids)]
        with self.transaction() as db:
            before = db.total_changes
            db.executemany("INSERT OR IGNORE INTO apps (appid, first_seen, in_list, snapshot_due, details_due) "
                           "VALUES (?, ?, 0, ?, 0)", rows)
            return db.total_changes - before

    # What's due

    def due(self, lane: str, now: float, limit: int) -> list[int]:
        query = {
            "snapshot": "SELECT appid FROM apps WHERE snapshot_due <= ? ORDER BY snapshot_due, appid LIMIT ?",
            "players": "SELECT appid FROM apps WHERE players_due <= ? ORDER BY players_due LIMIT ?",
            # New apps (details_due 0) first, newest appid first.
            "details": "SELECT appid FROM apps WHERE details_due <= ? ORDER BY details_due, appid DESC LIMIT ?",
        }[lane]
        return [r[0] for r in self.db.execute(query, (int(now), limit))]

    def count_due(self, lane: str, now: float) -> int:
        column = DUE_COLUMNS[lane]
        return self.db.execute(f"SELECT COUNT(*) FROM apps WHERE {column} <= ?", (int(now),)).fetchone()[0]

    def delay(self, lane: str, appids: Iterable[int], until: float) -> None:
        """Tries these again later (after a failed request)."""
        column = DUE_COLUMNS[lane]
        with self.transaction() as db:
            db.executemany(f"UPDATE apps SET {column} = MAX({column}, ?) WHERE appid = ? AND {column} IS NOT NULL",
                           [(int(until), a) for a in appids])

    # The daily snapshot

    def save_snapshot(self, results: dict[int, Snapshot | None], now: float, rng: random.Random | None = None) -> int:
        """Writes one GetItems batch. Returns how many daily rows it wrote. (rng: unused, kept so
        every save_* takes the same arguments.)"""
        now = int(now)
        day = cadence.day_number(now)
        rows = 0
        with self.transaction() as db:
            for appid, snap in results.items():
                prev = db.execute("SELECT * FROM apps WHERE appid = ?", (appid,)).fetchone()
                if prev is None:
                    continue
                if snap is None:
                    if prev["visible"] == 1:
                        self._change(appid, now, "visible", 1, 0)
                    db.execute("UPDATE apps SET visible = 0, snapshot_at = ?, snapshot_due = ? WHERE appid = ?",
                               (now, now + cadence.HIDDEN_RETRY, appid))
                    continue
                if snap.type != "game":
                    if prev["type"] not in (None, snap.type):
                        self._change(appid, now, "type", prev["type"], snap.type)
                    db.execute("""UPDATE apps SET type = ?, name = ?, parent_appid = ?, visible = 1,
                                  snapshot_at = ?, snapshot_due = NULL, players_due = NULL, details_due = NULL
                                  WHERE appid = ?""",
                               (snap.type, snap.name or prev["name"], snap.parent_appid, now, appid))
                    continue
                rows += self._save_game_snapshot(prev, snap, now, day)
        return rows

    def _save_game_snapshot(self, prev: sqlite3.Row, snap: Snapshot, now: int, day: int) -> int:
        db, appid = self.db, snap.appid
        new = {
            "name": snap.name or prev["name"], "visible": 1, "unlisted": int(snap.unlisted),
            "release_ts": snap.release_ts, "original_release_ts": snap.original_release_ts,
            "coming_soon": int(snap.coming_soon), "early_access": int(snap.early_access),
            "release_display": snap.release_display, "is_free": int(snap.is_free),
            "reviews": snap.reviews, "positive_pct": snap.positive_pct, "review_score": snap.review_score,
            "price": snap.price, "price_original": snap.price_original, "discount": snap.discount,
            "developers": _json(snap.developers), "publishers": _json(snap.publishers),
            "tags": _json(snap.tags), "categories": _json(snap.categories),
            "windows": int(snap.windows), "mac": int(snap.mac), "linux": int(snap.linux),
            "deck": snap.deck, "parent_appid": snap.parent_appid,
            "content_descriptors": _json(snap.content_descriptors),
            "short_description": snap.short_description,
        }
        # Only changes from an earlier game snapshot count, not the first fill.
        if prev["reviews"] is not None:
            for field in TRACKED:
                if prev[field] != new[field]:
                    self._change(appid, now, field, prev[field], new[field])
            for field in ("tags", "categories"):
                old_ids, new_ids = _ids(prev[field]), set(json.loads(new[field]))
                if old_ids != new_ids:
                    self._change(appid, now, field, _json(sorted(old_ids)), _json(sorted(new_ids)))
        if prev["type"] != "game":
            if prev["type"] is not None:
                self._change(appid, now, "type", prev["type"], "game")
            new["type"] = "game"

        released_now = prev["coming_soon"] == 1 and not snap.coming_soon
        players_due = prev["players_due"]
        if snap.coming_soon:
            players_due = None
        elif players_due is None or released_now:
            players_due = now if released_now else now + cadence.first_players_delay(snap.reviews, bool(prev["godot"]))
        elif prev["players_zero"] > 0 and snap.reviews > (prev["reviews"] or 0):
            # New reviews: someone is playing, so don't wait out the zero backoff.
            players_due = min(players_due, now)
        new["players_due"] = players_due
        if released_now or (prev["type"] != "game" and prev["details_due"] is None):
            new["details_due"] = now
        new["snapshot_at"] = now
        new["snapshot_due"] = cadence.next_snapshot(now)
        sets = ", ".join(f"{k} = :{k}" for k in new)
        db.execute(f"UPDATE apps SET {sets} WHERE appid = :appid", {**new, "appid": appid})

        if snap.reviews or snap.price is not None:
            db.execute(
                """INSERT INTO app_daily (day, appid, reviews, positive_pct, review_score, price,
                                          price_original, discount)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(day, appid) DO UPDATE SET reviews = excluded.reviews,
                       positive_pct = excluded.positive_pct, review_score = excluded.review_score,
                       price = excluded.price, price_original = excluded.price_original,
                       discount = excluded.discount""",
                (day, appid, snap.reviews, snap.positive_pct, snap.review_score, snap.price,
                 snap.price_original, snap.discount))
            return 1
        return 0

    # Players

    def save_players(self, appid: int, count: int | None, now: float, rng: random.Random) -> int:
        """Records one sample and schedules the next. Returns the seconds until it."""
        now = int(now)
        day = cadence.day_number(now)
        with self.transaction() as db:
            prev = db.execute("SELECT godot, players_zero, release_ts, coming_soon FROM apps WHERE appid = ?",
                              (appid,)).fetchone()
            if prev is None:
                return 0
            zeros = 0 if count else prev["players_zero"] + 1
            released = None
            if prev["release_ts"] and not prev["coming_soon"]:
                released = (now - prev["release_ts"]) / cadence.DAY
            interval = cadence.players_interval(count, zeros, bool(prev["godot"]), released, rng)
            if count is not None:
                db.execute("INSERT OR REPLACE INTO players (appid, ts, players) VALUES (?, ?, ?)",
                           (appid, now, count))
            if count:
                db.execute("""INSERT INTO app_daily (day, appid, players_peak) VALUES (?, ?, ?)
                              ON CONFLICT(day, appid) DO UPDATE SET
                                  players_peak = MAX(COALESCE(players_peak, 0), excluded.players_peak)""",
                           (day, appid, count))
            elif count == 0:
                db.execute("UPDATE app_daily SET players_peak = COALESCE(players_peak, 0) WHERE day = ? AND appid = ?",
                           (day, appid))
            db.execute("""UPDATE apps SET players_last = :count, players_at = :now, players_zero = :zeros,
                              players_due = :due,
                              players_max_at = CASE WHEN COALESCE(:count, -1) > COALESCE(players_max, -1)
                                                    THEN :now ELSE players_max_at END,
                              players_max = MAX(COALESCE(players_max, 0), COALESCE(:count, 0))
                          WHERE appid = :appid""",
                       {"count": count, "now": now, "zeros": zeros, "due": now + interval, "appid": appid})
            return interval

    # The monthly metadata

    def save_details(self, appid: int, details: Details | None, signals: list[Signal], now: float,
                     rng: random.Random, days: int) -> None:
        now = int(now)
        due = cadence.next_details(now, days, rng)
        with self.transaction() as db:
            prev = db.execute("SELECT * FROM apps WHERE appid = ?", (appid,)).fetchone()
            if prev is None:
                return
            if details is None:
                db.execute("UPDATE apps SET details_status = 'unavailable', details_at = ?, details_due = ? "
                           "WHERE appid = ?", (now, due, appid))
                return
            if details.type != "game":
                if prev["type"] not in (None, details.type):
                    self._change(appid, now, "type", prev["type"], details.type)
                db.execute("""UPDATE apps SET type = ?, details_status = 'ok', details_at = ?,
                              snapshot_due = NULL, players_due = NULL, details_due = NULL WHERE appid = ?""",
                           (details.type, now, appid))
                return
            genres = _json(sorted(g for g, _ in details.genres))
            if prev["details_at"] is not None:
                if _ids(prev["genres"]) != set(json.loads(genres)):
                    self._change(appid, now, "genres", prev["genres"], genres)
                if (prev["languages"] or "") != details.languages:
                    self._change(appid, now, "languages", prev["languages"], details.languages)
            db.execute(
                """UPDATE apps SET name = COALESCE(NULLIF(name, ''), :name), genres = :genres,
                       languages = :languages, required_age = :required_age,
                       controller_support = :controller_support, metacritic = :metacritic,
                       achievements = :achievements, dlc_count = :dlc_count, demos = :demos,
                       release_text = :release_text, details_status = 'ok', details_at = :now,
                       details_due = :due
                   WHERE appid = :appid""",
                {"name": details.name, "genres": genres, "languages": details.languages,
                 "required_age": details.required_age, "controller_support": details.controller_support,
                 "metacritic": details.metacritic, "achievements": details.achievements,
                 "dlc_count": details.dlc_count, "demos": _json(details.demos),
                 "release_text": details.release_text, "now": now, "due": due, "appid": appid})
            db.executemany("INSERT INTO genres (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
                           [g for g in details.genres if g[1]])
            db.executemany("INSERT INTO categories (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
                           [c for c in details.categories if c[1]])
            self._replace_signals(appid, ("store_legal", "store_text"), signals, now)
        self.refresh_godot([appid], now)

    # Engine signals

    def _replace_signals(self, appid: int, sources: tuple[str, ...], signals: list[Signal], now: int) -> None:
        keep = {(s.engine, s.source) for s in signals}
        for row in self.db.execute(
                f"SELECT engine, source FROM engine_signals WHERE appid = ? AND source IN ({','.join('?' * len(sources))})",
                (appid, *sources)).fetchall():
            if (row["engine"], row["source"]) not in keep:
                self.db.execute("DELETE FROM engine_signals WHERE appid = ? AND engine = ? AND source = ?",
                                (appid, row["engine"], row["source"]))
        for s in signals:
            self._upsert_signal(appid, s, now)

    def _upsert_signal(self, appid: int, s: Signal, now: int) -> None:
        self.db.execute(
            """INSERT INTO engine_signals (appid, engine, source, strength, evidence, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(appid, engine, source) DO UPDATE SET strength = excluded.strength,
                   evidence = excluded.evidence, last_seen = excluded.last_seen""",
            (appid, s.engine, s.source, s.strength, s.evidence, now, now))

    def add_manual_signal(self, appid: int, engine: str, evidence: str, now: float) -> None:
        with self.transaction():
            self._upsert_signal(appid, Signal(engine, "manual", STRONG, evidence), int(now))
        self.refresh_godot([appid], now)

    def refresh_godot(self, appids: list[int] | None, now: float) -> int:
        """Sets apps.godot from engine_signals. A game that just joined the Godot set gets its next
        player sample within the hour. Returns how many apps changed."""
        strong = ("EXISTS (SELECT 1 FROM engine_signals s WHERE s.appid = apps.appid "
                  "AND s.engine = 'godot' AND s.strength >= 2)")
        where, args = "", []
        if appids is not None:
            if not appids:
                return 0
            where, args = f" AND appid IN ({','.join('?' * len(appids))})", list(appids)
        with self.transaction() as db:
            joined = [r[0] for r in db.execute(f"SELECT appid FROM apps WHERE godot = 0 AND {strong}{where}", args)]
            before = db.total_changes
            db.execute(f"UPDATE apps SET godot = {strong} WHERE godot != {strong}{where}", args)
            changed = db.total_changes - before
            # The Godot pace (at most hourly) starts now: an hour after the last sample, or now.
            db.executemany("""UPDATE apps SET players_due = MIN(players_due, MAX(?, COALESCE(players_at, 0) + ?))
                              WHERE appid = ? AND players_due IS NOT NULL""",
                           [(int(now), cadence.HOUR, a) for a in joined])
        return changed

    # PCGamingWiki

    def pcgw_revisions(self, engine: str) -> dict[int, int]:
        return {r[0]: r[1] for r in self.db.execute("SELECT pageid, revid FROM pcgw_pages WHERE engine = ?", (engine,))}

    def save_pcgw_pages(self, engine: str, pages: list[PageInfo], now: float) -> None:
        with self.transaction() as db:
            db.executemany(
                """INSERT INTO pcgw_pages (engine, pageid, title, revid, appids, strength, evidence, checked_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(engine, pageid) DO UPDATE SET title = excluded.title, revid = excluded.revid,
                       appids = excluded.appids, strength = excluded.strength, evidence = excluded.evidence,
                       checked_at = excluded.checked_at""",
                [(engine, p.pageid, p.title, p.revid, _json(p.appids), p.strength, p.evidence, int(now))
                 for p in pages])

    def finish_pcgw(self, engine: str, linked: set[int], now: float) -> dict[str, int]:
        """After a complete PCGamingWiki pass: forgets pages that no longer link the engine, makes
        engine_signals (source pcgamingwiki) match the pages, adds apps we didn't know, and updates
        the Godot set."""
        now = int(now)
        with self.transaction() as db:
            stored = [r[0] for r in db.execute("SELECT pageid FROM pcgw_pages WHERE engine = ?", (engine,))]
            db.executemany("DELETE FROM pcgw_pages WHERE engine = ? AND pageid = ?",
                           [(engine, p) for p in stored if p not in linked])
            best: dict[int, tuple[int, str]] = {}
            for row in db.execute("SELECT appids, strength, evidence FROM pcgw_pages WHERE engine = ?", (engine,)):
                for appid in _ids(row["appids"]):
                    if appid not in best or row["strength"] > best[appid][0]:
                        best[appid] = (row["strength"], row["evidence"])
            had = {r[0] for r in db.execute(
                "SELECT appid FROM engine_signals WHERE source = 'pcgamingwiki' AND engine = ?", (engine,))}
            db.executemany("DELETE FROM engine_signals WHERE appid = ? AND engine = ? AND source = 'pcgamingwiki'",
                           [(a, engine) for a in had - set(best)])
            for appid, (strength, evidence) in best.items():
                self._upsert_signal(appid, Signal(engine, "pcgamingwiki", strength, evidence), now)
        added = self.add_stub_apps([a for a, (s, _) in best.items() if s >= STRONG], now)
        changed = self.refresh_godot(None, now)
        return {"games": len(best), "strong": sum(1 for s, _ in best.values() if s >= STRONG),
                "removed": len(had - set(best)), "new_apps": added, "godot_changed": changed}

    # Tags, the request log, upkeep

    def save_tags(self, tags: list[tuple[int, str]]) -> None:
        with self.transaction() as db:
            db.executemany("INSERT INTO tags (tagid, name) VALUES (?, ?) ON CONFLICT(tagid) DO UPDATE "
                           "SET name = excluded.name", tags)

    def add_http_counts(self, day: int, counts: dict) -> None:
        if not counts:
            return
        with self.transaction() as db:
            db.executemany(
                """INSERT INTO http_log (day, host, ok, throttled, failed, bytes) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(day, host) DO UPDATE SET ok = ok + excluded.ok,
                       throttled = throttled + excluded.throttled, failed = failed + excluded.failed,
                       bytes = bytes + excluded.bytes""",
                [(day, host, c["ok"], c["throttled"], c["failed"], c["bytes"]) for host, c in counts.items()])

    def prune_samples(self, before: float) -> int:
        with self.transaction() as db:
            before_changes = db.total_changes
            db.execute("DELETE FROM players WHERE ts < ?", (int(before),))
            return db.total_changes - before_changes

    def optimize(self) -> None:
        self.db.execute("PRAGMA optimize")
