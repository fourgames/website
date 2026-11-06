"""The hidden emails behind YouTube's "View email address" button, for the Chrome skill (creator-emails).

Many channels keep their business email behind a button on the About panel that needs a signed-in
viewer and a captcha. The skill runs in the user's own Chrome: it checks which channels have the
button (a plain page fetch, no captcha), then opens the best ones for the user to tick the captcha
and saves what's revealed. This module is its side on the server (from the server/ folder):

  python -m creators.reveal check [N]      channel ids to check for the button, best first (one per line)
  python -m creators.reveal reveal [N]     channels with the button and no email yet, best first (JSON lines)
  python -m creators.reveal save           reads JSON lines on stdin and saves them:
        {"channel_id": "UC...", "button": true|false}       the button is there or not
        {"channel_id": "UC...", "email": "a@b.com"}          revealed
        {"channel_id": "UC...", "email": null}               the button was there but showed nothing
        {"channel_id": "UC...", "links": ["throne.com/x"]}   the About panel's links (with or without the above)

Best first, until per-game matching exists: channels with a video of one of our games, then 1k-300k
subscribers (big enough to sell, small enough to answer), then a video in the last 30 days, then
videos of more games, then more subscribers. Only channels without an email in their description.
"""

from __future__ import annotations

import json
import re
import sys
import time

from .config import Config, ConfigError
from .db import Store
from .games import own_appids

# The button is checked again after this long (creators add and remove it).
RECHECK_DAYS = 180
EMAIL = re.compile(r"^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$")


def _order(own: set[int], now: float) -> tuple[str, str, list, list]:
    marks = ",".join("?" * len(own)) or "NULL"
    sql = f"""
        FROM youtube_channels c
        LEFT JOIN (SELECT channel_id, COUNT(DISTINCT appid) AS games, MAX(published) AS last_video,
                          MAX(appid IN ({marks})) AS own
                   FROM youtube_videos GROUP BY channel_id) v ON v.channel_id = c.channel_id
        WHERE c.gone = 0 AND (c.emails IS NULL OR c.emails = '[]') AND c.revealed_email IS NULL"""
    order = """
        ORDER BY COALESCE(v.own, 0) DESC,
                 COALESCE(c.subscribers BETWEEN 1000 AND 300000, 0) DESC,
                 COALESCE(v.last_video >= ?, 0) DESC,
                 COALESCE(v.games, 0) DESC,
                 COALESCE(c.subscribers, 0) DESC"""
    return sql, order, [*own], [now - 30 * 86400]


def to_check(store: Store, own: set[int], now: float, limit: int) -> list[str]:
    sql, order, a, b = _order(own, now)
    return [r[0] for r in store.db.execute(
        f"SELECT c.channel_id {sql} AND (c.email_button IS NULL OR c.button_checked_at < ?) {order} LIMIT ?",
        (*a, now - RECHECK_DAYS * 86400, *b, limit))]


def to_reveal(store: Store, own: set[int], now: float, limit: int) -> list[dict]:
    sql, order, a, b = _order(own, now)
    rows = store.db.execute(
        f"""SELECT c.channel_id, c.handle, c.title, c.subscribers, COALESCE(v.own, 0) AS own
            {sql} AND c.email_button = 1 AND c.revealed_at IS NULL
                AND c.channel_id NOT IN (SELECT channel_id FROM site_emails) {order} LIMIT ?""", (*a, *b, limit))
    return [{**dict(r), "own": bool(r["own"]),
             "url": f"https://www.youtube.com/{r['handle'] or 'channel/' + r['channel_id']}/about"} for r in rows]


def save(store: Store, lines, now: float) -> dict[str, int]:
    counts = {"button": 0, "no button": 0, "revealed": 0, "nothing shown": 0, "links": 0, "skipped": 0}
    with store.db:
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
                channel = str(item["channel_id"])
            except (ValueError, KeyError, TypeError):
                counts["skipped"] += 1
                continue
            if not store.db.execute("SELECT 1 FROM youtube_channels WHERE channel_id = ?", (channel,)).fetchone():
                counts["skipped"] += 1
                continue
            known = False
            if "email" in item:
                email = (item["email"] or "").strip().lower() or None
                if email and not EMAIL.match(email):
                    counts["skipped"] += 1
                    continue
                store.db.execute(
                    """UPDATE youtube_channels SET revealed_email = ?, revealed_at = ?, email_button = 1,
                           button_checked_at = COALESCE(button_checked_at, ?) WHERE channel_id = ?""",
                    (email, int(now), int(now), channel))
                counts["revealed" if email else "nothing shown"] += 1
                known = True
            elif "button" in item:
                store.db.execute(
                    "UPDATE youtube_channels SET email_button = ?, button_checked_at = ? WHERE channel_id = ?",
                    (int(bool(item["button"])), int(now), channel))
                counts["button" if item["button"] else "no button"] += 1
                known = True
            for url in item.get("links") or []:
                url = str(url).strip()
                if not url:
                    continue
                if not url.lower().startswith(("http://", "https://")):
                    url = "https://" + url
                counts["links"] += store.db.execute(
                    "INSERT OR IGNORE INTO channel_links (channel_id, url, source) VALUES (?, ?, 'about')",
                    (channel, url)).rowcount
                known = True
            if not known:
                counts["skipped"] += 1
    return counts


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in ("check", "reveal", "save"):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"creators: {error}", file=sys.stderr)
        return 2
    limit = int(argv[1]) if len(argv) > 1 else (200 if argv[0] == "check" else 20)
    store = Store(config.db_path)
    now = time.time()
    try:
        if argv[0] == "save":
            counts = save(store, sys.stdin, now)
            print(", ".join(f"{k}: {v}" for k, v in counts.items() if v) or "nothing to save")
            return 0
        own = own_appids(config.steam_db, config.own_appids, config.own_studio)
        if argv[0] == "check":
            print("\n".join(to_check(store, own, now, limit)))
        else:
            for row in to_reveal(store, own, now, limit):
                print(json.dumps(row, ensure_ascii=False))
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
