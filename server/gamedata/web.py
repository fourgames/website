"""The HTTP side: the games' endpoints, the privacy page's endpoints, one internal lookup for
our own tools (localhost only), and the owner's endpoints for the feedback dashboard (admin.py).

Caddy forwards https://api.fourgames.se/gamedata/* here. The routes answer both with and without
the /gamedata prefix, so it works whether Caddy strips it (handle_path) or not (handle).

The logs never show a steamid, a ticket, an IP or what's in an event: only the first 8 characters
of a pid, counts and sizes.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import logging
import os
import re
import secrets
import shutil
import time
import traceback
import uuid
import weakref
from typing import Any
from urllib.parse import urlencode

import aiohttp
from aiohttp import web

from . import admin, export, retention, validate
from .config import Config
from .geo import Geo, open_mmdb
from .limits import RateLimiter, Refused, read_json
from .signing import PID, TokenError, make_pid, short, sign, valid_steamid, verify
from .steam import OPENID_LOGIN, PARTNER_API, SignInFailed, Steam, SteamError, TicketRejected
from .store import Session, Store, month, write_gzip_json

log = logging.getLogger("gamedata.web")

CONFIG = web.AppKey("config", Config)
STORE = web.AppKey("store", Store)
STEAM = web.AppKey("steam", Steam)
LIMITS = web.AppKey("limits", object)
SALT = web.AppKey("salt", bytes)
EXPORTS = web.AppKey("exports", asyncio.Semaphore)
LOCKS = web.AppKey("locks", weakref.WeakValueDictionary)
DISK = web.AppKey("disk", dict)
USAGE = web.AppKey("usage", dict)
STEAM_URLS = web.AppKey("steam_urls", tuple)
GEO = web.AppKey("geo", Geo)
# The pids of GAMEDATA_ADMIN_STEAMIDS: a signed-in cookie with one of them is the owner (admin.py).
ADMIN_PIDS = web.AppKey("admin_pids", frozenset)

COOKIE = "fg_privacy"
COOKIE_TTL = 3600
# An admin's sign-in (the dashboard stays open all day, on a TV say) lasts longer.
ADMIN_COOKIE_TTL = 12 * 3600
# The browser half of the sign-in's state: it ties Steam's answer to the browser that started it.
STATE_COOKIE = "fg_openid"
STATE_TTL = 600
SESSION_TTL = 24 * 3600
STATUS_PAGE_ORIGIN = "https://status.fourgames.se"
# How often /health adds up DATA_DIR's size again.
USAGE_EVERY = 300

KB = 1024
MB = 1024 * 1024
# Body caps: (as sent, unpacked). A batch's own cap is max_batch_kb gzipped.
START_CAPS = (64 * KB, 256 * KB)
BATCH_UNPACKED = 4 * MB
END_CAPS = (64 * KB, 64 * KB)
CRASH_CAPS = (512 * KB, 2 * MB)
SMALL_CAPS = (4 * KB, 4 * KB)
LOOKUP_CAPS = (16 * KB, 16 * KB)
MAX_LOOKUP = 200
# The latest progress event's data is kept per session up to this size.
MAX_PROGRESS = 4 * KB

# A return path on the site: starts with one /, no scheme, no //, no backslashes.
RETURN_PATH = re.compile(r"^/(?!/)[A-Za-z0-9/_.~%-]*(\?[A-Za-z0-9_.~%=&-]*)?$")
DEFAULT_RETURN = "/privacy"

# The privacy page's routes (without the /gamedata prefix): CORS with credentials for SITE_ORIGIN.
PLAYER_PATHS = frozenset({"/v1/me", "/v1/me/optout", "/v1/me/export", "/v1/me/anonymise", "/v1/auth/signout"})
# The owner's routes (admin.py): the same CORS, and GitHub's headers the dashboard reads.
ADMIN_PREFIX = "/v1/admin/"
ADMIN_EXPOSED = ("ETag, Last-Modified, Link, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, "
                 "X-RateLimit-Reset, X-RateLimit-Used, X-RateLimit-Resource")


class Limits:
    """Per IP (hashed) and per pid. Generous for real play, tight enough that one client can't
    flood the box."""

    def __init__(self, clock=time.monotonic):
        self.start_ip = RateLimiter(60, 3600, clock)
        self.start_pid = RateLimiter(30, 3600, clock)
        # Uploads come every minute, plus a backlog after offline play.
        self.upload_ip = RateLimiter(1200, 600, clock)
        self.upload_pid = RateLimiter(300, 600, clock)
        self.crash_pid = RateLimiter(10, 3600, clock)
        self.page_ip = RateLimiter(120, 600, clock)
        self.sign_in_ip = RateLimiter(20, 600, clock)
        self.export_pid = RateLimiter(5, 3600, clock)
        # The dashboard reads a dozen files at a load, every game's on All games, and asks again
        # every 5 minutes.
        self.admin_ip = RateLimiter(1200, 600, clock)
        self.admin_pid = RateLimiter(900, 600, clock)


# Helpers


def bare_path(path: str) -> str:
    return path[len("/gamedata"):] if path == "/gamedata" or path.startswith("/gamedata/") else path


def client_ip(request: web.Request) -> str:
    """The client's IP. Behind Caddy that's in X-Forwarded-For; Caddy sets the header itself (it
    doesn't pass on one the client sent), so the last entry is the one Caddy saw. Only trusted when
    the request comes from this machine."""
    forwarded = request.headers.get("X-Forwarded-For", "")
    if is_local(request) and forwarded:
        return forwarded.split(",")[-1].strip()
    return request.remote or ""


def is_local(request: web.Request) -> bool:
    try:
        return ipaddress.ip_address(request.remote or "").is_loopback
    except ValueError:
        return False


def ip_key(request: web.Request) -> str:
    # Salted per run: it tells repeat clients apart for the limits, and can't be reversed.
    return hashlib.sha256(request.app[SALT] + client_ip(request).encode()).hexdigest()[:16]


def check_rate(limiter: RateLimiter, key: str, what: str) -> None:
    if not limiter.allow(key):
        log.info("rate limited: %s", what)
        raise Refused(429, "rate_limited", "too many requests, try again later",
                      {"Retry-After": str(limiter.retry_after(key))})


def ok(body: dict[str, Any] | None = None, status: int = 200) -> web.Response:
    return web.json_response({"ok": True, **(body or {})}, status=status)


def error_response(status: int, error: str, message: str, headers: dict[str, str] | None = None) -> web.Response:
    return web.json_response({"ok": False, "error": error, "message": message}, status=status, headers=headers)


def disk_ok(app: web.Application) -> bool:
    """Whether the disk has GAMEDATA_MIN_FREE_MB free, looked at once a minute."""
    cfg = app[CONFIG]
    disk = app[DISK]
    now = time.monotonic()
    if now - disk.get("at", -1e9) > 60:
        try:
            disk["free"] = shutil.disk_usage(cfg.data_dir).free
        except OSError:
            disk["free"] = 0
        disk["at"] = now
    return disk["free"] >= cfg.min_free_mb * MB


def check_disk(app: web.Application) -> None:
    if not disk_ok(app):
        log.warning("disk nearly full: refusing uploads")
        raise Refused(503, "storage_full", "the server can't take data right now", {"Retry-After": "3600"})


# The games' side


def session_claims(request: web.Request) -> dict[str, Any]:
    """The Bearer session token's contents: s (session id), p (pid), a (app id)."""
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise Refused(401, "bad_token", "send the session token as Authorization: Bearer <token>")
    try:
        claims = verify(request.app[CONFIG].token_secret, "session", token.strip())
    except TokenError as error:
        if str(error) == "expired":
            raise Refused(401, "token_expired", "the session token has expired: start a new session") from None
        raise Refused(401, "bad_token", "the session token isn't valid") from None
    if not (isinstance(claims.get("s"), str) and isinstance(claims.get("p"), str)
            and PID.match(claims["p"]) and isinstance(claims.get("a"), int)):
        raise Refused(401, "bad_token", "the session token isn't valid")
    return claims


def own_session(request: web.Request, claims: dict[str, Any], session_id: str) -> Session:
    """The token's session, if it's the one named and the player still wants their data collected."""
    store = request.app[STORE]
    if session_id != claims["s"]:
        raise Refused(403, "session_mismatch", "the token is for another session")
    # Also what an anonymised player's game hears: anonymising marks the player opted out.
    if store.opted_out(claims["p"]):
        raise Refused(403, "opted_out", "the player has opted out: send nothing more")
    session = store.session(session_id)
    if session is None or session.pid != claims["p"] or session.app_id != claims["a"]:
        raise Refused(403, "session_mismatch", "unknown session")
    return session


def start_reply(cfg: Config, session_id: str | None, token: str | None) -> web.Response:
    return ok({
        "session_id": session_id,
        "token": token,
        "opted_out": session_id is None,
        "upload_every_s": cfg.upload_every_s,
        "max_batch_kb": cfg.max_batch_kb,
        "privacy_url": cfg.privacy_url,
    })


def unknown_app() -> Refused:
    """What validate.start answers for an app id we don't take: also what a test app answers anyone
    who isn't one of GAMEDATA_TEST_STEAMIDS, once Steam has said who they are."""
    return validate.bad("this game doesn't send data here", "unknown_app")


async def ask_steam(app: web.Application, app_id: int, call):
    """Steam's answer about a ticket, its refusals as the game's errors."""
    try:
        return await call
    except TicketRejected:
        log.info("session start for app %s: ticket refused by Steam", app_id)
        raise Refused(401, "bad_ticket", "Steam didn't accept the ticket") from None
    except SteamError as error:
        log.warning("session start for app %s: Steam unavailable (%s)", app_id, error)
        raise Refused(502, "steam_unavailable", "Steam can't be reached, try again later",
                      {"Retry-After": "60"}) from None


async def session_start(request: web.Request) -> web.Response:
    app = request.app
    cfg, store, limits = app[CONFIG], app[STORE], app[LIMITS]
    check_rate(limits.start_ip, ip_key(request), "session start per IP")
    start = validate.start(await read_json(request, *START_CAPS), cfg.app_ids | cfg.test_app_ids)
    # Taken from anyone, or only (as a test session) from the test accounts. An app in both lists
    # takes everyone, and marks the test accounts' sessions test.
    open_app = start.app_id in cfg.app_ids
    test_app = start.app_id in cfg.test_app_ids
    if not start.gameplay:
        # The game's own switch is off: nothing to check, nothing stored. Except that a test app
        # must first know it's a tester asking, or it would answer as a known app.
        if not open_app:
            steamid, _ = await ask_steam(app, start.app_id, app[STEAM].authenticate_ticket(start.app_id, start.ticket))
            if steamid not in cfg.test_steamids:
                log.info("session start for app %s: not a test account", start.app_id)
                raise unknown_app()
        log.info("session start for app %s: gameplay consent off", start.app_id)
        return start_reply(cfg, None, None)

    steamid, owns = await ask_steam(app, start.app_id, app[STEAM].player_for_ticket(start.app_id, start.ticket))
    test = test_app and steamid in cfg.test_steamids
    if not test and not open_app:
        log.info("session start for app %s: not a test account", start.app_id)
        raise unknown_app()
    pid = make_pid(cfg.pepper, steamid)
    if not owns:
        log.info("session start %s app %s: doesn't own the game", short(pid), start.app_id)
        raise Refused(403, "not_owned", "this Steam account doesn't have the game")
    check_rate(limits.start_pid, pid, "session start per player")
    owns_full_game = None
    if start.app_id in cfg.demo_of:
        # A demo: does the player have the full game too? Never holds up the session.
        try:
            owns_full_game = await app[STEAM].owns_app(steamid, cfg.demo_of[start.app_id])
        except (SteamError, TicketRejected) as error:
            log.info("session start %s app %s: full-game ownership unknown (%s)", short(pid), start.app_id, error)
    del steamid  # from here on, only the pid

    # Country and region from the IP, looked up here and now: the IP itself is never kept or logged.
    country, region = app[GEO].locate(client_ip(request))
    info = {"game_version": start.game_version, "build_id": start.build_id, "godot_version": start.godot_version,
            "platform": start.platform, "locale": start.locale, "consent_hardware": start.hardware_consent,
            "previous_crash": start.previous_crash, "country": country, "region": region,
            "boot_kind": start.boot_kind, "dlc": start.dlc, "owns_full_game": owns_full_game, "test": test}
    if start.hardware_consent and start.input is not None:
        # What they play with is about their devices: only with the hardware consent.
        info.update(input_type=start.input["type"], input_controller=start.input["controller"])
    session_id = store.start_session(
        pid, start.app_id, info,
        start.hardware if start.hardware_consent else None,
        start.settings if start.hardware_consent else None)
    if session_id is None:
        log.info("session start %s app %s: opted out", short(pid), start.app_id)
        return start_reply(cfg, None, None)
    token = sign(cfg.token_secret, "session", {"s": session_id, "p": pid, "a": start.app_id}, SESSION_TTL)
    log.info("session start %s app %s%s%s", short(pid), start.app_id,
             "" if start.hardware_consent else " (no hardware)", " (test)" if test else "")
    return start_reply(cfg, session_id, token)


def session_lock(app: web.Application, session_id: str) -> asyncio.Lock:
    """One upload at a time per session, so a repeated seq can't race the first."""
    locks = app[LOCKS]
    lock = locks.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        locks[session_id] = lock
    return lock


async def events(request: web.Request) -> web.Response:
    app = request.app
    cfg, store, limits = app[CONFIG], app[STORE], app[LIMITS]
    claims = session_claims(request)
    pid = claims["p"]
    check_rate(limits.upload_pid, pid, f"uploads for {short(pid)}")
    check_rate(limits.upload_ip, ip_key(request), "uploads per IP")
    check_disk(app)
    batch = validate.batch(await read_json(request, cfg.max_batch_kb * KB, BATCH_UNPACKED))
    session = own_session(request, claims, batch.session_id)

    async with session_lock(app, session.session_id):
        if store.has_batch(session.session_id, batch.seq):
            return ok({"duplicate": True})
        if not batch.events:
            return ok({"dropped": batch.dropped} if batch.dropped else None)
        if store.bytes_since(pid, time.time() - 86400) >= cfg.max_mb_per_day * MB:
            log.warning("daily cap reached for %s", short(pid))
            raise Refused(429, "daily_cap", "this player has sent a lot today, try again tomorrow",
                          {"Retry-After": "3600"})
        now = int(time.time())
        path = store.batch_path(session, batch.seq)
        record = {"session_id": session.session_id, "seq": batch.seq, "app_id": session.app_id,
                  "received": now, "events": batch.events}
        size = await asyncio.to_thread(write_gzip_json, store.root / path, record)
        last_t = max(event["t"] for event in batch.events)
        store.add_batch(session, batch.seq, len(batch.events), last_t, size, path, now,
                        progress=latest_progress(batch.events))
    log.info("events %s seq %d: %d events, %d bytes%s", short(pid), batch.seq, len(batch.events), size,
             f", {batch.dropped} too big" if batch.dropped else "")
    return ok({"dropped": batch.dropped} if batch.dropped else None)


def latest_progress(events: list[dict[str, Any]]) -> tuple[float, dict[str, Any]] | None:
    """The batch's last progress event with data, (t, data), if it's small enough to keep in the
    session's row (the internal lookup shows it)."""
    found = [event for event in events if event["type"] == "progress" and "data" in event]
    if not found:
        return None
    event = max(found, key=lambda e: e["t"])
    if validate.json_size(event["data"]) > MAX_PROGRESS:
        return None
    return event["t"], event["data"]


async def session_end(request: web.Request) -> web.Response:
    app = request.app
    store, limits = app[STORE], app[LIMITS]
    claims = session_claims(request)
    check_rate(limits.upload_pid, claims["p"], f"uploads for {short(claims['p'])}")
    end = validate.end(await read_json(request, *END_CAPS))
    session = own_session(request, claims, end.session_id)
    if not store.end_session(session.session_id, end.seq, end.playtime_s, end.summary,
                             active_s=end.active_s, idle_s=end.idle_s, first_session=end.first_session,
                             last_scene=end.last_scene, last_screen=end.last_screen):
        return ok({"duplicate": True})
    log.info("session end %s app %s: %s s", short(session.pid), session.app_id,
             round(end.playtime_s) if end.playtime_s is not None else "?")
    return ok()


async def crash(request: web.Request) -> web.Response:
    app = request.app
    store, limits = app[STORE], app[LIMITS]
    claims = session_claims(request)
    check_rate(limits.crash_pid, claims["p"], f"crashes for {short(claims['p'])}")
    check_disk(app)
    report = validate.crash(await read_json(request, *CRASH_CAPS))
    session = own_session(request, claims, claims["s"])
    async with session_lock(app, session.session_id):
        if store.crash_reported(session.session_id):
            return ok({"duplicate": True})
        now = int(time.time())
        crash_id = str(uuid.uuid4())
        crashed = store.crashed_session_of(session.pid, report.crashed_session_id)
        path = f"crashes/{session.app_id}/{month(now)}/{crash_id}.json.gz"
        details = {"game_version": report.game_version, "signal": report.signal, "os": report.os}
        record = {"crash_id": crash_id, "app_id": session.app_id, "session_id": session.session_id,
                  "crashed_session_id": crashed, **details, "received": now,
                  "log_tail": report.log_tail, "last_events": report.last_events}
        size = await asyncio.to_thread(write_gzip_json, store.root / path, record)
        store.add_crash(crash_id, session, crashed, details, len(report.last_events), size, path, now)
    log.info("crash %s app %s: %d events, %d bytes", short(session.pid), session.app_id,
             len(report.last_events), size)
    return ok()


# The privacy page's side


def cookie_claims(request: web.Request) -> dict[str, Any] | None:
    """The sign-in cookie's contents (p: the pid, e: its expiry), if it's valid."""
    try:
        claims = verify(request.app[CONFIG].cookie_secret, "cookie", request.cookies.get(COOKIE, ""))
    except TokenError:
        return None
    pid = claims.get("p")
    return claims if isinstance(pid, str) and PID.match(pid) else None


def signed_in_pid(request: web.Request) -> str | None:
    claims = cookie_claims(request)
    return claims["p"] if claims else None


def require_pid(request: web.Request) -> str:
    pid = signed_in_pid(request)
    if pid is None:
        raise Refused(401, "not_signed_in", "sign in with Steam first")
    return pid


def check_page_post(request: web.Request) -> None:
    """CSRF: a POST must come from the site's own page, as JSON (which also makes the browser ask
    first, with a preflight)."""
    if request.headers.get("Origin", "").rstrip("/") != request.app[CONFIG].site_origin:
        raise Refused(403, "bad_origin", "not allowed from this site")
    if request.content_type != "application/json":
        raise Refused(415, "unsupported_media_type", "send JSON (Content-Type: application/json)")


def set_cookie(response: web.StreamResponse, cfg: Config, value: str, max_age: int) -> None:
    response.set_cookie(COOKIE, value, max_age=max_age, domain=cfg.cookie_domain or None, path="/",
                        secure=True, httponly=True, samesite="None")


def clear_cookie(response: web.StreamResponse, cfg: Config) -> None:
    set_cookie(response, cfg, "", 0)


async def me(request: web.Request) -> web.Response:
    check_rate(request.app[LIMITS].page_ip, ip_key(request), "page per IP")
    pid = signed_in_pid(request)
    if pid is None:
        return ok({"signed_in": False})
    return ok({"signed_in": True, **request.app[STORE].summary(pid, request.app[CONFIG].demo_of)})


async def me_optout(request: web.Request) -> web.Response:
    check_rate(request.app[LIMITS].page_ip, ip_key(request), "page per IP")
    check_page_post(request)
    pid = require_pid(request)
    body = await read_json(request, *SMALL_CAPS, require_json_type=True)
    if not isinstance(body.get("opted_out"), bool):
        raise Refused(400, "bad_request", 'send {"opted_out": true} or {"opted_out": false}')
    request.app[STORE].set_opted_out(pid, body["opted_out"])
    log.info("%s %s on the privacy page", short(pid), "opted out" if body["opted_out"] else "opted back in")
    return ok({"opted_out": body["opted_out"]})


async def me_anonymise(request: web.Request) -> web.Response:
    cfg = request.app[CONFIG]
    check_rate(request.app[LIMITS].page_ip, ip_key(request), "page per IP")
    check_page_post(request)
    pid = require_pid(request)
    body = await read_json(request, *SMALL_CAPS, require_json_type=True)
    if body.get("confirm") is not True:
        raise Refused(400, "confirm_needed", 'send {"confirm": true} to anonymise')
    _, counts = request.app[STORE].anonymise(pid)
    log.info("anonymised %s: %d sessions, %d batches, %d crashes", short(pid),
             counts["sessions"], counts["batches"], counts["crashes"])
    response = ok()
    clear_cookie(response, cfg)
    return response


async def me_export(request: web.Request) -> web.StreamResponse:
    check_rate(request.app[LIMITS].page_ip, ip_key(request), "page per IP")
    pid = require_pid(request)
    check_rate(request.app[LIMITS].export_pid, pid, f"exports for {short(pid)}")
    return await send_zip(request, pid)


async def sign_out(request: web.Request) -> web.Response:
    check_rate(request.app[LIMITS].page_ip, ip_key(request), "page per IP")
    check_page_post(request)
    response = ok()
    clear_cookie(response, request.app[CONFIG])
    return response


def site_url(cfg: Config, path: str, **query: str) -> str:
    if query:
        path += ("&" if "?" in path else "?") + urlencode(query)
    return cfg.site_origin + path


def redirect(location: str) -> web.Response:
    return web.Response(status=302, headers={"Location": location})


def state_return_to(cfg: Config, state: str) -> str:
    return f"{cfg.callback_url}?{urlencode({'state': state})}"


async def auth_steam(request: web.Request) -> web.Response:
    cfg = request.app[CONFIG]
    check_rate(request.app[LIMITS].sign_in_ip, ip_key(request), "sign-in per IP")
    back = request.query.get("return", DEFAULT_RETURN) or DEFAULT_RETURN
    if len(back) > 256 or not RETURN_PATH.match(back) or "//" in back:
        raise Refused(400, "bad_return", "return must be a path on the site, like /privacy")
    nonce = secrets.token_urlsafe(16)
    state = sign(cfg.cookie_secret, "openid", {"n": nonce, "r": back}, STATE_TTL)
    response = redirect(Steam.login_url(state_return_to(cfg, state), cfg.realm))
    response.set_cookie(STATE_COOKIE, nonce, max_age=STATE_TTL, path="/", secure=True, httponly=True,
                        samesite="Lax")
    return response


async def auth_callback(request: web.Request) -> web.Response:
    cfg = request.app[CONFIG]
    check_rate(request.app[LIMITS].sign_in_ip, ip_key(request), "sign-in per IP")
    state = request.query.get("state", "")
    try:
        claims = verify(cfg.cookie_secret, "openid", state)
        back = claims["r"]
        if not isinstance(back, str) or not RETURN_PATH.match(back):
            raise TokenError("invalid")
    except (TokenError, KeyError) as error:
        log.info("sign-in failed: state %s", error if isinstance(error, TokenError) else "invalid")
        return redirect(site_url(cfg, DEFAULT_RETURN, signin="failed"))

    def failed(reason: str, outcome: str = "failed") -> web.Response:
        log.info("sign-in %s: %s", outcome, reason)
        response = redirect(site_url(cfg, back, signin=outcome))
        response.set_cookie(STATE_COOKIE, "", max_age=0, path="/", secure=True, httponly=True, samesite="Lax")
        return response

    nonce = request.cookies.get(STATE_COOKIE, "")
    if not nonce or not hmac.compare_digest(nonce.encode(), str(claims.get("n", "")).encode()):
        return failed("started in another browser, or the state cookie is gone")
    if request.query.get("openid.mode") == "cancel":
        return failed("cancelled on Steam", "cancelled")
    try:
        steamid = await request.app[STEAM].verify_sign_in(dict(request.query), state_return_to(cfg, state))
    except SignInFailed as error:
        return failed(str(error))
    except SteamError as error:
        return failed(f"Steam unavailable ({error})")
    pid = make_pid(cfg.pepper, steamid)
    del steamid
    ttl = ADMIN_COOKIE_TTL if pid in request.app[ADMIN_PIDS] else COOKIE_TTL
    log.info("signed in %s%s", short(pid), " (admin)" if ttl == ADMIN_COOKIE_TTL else "")
    response = redirect(site_url(cfg, back))
    set_cookie(response, cfg, sign(cfg.cookie_secret, "cookie", {"p": pid}, ttl), ttl)
    response.set_cookie(STATE_COOKIE, "", max_age=0, path="/", secure=True, httponly=True, samesite="Lax")
    return response


# Downloads


async def send_zip(request: web.Request, pid: str) -> web.StreamResponse:
    """Builds the player's zip (one at a time: the box has one core) and streams it from disk."""
    cfg = request.app[CONFIG]
    async with request.app[EXPORTS]:
        file = await asyncio.to_thread(export.build, cfg.data_dir, pid, cfg.link_months)
    try:
        size = os.fstat(file.fileno()).st_size
        response = web.StreamResponse(headers={
            "Content-Type": "application/zip",
            "Content-Disposition": f'attachment; filename="{export.FILENAME}"',
            "Content-Length": str(size),
        })
        await response.prepare(request)
        try:
            while chunk := file.read(256 * KB):
                await response.write(chunk)
            await response.write_eof()
        except ConnectionResetError:
            log.info("export for %s: the download was interrupted", short(pid))
            return response
    finally:
        file.close()
    log.info("export for %s: %d bytes", short(pid), size)
    return response


# Internal: localhost only, for our own tools


def check_internal(request: web.Request) -> None:
    """Only from this machine, never through Caddy (which adds X-Forwarded-For), and only with the
    internal key. Anything not from here is told the route doesn't exist."""
    if not is_local(request) or "X-Forwarded-For" in request.headers:
        raise Refused(404, "not_found", "Not Found")
    key = request.headers.get("X-Internal-Key", "")
    if not hmac.compare_digest(key.encode(), request.app[CONFIG].internal_key.encode()):
        log.warning("internal call with a wrong key")
        raise Refused(403, "forbidden", "wrong internal key")


async def internal_lookup(request: web.Request) -> web.Response:
    """Game data for public steamids (a Steam review's or discussion post's author), next to what
    they wrote. Opted-out and anonymised players show only {"opted_out": true}; players without
    data are left out. The steamids are never logged."""
    check_internal(request)
    cfg = request.app[CONFIG]
    body = await read_json(request, *LOOKUP_CAPS)
    steamids = body.get("steamids")
    if not isinstance(steamids, list) or len(steamids) > MAX_LOOKUP:
        raise Refused(400, "bad_request", f"steamids must be a list of at most {MAX_LOOKUP} SteamID64s")
    include_test = body.get("include_test", False)
    if not isinstance(include_test, bool):
        raise Refused(400, "bad_request", "include_test must be true or false")
    by_pid: dict[str, str] = {}
    for index, value in enumerate(steamids):
        steamid = valid_steamid(value)
        if steamid is None:
            raise Refused(400, "bad_steamid", f"steamids[{index}] isn't a SteamID64 (17 digits)")
        by_pid[make_pid(cfg.pepper, steamid)] = steamid
    found = request.app[STORE].lookup(list(by_pid), cfg.demo_of, include_test)
    log.info("lookup: %d steamids, %d with data or an opt-out", len(by_pid), len(found))
    return ok({"players": {by_pid[pid]: entry for pid, entry in found.items()}})


# Plumbing


async def health(request: web.Request) -> web.Response:
    """Up, and how full the disk is: nothing is deleted automatically, so the status page warns
    before it fills. free and total are the disk's, now; used is DATA_DIR's (the database and the
    event and crash files), at most USAGE_EVERY seconds old. low_space: uploads are being refused."""
    app = request.app
    cfg = app[CONFIG]
    usage = app[USAGE]
    if time.monotonic() - usage.get("at", -1e9) > USAGE_EVERY:
        usage["used"] = await asyncio.to_thread(retention.disk_usage, cfg.data_dir)
        usage["at"] = time.monotonic()
    disk = shutil.disk_usage(cfg.data_dir)
    # The status page (server/status-page) can read this from the visitor's browser.
    return web.json_response({"ok": True, "time": int(time.time()), "disk": {
        "used_bytes": usage["used"], "free_bytes": disk.free, "total_bytes": disk.total,
        "low_space": disk.free < cfg.min_free_mb * MB,
    }}, headers={"Access-Control-Allow-Origin": STATUS_PAGE_ORIGIN})


async def preflight(request: web.Request) -> web.Response:
    # The CORS headers themselves come from on_prepare.
    return web.Response(status=204)


async def on_prepare(request: web.Request, response: web.StreamResponse) -> None:
    """Headers for every response, set just before they're sent (so streamed downloads and error
    answers get them too)."""
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    path = bare_path(request.path)
    is_admin = path.startswith(ADMIN_PREFIX)
    if path in PLAYER_PATHS or is_admin:
        cfg = request.app[CONFIG]
        # The admin answers differ by who's signed in, and a GitHub file may be kept a minute.
        response.headers["Vary"] = "Origin, Cookie" if is_admin else "Origin"
        if request.headers.get("Origin", "").rstrip("/") == cfg.site_origin:
            response.headers["Access-Control-Allow-Origin"] = cfg.site_origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
            if request.method == "OPTIONS":
                response.headers["Access-Control-Allow-Methods"] = "GET, PUT, OPTIONS" if is_admin else "GET, POST, OPTIONS"
                response.headers["Access-Control-Allow-Headers"] = "Content-Type"
                response.headers["Access-Control-Max-Age"] = "600"
            else:
                response.headers["Access-Control-Expose-Headers"] = ADMIN_EXPOSED if is_admin else "Content-Disposition"


HTTP_ERRORS = {400: "bad_request", 404: "not_found", 405: "method_not_allowed", 413: "too_large"}


@web.middleware
async def errors(request: web.Request, handler):
    try:
        return await handler(request)
    except Refused as refused:
        return error_response(refused.status, refused.error, refused.message, refused.headers)
    except web.HTTPException as error:
        if error.status >= 400:
            return error_response(error.status, HTTP_ERRORS.get(error.status, "http_error"), error.reason)
        raise
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001 - the client gets a plain 500, the log the place
        # Where, not what: an exception's message could quote data.
        frame = traceback.extract_tb(error.__traceback__)[-1]
        log.error("unexpected %s at %s:%s in %s", type(error).__name__, os.path.basename(frame.filename),
                  frame.lineno, bare_path(request.path))
        return error_response(500, "internal", "something went wrong on our side")


async def _steam(app: web.Application):
    session = aiohttp.ClientSession()
    api_base, openid_login = app[STEAM_URLS]
    app[STEAM] = Steam(session, app[CONFIG].steam_publisher_key, api_base, openid_login)
    yield
    await session.close()


async def _close_store(app: web.Application) -> None:
    app[STORE].close()
    app[GEO].close()


async def retention_loop(app: web.Application, first_delay: float = 60, every: float = 3600) -> None:
    """Every hour: unlink the players whose last session is GAMEDATA_LINK_MONTHS old."""
    cfg = app[CONFIG]
    await asyncio.sleep(first_delay)
    while True:
        try:
            unlinked = await asyncio.to_thread(retention.run, cfg.data_dir, cfg.link_months)
            if unlinked:
                log.info("retention: anonymised %d players whose last session was over %d months ago",
                         unlinked, cfg.link_months)
        except Exception as error:  # noqa: BLE001 - try again next hour
            log.error("retention failed: %s", type(error).__name__)
        await asyncio.sleep(every)


async def _retention(app: web.Application):
    task = asyncio.create_task(retention_loop(app))
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def make_app(config: Config, *, steam_api: str = PARTNER_API, steam_openid: str = OPENID_LOGIN,
             run_retention: bool = True, limits: Limits | None = None,
             geo_opener=open_mmdb, github_api: str | None = None) -> web.Application:
    # auto_decompress off: read_json unpacks gzip itself, with a cap. aiohttp's own unpacking has
    # none, so a small gzip bomb could fill the memory. client_max_size is a backstop; read_json
    # enforces the real per-route caps while streaming.
    app = web.Application(client_max_size=1 * MB, middlewares=[errors],
                          handler_args={"auto_decompress": False})
    app[CONFIG] = config
    app[STORE] = Store(config.data_dir)
    app[LIMITS] = limits or Limits()
    app[SALT] = secrets.token_bytes(16)
    app[EXPORTS] = asyncio.Semaphore(1)
    app[LOCKS] = weakref.WeakValueDictionary()
    app[DISK] = {}
    app[USAGE] = {}
    app[STEAM_URLS] = (steam_api, steam_openid)
    app[GEO] = Geo(config.geoip_db, opener=geo_opener)
    app[ADMIN_PIDS] = frozenset(make_pid(config.pepper, steamid) for steamid in config.admin_steamids)
    app.cleanup_ctx.append(_steam)
    app.cleanup_ctx.append(admin.github_context(github_api or admin.GITHUB_API))
    if run_retention:
        app.cleanup_ctx.append(_retention)
    app.on_response_prepare.append(on_prepare)
    app.on_cleanup.append(_close_store)

    for prefix in ("", "/gamedata"):
        v1 = f"{prefix}/v1"
        add = app.router.add_route
        add("POST", f"{v1}/session/start", session_start)
        add("POST", f"{v1}/events", events)
        add("POST", f"{v1}/session/end", session_end)
        add("POST", f"{v1}/crash", crash)

        add("GET", f"{v1}/auth/steam", auth_steam)
        add("GET", f"{v1}/auth/callback", auth_callback)
        add("POST", f"{v1}/auth/signout", sign_out)
        add("GET", f"{v1}/me", me)
        add("POST", f"{v1}/me/optout", me_optout)
        # No HEAD for the download: a HEAD would build a zip for nothing.
        app.router.add_get(f"{v1}/me/export", me_export, allow_head=False)
        add("POST", f"{v1}/me/anonymise", me_anonymise)
        for path in PLAYER_PATHS:
            add("OPTIONS", f"{prefix}{path}", preflight)

        # The owner's (admin.py): signed in with one of GAMEDATA_ADMIN_STEAMIDS.
        admin.add_routes(app, prefix)

        # Caddy answers 404 for /gamedata/v1/internal/* from outside; check_internal refuses too.
        add("POST", f"{v1}/internal/lookup", internal_lookup)

        app.router.add_get(f"{prefix}/health", health, allow_head=False)
        app.router.add_get(f"{v1}/health", health, allow_head=False)
    return app
