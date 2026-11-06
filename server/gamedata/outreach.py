"""The dashboard's Outreach routes (Creators page): drafts, approvals and status of the creator and
press emails. The work is in server/creators/outreach.py, on the creators database; this module only
checks the owner's sign-in and the request. Sending is creators/send.py's (creators-send.timer).

- GET  /v1/admin/outreach                    campaigns with counts, sent in 24 h, opt-outs, contacted addresses
- GET  /v1/admin/outreach/<id>               one campaign and its messages (the previews)
- POST /v1/admin/outreach                    a new draft: {appid, game, audience, from_name, from_email,
                                             subject, body, daily_limit, recipients}
- POST /v1/admin/outreach/<id>/status        {status: approved | paused | deleted (drafts only)}
- POST /v1/admin/outreach/messages/<id>/skip  leave one message out
- POST /v1/admin/outreach/suppress           {email}: never email this address
- POST /v1/admin/outreach/translate          {subject, body, languages}: Claude translates the email into
                                             each language in the same short, plain style (the owner checks them)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import Any

from aiohttp import web

from . import web as W
from .limits import Refused, read_json

BODY_CAPS = (256 * 1024, 256 * 1024)
log = logging.getLogger("gamedata.outreach")

# Translating outreach emails: short and plain, written the way a native speaker would write a short
# personal email, never more formal or longer than the English.
TRANSLATE_MODEL = "claude-sonnet-5-5"
LANG_NAMES = {"de": "German", "fr": "French", "es": "Spanish", "pt": "Portuguese (Brazil)", "it": "Italian",
              "pl": "Polish", "ru": "Russian", "uk": "Ukrainian", "tr": "Turkish", "ja": "Japanese", "ko": "Korean",
              "zh": "Simplified Chinese", "nl": "Dutch", "sv": "Swedish", "da": "Danish", "no": "Norwegian",
              "fi": "Finnish", "cs": "Czech", "hu": "Hungarian", "ro": "Romanian", "id": "Indonesian",
              "vi": "Vietnamese", "th": "Thai", "ar": "Arabic", "hi": "Hindi", "el": "Greek", "he": "Hebrew"}
TRANSLATE_SYSTEM = """You translate short outreach emails from a solo indie game developer to YouTubers,
streamers and games press. For each requested language, write the email the way a native speaker would
write a short, friendly personal email to a stranger: simple everyday words, short sentences, the same
meaning and the same length or shorter as the English. Not more formal, not salesy, no exclamation marks
the English doesn't have, nothing added or left out. Use the informal "you" where that is normal for
talking to content creators in that language (du, tu, tú...), formal only where informal would be rude
(e.g. Japanese: polite です/ます).

Keep exactly as they are, character for character: every {placeholder} in curly braces ({name}, {game},
{steam}, {press}, {their_game}), every URL, the game's name, "Danny", "/request" and "fourgames.se".
Keep the line breaks and blank lines where the English has them. Also translate the separate opt-out line."""
TRANSLATE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["translations"],
    "properties": {"translations": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["language", "subject", "body", "opt_out"],
        "properties": {"language": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"},
                       "opt_out": {"type": "string"}}}}}}


CLIENT = None  # the Anthropic client, made on first use (a test sets a fake)


def make_client():
    import anthropic
    return anthropic.AsyncAnthropic(timeout=180.0, max_retries=1)
EMAIL = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")


def _paths() -> tuple[str, str]:
    from creators.config import DEFAULT_DB_PATH, DEFAULT_STEAM_DB
    return (os.environ.get("CREATORS_DB", "").strip() or DEFAULT_DB_PATH,
            os.environ.get("STEAM_DB", "").strip() or DEFAULT_STEAM_DB)


def _with_store(fn):
    from creators import outreach
    db_path, steam_db = _paths()
    store = outreach.open_store(db_path)
    try:
        return fn(outreach, store, steam_db)
    except outreach.OutreachError as error:
        raise Refused(400, "bad_request", str(error)) from None
    finally:
        store.close()


def _game_names(steam_db: str, store) -> tuple[dict[int, str], set[int]]:
    from creators.config import read_own_appids
    from creators.games import connect, own_appids
    own = own_appids(steam_db, read_own_appids())
    ids = sorted({a for (a,) in store.db.execute("SELECT DISTINCT appid FROM youtube_videos")} | own)
    names: dict[int, str] = {}
    try:
        db = connect(steam_db)
        try:
            for start in range(0, len(ids), 500):
                chunk = ids[start:start + 500]
                names.update(db.execute(f"SELECT appid, name FROM apps WHERE appid IN ({','.join('?' * len(chunk))})",
                                        chunk).fetchall())
        finally:
            db.close()
    except Exception:  # noqa: BLE001 - names only fill {their_game}
        pass
    return names, own


async def overview(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    return W.ok(await asyncio.to_thread(_with_store, lambda o, s, _: o.overview(s)))


async def one(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    cid = _int(request.match_info["cid"])
    def work(o, s, _):
        out = {**o.summary(s, cid), "messages": o.messages(s, cid)}
        # The designed version of each message, as the dashboard preview shows it.
        if out["campaign"].get("gif"):
            for m in out["messages"]:
                m["html"] = o.html_for(out["campaign"], m["body"])
        return out
    return W.ok(await asyncio.to_thread(_with_store, work))


async def create(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    body = await read_json(request, *BODY_CAPS, require_json_type=True)
    allowed = {"appid", "game", "audience", "from_name", "from_email", "subject", "body", "daily_limit", "recipients", "gif",
               "translations"}
    if not isinstance(body, dict) or not set(body) <= allowed:
        raise Refused(400, "bad_request", "send {" + ", ".join(sorted(allowed)) + "}")

    def work(o, store, steam_db):
        names, own = _game_names(steam_db, store)
        made = o.create_campaign(store, body, names, own, time.time())
        return {**made, "messages": o.messages(store, made["id"])}
    return W.ok(await asyncio.to_thread(_with_store, work), status=201)


async def status(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    cid = _int(request.match_info["cid"])
    body = await read_json(request, 4096, 4096, require_json_type=True)
    wanted = body.get("status") if isinstance(body, dict) else None
    if wanted not in ("approved", "paused", "deleted"):
        raise Refused(400, "bad_request", "status must be approved, paused or deleted")
    return W.ok(await asyncio.to_thread(_with_store, lambda o, s, _: o.set_status(s, cid, wanted, time.time())))


async def skip(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    mid = _int(request.match_info["mid"])
    await asyncio.to_thread(_with_store, lambda o, s, _: o.skip_message(s, mid))
    return W.ok()


async def suppress(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    body = await read_json(request, 4096, 4096, require_json_type=True)
    email = body.get("email") if isinstance(body, dict) else None
    if not isinstance(email, str) or not EMAIL.match(email.strip()):
        raise Refused(400, "bad_request", "send {email}")
    await asyncio.to_thread(_with_store, lambda o, s, _: o.suppress(s, email, "manual", time.time()))
    return W.ok()


async def translate(request: web.Request) -> web.Response:
    from creators import outreach
    from .admin import require_admin
    require_admin(request)
    body = await read_json(request, 64 * 1024, 64 * 1024, require_json_type=True)
    if not isinstance(body, dict) or not set(body) <= {"subject", "body", "languages"}:
        raise Refused(400, "bad_request", "send {subject, body, languages}")
    subject, text = str(body.get("subject") or "").strip(), str(body.get("body") or "").strip()
    langs = [outreach.short_lang(str(x)) for x in body.get("languages") or [] if isinstance(x, str)]
    langs = [x for x in dict.fromkeys(langs) if x in LANG_NAMES][:20]
    if not subject or not text or len(text) > outreach.MAX_BODY:
        raise Refused(400, "bad_request", "send the English subject and body")
    if not langs:
        return W.ok({"translations": {}, "skipped": []})
    global CLIENT
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip() and CLIENT is None:
        raise Refused(503, "claude_not_configured", "the server has no ANTHROPIC_API_KEY in its environment")
    CLIENT = CLIENT or make_client()
    client = CLIENT
    ask = (f"Languages: {', '.join(f'{c} ({LANG_NAMES[c]})' for c in langs)}\n\n"
           f"Subject:\n{subject}\n\nBody:\n{text}\n\nOpt-out line:\n{outreach.OPT_OUT_LINE}")
    import anthropic
    try:
        message = await client.messages.create(
            model=TRANSLATE_MODEL, max_tokens=16000,
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": TRANSLATE_SCHEMA}},
            system=TRANSLATE_SYSTEM, messages=[{"role": "user", "content": ask}])
    except anthropic.AuthenticationError:
        raise Refused(503, "claude_key_refused", "Anthropic refused the server's ANTHROPIC_API_KEY") from None
    except (anthropic.APIStatusError, anthropic.APIConnectionError, anthropic.APITimeoutError) as error:
        log.warning("claude translate failed: %s", type(error).__name__)
        raise Refused(502, "claude_error", "Claude couldn't translate it right now; try again") from None
    text_out = next((b.text for b in message.content if b.type == "text"), "")
    try:
        items = json.loads(text_out).get("translations") or []
    except (ValueError, AttributeError):
        raise Refused(502, "claude_bad_answer", "Claude's answer wasn't readable; try again") from None
    good, skipped = {}, []
    for item in items:
        code = outreach.short_lang(str(item.get("language") or ""))
        if code not in langs:
            continue
        try:
            good.update(outreach.check_translations({code: item}, subject, text))
        except outreach.OutreachError:
            skipped.append(code)  # it changed a placeholder or link: left out, English goes to them
    skipped += [c for c in langs if c not in good and c not in skipped]
    return W.ok({"translations": good, "skipped": skipped, "model": getattr(message, "model", TRANSLATE_MODEL)})


def _int(value: str) -> int:
    if not value.isdigit() or len(value) > 12:
        raise Refused(404, "not_found", "no such campaign or message")
    return int(value)


def add_routes(app: web.Application, v1: str) -> None:
    add = app.router.add_route
    add("GET", f"{v1}/outreach", overview)
    add("POST", f"{v1}/outreach", create)
    add("POST", f"{v1}/outreach/suppress", suppress)
    add("POST", f"{v1}/outreach/translate", translate)
    add("POST", f"{v1}/outreach/messages/{{mid}}/skip", skip)
    add("GET", f"{v1}/outreach/{{cid}}", one)
    add("POST", f"{v1}/outreach/{{cid}}/status", status)
