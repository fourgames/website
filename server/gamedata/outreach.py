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
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any

from aiohttp import web

from . import web as W
from .limits import Refused, read_json

BODY_CAPS = (256 * 1024, 256 * 1024)
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
        for m in out["messages"]:
            m["html"] = o.html_for(out["campaign"], m["body"])
        return out
    return W.ok(await asyncio.to_thread(_with_store, work))


async def create(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    body = await read_json(request, *BODY_CAPS, require_json_type=True)
    allowed = {"appid", "game", "audience", "from_name", "from_email", "subject", "body", "daily_limit", "recipients"}
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


def _int(value: str) -> int:
    if not value.isdigit() or len(value) > 12:
        raise Refused(404, "not_found", "no such campaign or message")
    return int(value)


def add_routes(app: web.Application, v1: str) -> None:
    add = app.router.add_route
    add("GET", f"{v1}/outreach", overview)
    add("POST", f"{v1}/outreach", create)
    add("POST", f"{v1}/outreach/suppress", suppress)
    add("POST", f"{v1}/outreach/messages/{{mid}}/skip", skip)
    add("GET", f"{v1}/outreach/{{cid}}", one)
    add("POST", f"{v1}/outreach/{{cid}}/status", status)
