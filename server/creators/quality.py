"""How much to trust each email we have for a YouTube channel: a grade from where it was found, how
recently, and what happened when we wrote to it. The export shows it on the dashboard; outreach writes
to a channel's best one.

  diamond   they replied to one of our emails from it, or a revealed email another source agrees with
  platinum  revealed by hand (the address the creator set for business in YouTube), or in their
            channel description now
  gold      typed into their About panel's links, on a page they link to (Linktree, their site) read
            in the last year, or under 2+ of their videos
  silver    under one of their videos from the last 12 months, or on a linked page read longer ago
  bronze    under one older video only
  bounced   an email to it bounced: never written to again (outreach.blocked), listed last

Several emails per channel: best first; a tie keeps the order found (description, revealed, links,
video).
"""

from __future__ import annotations

import json
import sqlite3
from collections import defaultdict

GRADES = ["bronze", "silver", "gold", "platinum", "diamond"]
BOUNCED = "bounced"
YEAR = 365 * 86400
SOURCE_ORDER = ["description", "revealed", "links", "video"]


def grade(ev: dict, now: float, replied: bool = False, bounced: bool = False) -> str:
    """ev: {"description": bool, "revealed": bool, "typed": bool, "site": newest page read time or None,
    "videos": [published, ...]}."""
    if bounced:
        return BOUNCED
    others = ev.get("description") or ev.get("typed") or ev.get("site") or ev.get("videos")
    if replied or (ev.get("revealed") and others):
        return "diamond"
    if ev.get("revealed") or ev.get("description"):
        return "platinum"
    videos = ev.get("videos") or []
    if ev.get("typed") or (ev.get("site") or 0) >= now - YEAR or len(videos) >= 2:
        return "gold"
    if ev.get("site") or (videos and (videos[0] or 0) >= now - YEAR):
        return "silver"
    return "bronze"


def rank(grade_name: str) -> int:
    return GRADES.index(grade_name) if grade_name in GRADES else -1


def _outcomes(db: sqlite3.Connection) -> tuple[set[str], set[str]]:
    """Addresses that replied to us and that bounced (no outreach tables yet: none)."""
    try:
        replied = {e.lower() for (e,) in db.execute(
            "SELECT DISTINCT email FROM outreach_messages WHERE replied_at IS NOT NULL OR status IN ('replied', 'opted_out')")}
        bounced = {e.lower() for (e,) in db.execute("SELECT email FROM outreach_suppress WHERE reason = 'bounced'")}
    except sqlite3.OperationalError:
        return set(), set()
    return replied, bounced


def channel_emails(db: sqlite3.Connection, now: float, channel_id: str | None = None) -> dict[str, list[list[str]]]:
    """{channel id: [[email, source, grade], ...]} best first; source is where it was found first
    (description, revealed, links or video). One channel, or all."""
    from .sites import typed_email
    where, args = ("WHERE channel_id = ?", (channel_id,)) if channel_id else ("", ())
    ev: dict[str, dict[str, dict]] = defaultdict(dict)   # channel -> email -> evidence
    first: dict[str, dict[str, str]] = defaultdict(dict)  # channel -> email -> first source

    def add(cid: str, email: str, source: str) -> dict:
        email = email.lower()
        first[cid].setdefault(email, source)
        return ev[cid].setdefault(email, {"videos": []})

    for cid, emails, revealed in db.execute(f"SELECT channel_id, emails, revealed_email FROM youtube_channels {where}", args):
        for e in json.loads(emails or "[]"):
            add(cid, e, "description")["description"] = True
        if revealed:
            add(cid, revealed, "revealed")["revealed"] = True
    published = {}
    rows = db.execute(f"""SELECT l.channel_id, l.url, l.source, s.fetched_at, s.emails FROM channel_links l
                          JOIN sites s ON s.url = l.url
                          WHERE s.emails IS NOT NULL AND s.emails != '[]' {"AND l.channel_id = ?" if channel_id else ""}""",
                      args).fetchall()
    if any(r[2] == "video" for r in rows):
        published = dict(db.execute(
            f"SELECT video_id, MAX(published) FROM youtube_videos {where} GROUP BY video_id", args).fetchall())
    for cid, url, source, fetched, emails in rows:
        for e in json.loads(emails):
            if source == "video":
                add(cid, e, "video")["videos"].append(published.get(url.rsplit("=", 1)[-1]) or 0)
            else:
                x = add(cid, e, "links")
                if typed_email(url):
                    x["typed"] = True
                else:
                    x["site"] = max(x.get("site") or 0, fetched or 0)
    replied, bounced = _outcomes(db)
    out = {}
    for cid, emails in ev.items():
        graded = []
        for e, x in emails.items():
            x["videos"].sort(reverse=True)
            graded.append([e, first[cid][e], grade(x, now, e in replied, e in bounced)])
        graded.sort(key=lambda g: (-rank(g[2]), SOURCE_ORDER.index(g[1])))
        out[cid] = graded
    return out
