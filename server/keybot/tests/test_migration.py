"""A database made by the first version of the bot opens with the new settings and keeps its data."""

import sqlite3

from keybot.db import SCHEMA_VERSION, Store, role_ids

# The first release's schema, as it was.
OLD_SCHEMA = """
CREATE TABLE games (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    steam_app_id INTEGER,
    created_at   TEXT NOT NULL
);
CREATE TABLE keys (
    id         INTEGER PRIMARY KEY,
    game_id    INTEGER NOT NULL REFERENCES games(id),
    value      TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'given')),
    given_to   TEXT,
    given_at   TEXT,
    reason     TEXT CHECK (reason IN ('member', 'creator', 'press', 'manual')),
    request_id INTEGER REFERENCES requests(id),
    added_at   TEXT NOT NULL,
    added_by   TEXT
);
CREATE UNIQUE INDEX keys_one_per_user ON keys(game_id, given_to) WHERE given_to IS NOT NULL;
CREATE INDEX keys_by_status ON keys(game_id, status);
CREATE TABLE requests (
    id               INTEGER PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('creator', 'press')),
    game_id          INTEGER NOT NULL REFERENCES games(id),
    user_id          TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('open', 'processing', 'approved', 'denied')),
    created_at       TEXT NOT NULL,
    decided_at       TEXT,
    decided_by       TEXT,
    channel_url      TEXT,
    details          TEXT,
    admin_message_id TEXT,
    key_id           INTEGER REFERENCES keys(id)
);
CREATE INDEX requests_by_user ON requests(user_id, status);
CREATE TABLE oauth_states (
    nonce      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    game_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    TEXT
);
"""


def make_old_db(path):
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(OLD_SCHEMA)
    db.execute("INSERT INTO games (id, name, steam_app_id, created_at) VALUES (1, 'Old Game', 5, '2026-11-01')")
    db.executemany("INSERT INTO keys (game_id, value, added_at) VALUES (1, ?, '2026-11-01')",
                   [("OLD01-AAAAA-BBBBB",), ("OLD02-AAAAA-BBBBB",), ("OLD03-AAAAA-BBBBB",)])
    db.execute("UPDATE keys SET status='given', given_to='77', given_at='2026-11-02', reason='member' WHERE id=1")
    db.execute("INSERT INTO requests (kind, game_id, user_id, status, created_at) "
               "VALUES ('press', 1, '88', 'open', '2026-11-02')")
    db.commit()
    db.close()


def test_old_database_is_migrated_in_place(tmp_path):
    path = str(tmp_path / "keys.db")
    make_old_db(path)
    store = Store(path)
    try:
        game = store.game(1)
        assert (game["name"], game["steam_app_id"]) == ("Old Game", 5)
        assert (game["per_user_limit"], game["public"], role_ids(game), game["stock_warning"]) == (1, 1, [], 0)
        assert store.available_count(1) == 2
        assert store.user_key(1, 77)["value"] == "OLD01-AAAAA-BBBBB"
        assert store.open_request_count(88) == 1
        indexes = {r[0] for r in store.db.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        assert "keys_one_per_user" not in indexes and "keys_by_user" in indexes
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert store.db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        # The old rule still holds by default, and the new settings work.
        assert store.give_key(1, 77, "member").status == "already"
        store.update_game_settings(1, per_user_limit=2)
        assert store.give_key(1, 77, "member").status == "given"
        store.ban(88, 1)
        assert store.give_key(1, 88, "press").status == "banned"
    finally:
        store.close()
    # Opening it again changes nothing.
    again = Store(path)
    try:
        assert again.user_count(1, 77) == 2 and again.game(1)["per_user_limit"] == 2
        assert again.is_banned(88, 1)
    finally:
        again.close()


def test_new_database_needs_no_migration(tmp_path):
    store = Store(str(tmp_path / "new.db"))
    try:
        assert not store._needs_migration()
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    finally:
        store.close()


def test_prior_claims_table_is_dropped(tmp_path):
    """Version 2 had a prior_claims table (claims recorded from a previous bot, without keys) that
    counted towards the limit. It goes on open, and the keys stay."""
    path = str(tmp_path / "v2.db")
    store = Store(path)
    game, _ = store.add_game("Reforge Front")
    store.add_keys(game["id"], ["RFG00-AAAAA-BBBBB", "RFG01-AAAAA-BBBBB"])
    store.give_key(game["id"], 77, "member")
    store.db.executescript("""
        CREATE TABLE prior_claims (id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL REFERENCES games(id),
                                   user_id TEXT NOT NULL, note TEXT, recorded_at TEXT NOT NULL);
        CREATE INDEX prior_claims_by_user ON prior_claims(game_id, user_id);
        INSERT INTO prior_claims (game_id, user_id, note, recorded_at) VALUES (1, '364', 'KeyBot', '2026-11-01');
        PRAGMA user_version = 2;
    """)
    store.close()
    store = Store(path)
    try:
        names = {r[0] for r in store.db.execute("SELECT name FROM sqlite_master")}
        assert "prior_claims" not in names and "prior_claims_by_user" not in names
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert not store._needs_migration()
        assert store.user_key(game["id"], 77)["value"] == "RFG00-AAAAA-BBBBB"
        # Their recorded claim no longer counts: they can claim it here.
        assert [g["name"] for g in store.claimable_games(364)] == ["Reforge Front"]
        assert store.give_key(game["id"], 364, "member").status == "given"
    finally:
        store.close()
