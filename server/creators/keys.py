"""Steam keys in outreach emails: the {key} placeholder, filled from the key bot's pool (server/keybot).

The key is taken when the email is actually sent (send.py), not when the draft is made, so skipped,
opted-out or never-sent messages use none. It is recorded in the key bot's database as given to the
channel or outlet ("yt:<channel id>", "tw:<Twitch user id>", "press:<key>"), reason 'creator' or
'press'. When that creator later uses /request on Discord for the same game and verifies the same
channel, the bot hands them that key again instead of a new one (keybot/bot.py creator_verified).
A channel that already got a key for the game by email gets the same key in a later email.

If the email can't be sent (refused, or it bounces), the key goes back to the pool, unless someone
has claimed it on Discord since.

The key bot's database is a separate SQLite file (KEYBOT_DB, default /srv/fourgames/keybot/keys.db);
both services run as the same user. Key values are never logged.
"""

from __future__ import annotations

import os

DEFAULT_KEYBOT_DB = "/srv/fourgames/keybot/keys.db"
PLACEHOLDER = "{key}"


class NoKeys(Exception):
    """No key bot game for this Steam app, or it has no keys left."""


def keybot_path() -> str:
    return os.environ.get("KEYBOT_DB", "").strip() or DEFAULT_KEYBOT_DB


def open_keys(path: str | None = None):
    from keybot.db import Store
    return Store(path or keybot_path())


def holder(target_kind: str, target_id: str) -> str:
    """Who an emailed key is recorded as given to in the key bot."""
    if target_kind == "press":
        return f"press:{target_id}"
    if target_kind == "twitch" or target_id.startswith("tw:"):
        return target_id if target_id.startswith("tw:") else f"tw:{target_id}"
    return f"yt:{target_id}"


def uses_key(text: str) -> bool:
    return PLACEHOLDER in (text or "")


def game_for(keys, appid: int | None):
    """The key bot's game with this Steam app id, or None."""
    if not appid:
        return None
    return keys.db.execute("SELECT * FROM games WHERE steam_app_id = ? ORDER BY id LIMIT 1", (appid,)).fetchone()


def available(keys, appid: int | None) -> int | None:
    """Keys left for the game, or None when the key bot has no game with this app id."""
    game = game_for(keys, appid)
    return None if game is None else keys.available_count(game["id"])


def already_has(keys, appid: int | None, who: str) -> bool:
    game = game_for(keys, appid)
    return bool(game) and keys.db.execute(
        "SELECT 1 FROM keys WHERE game_id = ? AND given_to = ? LIMIT 1", (game["id"], who)).fetchone() is not None


def take(keys, appid: int | None, who: str, reason: str) -> tuple[int, str, bool]:
    """(key id, value, new) for this channel or outlet: the key it already got for the game by email,
    else a new one marked as given to it. Raises NoKeys."""
    from keybot.db import now_iso
    game = game_for(keys, appid)
    if game is None:
        raise NoKeys("the key bot has no game with this Steam app id")
    with keys.transaction() as db:
        row = db.execute("SELECT id, value FROM keys WHERE game_id = ? AND given_to = ? ORDER BY id LIMIT 1",
                         (game["id"], who)).fetchone()
        if row:
            return row["id"], row["value"], False
        row = db.execute("SELECT id, value FROM keys WHERE game_id = ? AND status = 'available' ORDER BY id LIMIT 1",
                         (game["id"],)).fetchone()
        if row is None:
            raise NoKeys(f"no keys left for {game['name']} in the key bot")
        db.execute("""UPDATE keys SET status = 'given', given_to = ?, given_at = ?, reason = ?, request_id = NULL
                      WHERE id = ? AND status = 'available'""", (who, now_iso(), reason, row["id"]))
    return row["id"], row["value"], True


def give_back(keys, key_id: int, who: str) -> bool:
    """Puts an emailed key back in the pool, if it's still the channel's (not claimed on Discord since)."""
    with keys.transaction() as db:
        n = db.execute("""UPDATE keys SET status = 'available', given_to = NULL, given_at = NULL, reason = NULL,
                                          request_id = NULL WHERE id = ? AND given_to = ?""", (key_id, who)).rowcount
    return bool(n)
