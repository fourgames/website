"""Outreach: short, one-to-one emails to the creators and press on our lists, in small daily drips.

How it works:
  1. On the dashboard (Creators page, Outreach) the owner picks a game and recipients (the best
     creators for it, or press filtered by country and language), writes a subject and a short body
     with placeholders, and saves a draft. Each recipient gets their own message, filled in here.
  2. The owner reads the previews and approves the batch. Nothing is sent before that.
  3. send.py (creators-send.timer) sends approved messages slowly: at most DAILY_MAX a day across all
     campaigns, only in sending hours, spread out, one at a time. It also reads the inbox for replies,
     opt-outs ("no", "unsubscribe"...) and bounces, and marks the messages.

Rules that always hold, whatever a campaign says:
  - Never to an address that opted out or bounced (the suppress table), ever again.
  - Never twice to the same address within RECONTACT_DAYS, across all campaigns.
  - Every email says how to opt out (a line before the sign-off: reply and say so), and carries a List-Unsubscribe header.

Placeholders in the subject and body: {name} (the channel or outlet), {game}, {steam} (the store
link), {press} (the game's press page on press.fourgames.se), {their_game} (for a creator: a game they made a video of, ours first, else one like ours;
for press: empty). Anything else is written as it is.

This module is the database side, used by send.py and by the game-data server's admin routes
(server/gamedata/outreach.py), both on the same SQLite file.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from .db import Store

RECONTACT_DAYS = 90
MAX_RECIPIENTS = 500
MAX_SUBJECT = 150
MAX_BODY = 5000
STATUSES = ("draft", "approved", "paused", "done")
EMAIL = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")
FIELD = re.compile(r"\{(name|game|steam|press|their_game)\}")
OPT_OUT_LINE = "If you don't want emails like this, just tell me and I won't email again."

SCHEMA = """
CREATE TABLE IF NOT EXISTS outreach_campaigns (
    id          INTEGER PRIMARY KEY,
    appid       INTEGER,
    game        TEXT NOT NULL,
    audience    TEXT NOT NULL,          -- creators or press
    from_name   TEXT NOT NULL,
    from_email  TEXT NOT NULL,
    subject     TEXT NOT NULL,
    body        TEXT NOT NULL,
    daily_limit INTEGER NOT NULL,       -- this campaign's share of the day (the global cap still holds)
    status      TEXT NOT NULL,          -- draft, approved, paused, done
    created_at  INTEGER NOT NULL,
    approved_at INTEGER
);
CREATE TABLE IF NOT EXISTS outreach_messages (
    id          INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL,
    target_kind TEXT NOT NULL,          -- youtube or press
    target_id   TEXT NOT NULL,          -- channel id or press key
    name        TEXT,
    email       TEXT NOT NULL,
    subject     TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL,          -- queued, sent, failed, skipped, replied, opted_out, bounced
    queued_at   INTEGER NOT NULL,
    sent_at     INTEGER,
    message_id  TEXT,                   -- the Message-ID we sent, to match replies
    replied_at  INTEGER,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS outreach_messages_campaign ON outreach_messages (campaign_id, status);
CREATE INDEX IF NOT EXISTS outreach_messages_email ON outreach_messages (email);
CREATE TABLE IF NOT EXISTS outreach_suppress (
    email   TEXT PRIMARY KEY,
    reason  TEXT NOT NULL,              -- opted_out, bounced, manual
    at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outreach_state (
    key     TEXT PRIMARY KEY,
    value   TEXT
);
"""


# Every email also has an HTML version that looks like a normal email from a person, with the game's
# GIF (or header image) dropped in; the plain text stays in the same email as the fallback. One image,
# no buttons, no tracking pixels.
SITE = "https://fourgames.se"
GIF_DIR = "/images/outreach"
_URL = re.compile(r"https?://[^\s<>()\"']+[^\s<>()\"'.,;:!?]")


def image_for(game: str, appid: int | None, gifs: set[str] | None = None) -> str:
    """The game's gameplay GIF on fourgames.se when there is one (public/images/outreach/<slug>.gif),
    else its Steam header image."""
    slug = re.sub(r"[^a-z0-9]+", "-", game.lower()).strip("-")
    if gifs is not None and slug in gifs:
        return f"{SITE}{GIF_DIR}/{slug}.gif"
    return f"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg" if appid else ""


def local_gifs() -> set[str]:
    """The game GIFs in this checkout's public/images/outreach (the website serves the same files)."""
    import os
    folder = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "public", "images", "outreach")
    try:
        return {f[:-4] for f in os.listdir(folder) if f.endswith(".gif")}
    except OSError:
        return set()


def html_for(campaign: dict, body: str) -> str:
    appid = campaign.get("appid")
    steam = f"https://store.steampowered.com/app/{appid}/" if appid else ""
    return html_body(body, image=image_for(campaign["game"], appid, local_gifs()), steam=steam,
                     from_name=campaign["from_name"])


def html_body(text: str, *, image: str, steam: str, from_name: str) -> str:
    """The email as a person would write it in a mail app: plain paragraphs, links as text, and the
    game's GIF dropped in after the first paragraph that says what the game is (the second one, or
    the first if there is only one). No card, buttons or logo: cold emails that look designed read
    like marketing, land in spam or promotions more often and get fewer replies."""
    import html as h
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    foot = ""
    if paragraphs and paragraphs[-1].startswith("--"):
        foot = paragraphs.pop()[2:].strip()

    def para(p: str) -> str:
        out = []
        last = 0
        for m in _URL.finditer(p):
            out.append(h.escape(p[last:m.start()]))
            out.append(f'<a href="{h.escape(m.group(0))}">{h.escape(m.group(0))}</a>')
            last = m.end()
        out.append(h.escape(p[last:]))
        return f'<p style="margin:0 0 14px">{"".join(out).replace(chr(10), "<br>")}</p>'

    parts = [para(p) for p in paragraphs]
    if image:
        gif = (f'<p style="margin:0 0 14px"><a href="{h.escape(steam or SITE)}"><img src="{h.escape(image)}" width="460" alt="" '
               f'style="display:block;width:100%;max-width:460px;height:auto;border:0;border-radius:6px"></a></p>')
        parts.insert(min(2, len(parts)), gif)
    if foot:
        parts.append(f'<p style="margin:18px 0 0;color:#888;font-size:12px">{h.escape(foot)}</p>')
    return ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>'
            '<body style="margin:0;padding:12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
            f'font-size:15px;line-height:1.5;color:#222;background:#fff"><div style="max-width:560px">{"".join(parts)}</div></body></html>')


class OutreachError(ValueError):
    """Something the dashboard asked for that can't be done; the message says why."""


def open_store(path: str) -> Store:
    store = Store(path)
    store.db.executescript(SCHEMA)
    return store


def render(template: str, fields: dict[str, str]) -> str:
    return FIELD.sub(lambda m: fields.get(m.group(1), ""), template)


def with_opt_out(body: str) -> str:
    """Adds the opt-out line in the sender's own words, before the sign-off ("Thanks,\nDanny"), unless
    the body already says how to opt out. Required (an easy way to say no) without reading like a mass mailing."""
    body = body.rstrip()
    low = body.lower()
    if "email again" in low or "email you again" in low or "reply \"no\"" in low or "unsubscribe" in low:
        return body
    paragraphs = body.split("\n\n")
    last = paragraphs[-1]
    if len(paragraphs) > 1 and "\n" in last and len(last) < 80:  # a sign-off: put the line above it
        return "\n\n".join(paragraphs[:-1] + [OPT_OUT_LINE, last])
    return f"{body}\n\n{OPT_OUT_LINE}"


def blocked(store: Store, email: str, now: float, exclude: int | None = None, sent_only: bool = False) -> str | None:
    """Why this address can't be emailed now, or None: it opted out or bounced, or another message to
    it was sent (or, unless sent_only, is waiting in a campaign) in the last RECONTACT_DAYS."""
    row = store.db.execute("SELECT reason FROM outreach_suppress WHERE email = ?", (email,)).fetchone()
    if row:
        return row[0]
    recent = store.db.execute(
        f"""SELECT 1 FROM outreach_messages WHERE email = ? AND id != ? AND status NOT IN ('skipped', 'failed')
            {"AND sent_at IS NOT NULL" if sent_only else ""} AND COALESCE(sent_at, queued_at) >= ?""",
        (email, exclude or -1, now - RECONTACT_DAYS * 86400)).fetchone()
    return "contacted recently" if recent else None


def _creator(store: Store, channel_id: str, own: set[int]) -> dict | None:
    r = store.db.execute("SELECT channel_id, title, emails, revealed_email FROM youtube_channels WHERE channel_id = ?",
                         (channel_id,)).fetchone()
    if not r:
        return None
    emails = json.loads(r["emails"] or "[]")
    if r["revealed_email"]:
        emails.append(r["revealed_email"])
    emails += [e for (e,) in store.db.execute("SELECT email FROM site_emails WHERE channel_id = ?", (channel_id,))]
    if not emails:
        return None
    covered = [a for (a,) in store.db.execute(
        "SELECT appid FROM youtube_videos WHERE channel_id = ? GROUP BY appid ORDER BY COUNT(*) DESC", (channel_id,))]
    ours = [a for a in covered if a in own]
    return {"id": channel_id, "name": r["title"] or "", "email": emails[0].lower(), "games": ours + [a for a in covered if a not in own]}


def _press(store: Store, key: str) -> dict | None:
    r = store.db.execute("SELECT key, name, email FROM press WHERE key = ?", (key,)).fetchone()
    return {"id": r["key"], "name": r["name"], "email": r["email"].lower()} if r and r["email"] else None


def create_campaign(store: Store, spec: dict[str, Any], game_names: dict[int, str], own: set[int],
                    now: float) -> dict[str, Any]:
    """A draft campaign with one filled-in message per usable recipient. spec: {appid, game, audience,
    from_name, from_email, subject, body, daily_limit, recipients: [ids]} (channel ids or press keys)."""
    audience = spec.get("audience")
    if audience not in ("creators", "press"):
        raise OutreachError("audience must be creators or press")
    game = str(spec.get("game") or "").strip()
    subject = str(spec.get("subject") or "").strip()
    body = str(spec.get("body") or "").strip()
    from_name = str(spec.get("from_name") or "").strip()
    from_email = str(spec.get("from_email") or "").strip().lower()
    if not game or not subject or not body or not from_name:
        raise OutreachError("a campaign needs a game, a subject, a body and a from name")
    if len(subject) > MAX_SUBJECT or len(body) > MAX_BODY or len(from_name) > 80:
        raise OutreachError(f"keep the subject under {MAX_SUBJECT} and the body under {MAX_BODY} characters")
    if not EMAIL.match(from_email):
        raise OutreachError("the from address isn't an email address")
    try:
        daily = int(spec.get("daily_limit") or 20)
    except (TypeError, ValueError):
        raise OutreachError("daily limit must be a number") from None
    if not 1 <= daily <= 200:
        raise OutreachError("daily limit must be between 1 and 200")
    ids = [str(x) for x in (spec.get("recipients") or []) if isinstance(x, (str, int))]
    if not ids or len(ids) > MAX_RECIPIENTS:
        raise OutreachError(f"pick between 1 and {MAX_RECIPIENTS} recipients")
    appid = spec.get("appid")
    appid = appid if type(appid) is int else None
    steam = f"https://store.steampowered.com/app/{appid}/" if appid else ""
    skipped: dict[str, int] = {}
    with store.db:
        cur = store.db.execute(
            """INSERT INTO outreach_campaigns (appid, game, audience, from_name, from_email, subject, body,
                                               daily_limit, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)""",
            (appid, game, audience, from_name, from_email, subject, body, daily, int(now)))
        campaign = cur.lastrowid
        seen: set[str] = set()
        for target in dict.fromkeys(ids):
            who = _creator(store, target, own) if audience == "creators" else _press(store, target)
            if not who:
                skipped["no email"] = skipped.get("no email", 0) + 1
                continue
            why = "listed twice" if who["email"] in seen else blocked(store, who["email"], now)
            if why:
                skipped[why] = skipped.get(why, 0) + 1
                continue
            seen.add(who["email"])
            games = who.get("games", [])
            # A game they made a video of, ours first; the campaign's own game only if it's all they played.
            their = next((game_names[a] for a in games if a in game_names and a != appid),
                         game if appid in games else "")
            fields = {"name": who["name"], "game": game, "steam": steam, "their_game": their,
                      "press": f"https://press.fourgames.se/{re.sub(r'[^a-z0-9]+', '-', game.lower()).strip('-')}"}
            store.db.execute(
                """INSERT INTO outreach_messages (campaign_id, target_kind, target_id, name, email, subject, body,
                                                  status, queued_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)""",
                (campaign, "youtube" if audience == "creators" else "press", who["id"], who["name"], who["email"],
                 render(subject, fields), with_opt_out(render(body, fields)), int(now)))
    return {"id": campaign, "skipped": skipped, **summary(store, campaign)}


def summary(store: Store, campaign: int) -> dict[str, Any]:
    c = store.db.execute("SELECT * FROM outreach_campaigns WHERE id = ?", (campaign,)).fetchone()
    if not c:
        raise OutreachError("no such campaign")
    counts = dict(store.db.execute("SELECT status, COUNT(*) FROM outreach_messages WHERE campaign_id = ? GROUP BY status",
                                   (campaign,)).fetchall())
    return {"campaign": dict(c), "counts": counts}


def campaigns(store: Store) -> list[dict[str, Any]]:
    return [summary(store, r[0]) for r in store.db.execute("SELECT id FROM outreach_campaigns ORDER BY id DESC")]


def messages(store: Store, campaign: int, limit: int = 600) -> list[dict[str, Any]]:
    return [dict(r) for r in store.db.execute(
        """SELECT id, target_kind, target_id, name, email, subject, body, status, queued_at, sent_at, replied_at, error
           FROM outreach_messages WHERE campaign_id = ? ORDER BY id LIMIT ?""", (campaign, limit))]


def set_status(store: Store, campaign: int, status: str, now: float) -> dict[str, Any]:
    c = summary(store, campaign)["campaign"]
    allowed = {"approved": ("draft", "paused"), "paused": ("approved",), "deleted": ("draft",)}
    if status not in allowed or c["status"] not in allowed[status]:
        raise OutreachError(f"a {c['status']} campaign can't be {status}")
    with store.db:
        if status == "deleted":
            store.db.execute("DELETE FROM outreach_messages WHERE campaign_id = ?", (campaign,))
            store.db.execute("DELETE FROM outreach_campaigns WHERE id = ?", (campaign,))
            return {"deleted": campaign}
        store.db.execute("UPDATE outreach_campaigns SET status = ?, approved_at = COALESCE(approved_at, ?) WHERE id = ?",
                         (status, int(now) if status == "approved" else None, campaign))
    return summary(store, campaign)


def skip_message(store: Store, message: int) -> None:
    with store.db:
        n = store.db.execute("UPDATE outreach_messages SET status = 'skipped' WHERE id = ? AND status = 'queued'",
                             (message,)).rowcount
    if not n:
        raise OutreachError("only a message still waiting to be sent can be skipped")


def suppress(store: Store, email: str, reason: str, now: float) -> None:
    email = email.strip().lower()
    with store.db:
        store.db.execute("INSERT OR IGNORE INTO outreach_suppress (email, reason, at) VALUES (?, ?, ?)",
                         (email, reason, int(now)))
        store.db.execute("UPDATE outreach_messages SET status = 'skipped' WHERE email = ? AND status = 'queued'", (email,))


def overview(store: Store) -> dict[str, Any]:
    """What the dashboard's Outreach tab shows."""
    day_ago = time.time() - 86400
    return {
        "campaigns": campaigns(store),
        "sent_24h": store.db.execute("SELECT COUNT(*) FROM outreach_messages WHERE sent_at >= ?", (day_ago,)).fetchone()[0],
        "suppressed": store.db.execute("SELECT COUNT(*) FROM outreach_suppress").fetchone()[0],
        "contacted": [r[0] for r in store.db.execute(
            "SELECT DISTINCT email FROM outreach_messages WHERE status NOT IN ('skipped', 'failed')")],
        "state": dict(store.db.execute("SELECT key, value FROM outreach_state").fetchall()),
    }

