"""Did the creators we emailed make a video of the game? That's the result that sells copies, more
than a reply.

For WATCH_DAYS after an email goes out, the collector reads the channel's newest uploads every
CHECK_DAYS (its uploads playlist, 1 unit, plus 1 unit for the details when there's anything new) and
keeps the videos that name the game, in any of the names we used in the emails, or link its Steam
page. They go in youtube_videos like the search's finds, so the weekly search of our own games
counts too. A video counts for an email when it came out after the email was sent.

Twitch streamers we emailed need no extra reads: the Twitch part reads our own games' broadcasts and
who's live in them every week (twitch.py), so a broadcast of the game after the email counts the same.

New or repeat: a creator who had no video (or broadcast) of the game before the email is new
coverage, the email's real result; one who already had is a repeat, who might have made it anyway.
"""

from __future__ import annotations

import re
from typing import Any

from .db import Store
from .youtube import mentions

SCHEMA = """
CREATE TABLE IF NOT EXISTS outreach_watch (
    channel_id  TEXT NOT NULL,
    appid       INTEGER NOT NULL,
    checked_at  INTEGER NOT NULL,
    PRIMARY KEY (channel_id, appid)
);
"""
WATCH_DAYS = 60
CHECK_DAYS = 3
DAY = 86400
# Emails that reached someone: sent, answered or said no (a no can still turn into a video).
REACHED = ("sent", "replied", "opted_out")


def ensure(store: Store) -> None:
    store.db.executescript(SCHEMA)


def due(store: Store, now: float, limit: int = 200) -> list[dict[str, Any]]:
    """Emailed channels to look at now: per channel and game, since when and the names to look for."""
    from .outreach import migrate  # outreach imports this module; the collector's store may predate its tables
    migrate(store)
    marks = ",".join("?" * len(REACHED))
    rows = store.db.execute(
        f"""SELECT m.target_id AS channel_id, c.appid, MIN(m.sent_at) AS since, c.game,
                   GROUP_CONCAT(DISTINCT m.game_name) AS names, w.checked_at
            FROM outreach_messages m JOIN outreach_campaigns c ON c.id = m.campaign_id
            LEFT JOIN outreach_watch w ON w.channel_id = m.target_id AND w.appid = c.appid
            WHERE m.target_kind = 'youtube' AND c.appid IS NOT NULL AND m.sent_at >= ?
              AND m.status IN ({marks})
            GROUP BY m.target_id, c.appid
            HAVING w.checked_at IS NULL OR w.checked_at < ?
            ORDER BY w.checked_at IS NOT NULL, w.checked_at LIMIT ?""",
        (now - WATCH_DAYS * DAY, *REACHED, now - CHECK_DAYS * DAY, limit)).fetchall()
    out = []
    for r in rows:
        names = [r["game"], *((r["names"] or "").split(","))]
        out.append({"channel_id": r["channel_id"], "appid": r["appid"], "since": r["since"],
                    "names": list(dict.fromkeys(n.strip() for n in names if n and n.strip()))})
    return out


def checked(store: Store, channel_id: str, appid: int, now: float) -> None:
    with store.db:
        store.db.execute("""INSERT INTO outreach_watch (channel_id, appid, checked_at) VALUES (?, ?, ?)
                            ON CONFLICT(channel_id, appid) DO UPDATE SET checked_at = excluded.checked_at""",
                         (channel_id, appid, int(now)))


def is_about(video: dict, appid: int, names: list[str]) -> bool:
    """The video names the game (title, tags, or a Gaming video's description) or links its Steam page."""
    if any(mentions(n, video) for n in names):
        return True
    text = (video.get("snippet") or {}).get("description") or ""
    return re.search(rf"(?:store\.steampowered\.com/app|s\.team/a)/{appid}(?!\d)", text) is not None


def videos_by_message(store: Store, campaign: int) -> dict[int, list[dict[str, Any]]]:
    """Per message of the campaign, the videos (YouTube) or broadcasts (Twitch) of its game the creator
    put out after the email. Each has repeat: True when they had covered the game before the email."""
    ensure(store)
    from .twitch import ensure as twitch_ensure
    twitch_ensure(store.db)
    out: dict[int, list[dict[str, Any]]] = {}
    for r in store.db.execute(
            """SELECT m.id, v.video_id, v.title, v.published, v.views,
                      EXISTS (SELECT 1 FROM youtube_videos p WHERE p.channel_id = m.target_id AND p.appid = c.appid
                              AND p.published < m.sent_at) AS repeat
               FROM outreach_messages m JOIN outreach_campaigns c ON c.id = m.campaign_id
               JOIN youtube_videos v ON v.channel_id = m.target_id AND v.appid = c.appid
               WHERE m.campaign_id = ? AND m.target_kind = 'youtube' AND m.sent_at IS NOT NULL
                 AND v.published >= m.sent_at
               ORDER BY v.published""", (campaign,)):
        out.setdefault(r["id"], []).append({"id": r["video_id"], "title": r["title"], "published": r["published"],
                                            "views": r["views"], "repeat": bool(r["repeat"]),
                                            "url": f"https://www.youtube.com/watch?v={r['video_id']}"})
    for r in store.db.execute(
            """SELECT m.id, s.stream_id, s.title, s.started, s.views, t.login,
                      EXISTS (SELECT 1 FROM twitch_streams p WHERE p.user_id = s.user_id AND p.appid = c.appid
                              AND p.started < m.sent_at) AS repeat
               FROM outreach_messages m JOIN outreach_campaigns c ON c.id = m.campaign_id
               JOIN twitch_streams s ON s.user_id = substr(m.target_id, 4) AND s.appid = c.appid
               LEFT JOIN twitch_channels t ON t.user_id = s.user_id
               WHERE m.campaign_id = ? AND m.target_kind = 'twitch' AND m.sent_at IS NOT NULL
                 AND s.started >= m.sent_at
               ORDER BY s.started""", (campaign,)):
        live = r["stream_id"].startswith("live:")
        out.setdefault(r["id"], []).append({
            "id": r["stream_id"], "title": r["title"], "published": r["started"], "views": r["views"],
            "repeat": bool(r["repeat"]), "twitch": True, "live": live,
            "url": f"https://www.twitch.tv/{r['login']}" if live or not r["stream_id"].isdigit() else
                   f"https://www.twitch.tv/videos/{r['stream_id']}"})
    return out


def totals(store: Store, campaign: int) -> dict[str, int]:
    """How many emailed creators made a video (new: no earlier video of the game; repeat: had one),
    how many videos, and their views together (live broadcasts count their viewers)."""
    found = videos_by_message(store, campaign)
    repeat = sum(1 for v in found.values() if v and v[0]["repeat"])
    return {"creators": len(found), "new": len(found) - repeat, "repeat": repeat,
            "videos": sum(len(v) for v in found.values()),
            "views": sum(x["views"] or 0 for v in found.values() for x in v)}
