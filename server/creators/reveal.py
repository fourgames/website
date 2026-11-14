"""The hidden emails behind YouTube's "View email address" button, for the Chrome skill (yt-email-unlock).

Many channels keep their business email behind a button on the About panel that needs a signed-in
viewer and a captcha. The skill runs in the user's own Chrome: it checks which channels have the
button (a plain page fetch, no captcha), then opens the best ones for the user to tick the captcha
and saves what's revealed. This module is its side on the server (from the server/ folder):

  python -m creators.reveal check [N]      channel ids to check for the button, best first (one per line)
  python -m creators.reveal reveal [N]     channels with the button and no email yet, best first (JSON lines)
  python -m creators.reveal limit [TIME]   YouTube showed "today's access limit" (now, or at unix TIME);
                                           the dashboard counts down LIMIT_HOURS from the latest one
  python -m creators.reveal save           reads JSON lines on stdin and saves them:
        {"channel_id": "UC...", "button": true|false}       the button is there or not
        {"channel_id": "UC...", "email": "a@b.com"}          revealed
        {"channel_id": "UC...", "email": null}               the button was there but showed nothing
        {"channel_id": "UC...", "links": ["throne.com/x"]}   the About panel's links (with or without the above)

Best first: channels with a video of one of our games, then by expected value (score.py): typical
views per video (the median of their game videos of 3+ minutes, a week old or more; subscribers
stand in until that's known) x how active they are x how well their genres fit any of our games.
Only channels without an email in their description.
"""

from __future__ import annotations

import json
import re
import sys
import time

from .config import Config, ConfigError
from .db import Store
from .games import own_appids
from .score import channel_values

# The button is checked again after this long (creators add and remove it).
RECHECK_DAYS = 180
# How long YouTube's reveal limit seems to last: on 2026-11-08 it still held 23 hours after it hit
# (past midnight Pacific), so it looks like a rolling day, not a calendar one.
LIMIT_HOURS = 24
EMAIL = re.compile(r"^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$")


# The channels both queues pick from: no email in their description and none revealed yet.
CANDIDATES = """
        FROM youtube_channels c
        WHERE c.gone = 0 AND (c.emails IS NULL OR c.emails = '[]') AND c.revealed_email IS NULL"""


def rank(store: Store, ids: list[str], own: set[int], now: float, steam_db: str | None = None) -> list[str]:
    """Best first: a video of one of our games, then expected value (score.py: typical views x
    activity x best genre fit to any of our games)."""
    ids = list(dict.fromkeys(ids))
    if not ids:
        return []
    ours: set[str] = set()
    if own:
        ours = {r[0] for r in store.db.execute(
            f"SELECT DISTINCT channel_id FROM youtube_videos WHERE appid IN ({','.join('?' * len(own))})", [*own])}
    values = channel_values(store.db, ids, own, now, steam_db)
    return sorted(ids, key=lambda c: (c not in ours, -values.get(c, 0.0)))


def to_check(store: Store, own: set[int], now: float, limit: int, steam_db: str | None = None) -> list[str]:
    ids = [r[0] for r in store.db.execute(
        f"SELECT c.channel_id {CANDIDATES} AND (c.email_button IS NULL OR c.button_checked_at < ?)",
        (now - RECHECK_DAYS * 86400,))]
    return rank(store, ids, own, now, steam_db)[:limit]


def to_reveal(store: Store, own: set[int], now: float, limit: int, steam_db: str | None = None) -> list[dict]:
    rows = {r["channel_id"]: r for r in store.db.execute(
        f"""SELECT c.channel_id, c.handle, c.title, c.subscribers {CANDIDATES}
                AND c.email_button = 1 AND c.revealed_at IS NULL
                AND c.channel_id NOT IN (SELECT channel_id FROM site_emails)""")}
    order = rank(store, list(rows), own, now, steam_db)[:limit]
    ours = set()
    if own and order:
        ours = {r[0] for r in store.db.execute(
            f"SELECT DISTINCT channel_id FROM youtube_videos WHERE appid IN ({','.join('?' * len(own))})", [*own])}
    return [{**dict(rows[c]), "own": c in ours,
             "url": f"https://www.youtube.com/{rows[c]['handle'] or 'channel/' + c}/about"} for c in order]


def limit_hit(store: Store, at: float) -> None:
    with store.db:
        store.db.execute("INSERT OR IGNORE INTO reveal_limits (hit_at) VALUES (?)", (int(at),))


def limit_status(store: Store) -> dict | None:
    """The latest limit hit and when revealing should work again: {hit, ready}."""
    hit = store.db.execute("SELECT MAX(hit_at) FROM reveal_limits").fetchone()[0]
    return {"hit": hit, "ready": hit + LIMIT_HOURS * 3600} if hit else None


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
    if not argv or argv[0] not in ("check", "reveal", "save", "limit"):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"creators: {error}", file=sys.stderr)
        return 2
    limit = int(argv[1]) if len(argv) > 1 and argv[0] != "limit" else (200 if argv[0] == "check" else 20)
    store = Store(config.db_path)
    now = time.time()
    try:
        if argv[0] == "limit":
            limit_hit(store, float(argv[1]) if len(argv) > 1 else now)
            from .export import write
            write(config, store, now)  # so the dashboard's countdown shows now, not after the next hourly run
            status = limit_status(store)
            print("limit saved; try again from " + time.strftime("%Y-%m-%d %H:%M", time.localtime(status["ready"])))
            return 0
        if argv[0] == "save":
            counts = save(store, sys.stdin, now)
            print(", ".join(f"{k}: {v}" for k, v in counts.items() if v) or "nothing to save")
            return 0
        own = own_appids(config.steam_db, config.own_appids, config.own_studio)
        if argv[0] == "check":
            print("\n".join(to_check(store, own, now, limit, config.steam_db)))
        else:
            status = limit_status(store)
            if status and status["ready"] > now:
                print("YouTube's limit is on until " + time.strftime("%Y-%m-%d %H:%M", time.localtime(status["ready"])),
                      file=sys.stderr)
            for row in to_reveal(store, own, now, limit, config.steam_db):
                print(json.dumps(row, ensure_ascii=False))
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
