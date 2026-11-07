"""The HTTP side. Caddy forwards https://api.fourgames.se/news* here; every route also answers
without the /news prefix, so handle and handle_path both work.

- POST /news/subscribe: the footer form (JSON or form data): email, lang, _gotcha (honeypot),
  _elapsed (ms since the form appeared). Stores the address unconfirmed and emails a confirm link.
  Always {"ok": true} for a valid address, whether it was new, already on the list or just got a
  link, so nobody can use the form to find out who's subscribed.
- GET /news/confirm?t=…: a page with one button; pressing it (POST /news/confirm) confirms. A
  button and not the link itself, because mail scanners open links, and a scanner must not be able
  to sign someone up.
- GET /news/unsubscribe?t=…: a page with one Unsubscribe button (POST). POST /news/unsubscribe?t=…
  with List-Unsubscribe=One-Click is the mail app's one-click unsubscribe (RFC 8058).
- GET /news/health

The logs never show an email address or an IP: only the outcome and a salted hash of the IP.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
from typing import Callable

from aiohttp import web

from contact.checks import EMAIL, MAX_EMAIL, RateLimiter, Rejected
from contact.web import client_ip, read_form

from . import mail
from .config import Config
from .pages import page
from .store import Store
from .texts import lang_or_default

log = logging.getLogger("news.web")

CONFIG = web.AppKey("config", Config)
STORE = web.AppKey("store", Store)
LIMITER = web.AppKey("limiter", RateLimiter)
SALT = web.AppKey("salt", bytes)
# Replaceable in tests: (config, EmailMessage) -> None, blocking.
SEND = web.AppKey("send", Callable)

MAX_BODY = 8 * 1024
MAX_TOKEN = 100


def ip_hash(request: web.Request) -> str:
    return hashlib.sha256(request.app[SALT] + client_ip(request).encode()).hexdigest()[:12]


def cors_headers(request: web.Request) -> dict[str, str]:
    origin = request.headers.get("Origin", "").rstrip("/")
    if origin and origin in request.app[CONFIG].allowed_origins:
        return {"Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Accept", "Access-Control-Max-Age": "86400", "Vary": "Origin"}
    return {"Vary": "Origin"}


def answer(request: web.Request, status: int, error: str | None = None) -> web.Response:
    body = {"ok": True} if error is None else {"ok": False, "error": error}
    return web.json_response(body, status=status, headers={"Cache-Control": "no-store", **cors_headers(request)})


def html(body: str, status: int = 200) -> web.Response:
    return web.Response(text=body, status=status, content_type="text/html", charset="utf-8",
                        headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY",
                                 "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"})


def check_signup(fields: dict[str, str], min_seconds: float) -> tuple[str, str]:
    """(email, lang), or Rejected."""
    if (fields.get("_gotcha") or "").strip():
        raise Rejected("honeypot", silent=True)
    try:
        elapsed = float((fields.get("_elapsed") or "").strip()) / 1000
    except ValueError:
        raise Rejected("missing or bad time field") from None
    if elapsed < min_seconds:
        raise Rejected("sent too fast")
    email = (fields.get("email") or "").strip()
    if not email or len(email) > MAX_EMAIL or not EMAIL.match(email):
        raise Rejected("that email address doesn't look right")
    return email, lang_or_default(fields.get("lang"))


async def subscribe(request: web.Request) -> web.Response:
    config, store = request.app[CONFIG], request.app[STORE]
    who = ip_hash(request)
    if request.headers.get("Origin", "").rstrip("/") not in config.allowed_origins:
        log.info("rejected %s: origin not allowed", who)
        return answer(request, 403, "not allowed from this site")
    if not request.app[LIMITER].allow(who):
        log.info("rejected %s: rate limited", who)
        return answer(request, 429, "too many signups, please try again later")
    try:
        form = await read_form(request, 0)
        email, lang = check_signup(form.fields, config.min_seconds)
    except Rejected as rejected:
        log.info("rejected %s: %s", who, rejected.reason)
        return answer(request, 200) if rejected.silent else answer(request, rejected.status, rejected.reason)

    pending = store.prepare(email, lang)
    if pending is None:
        # Already confirmed, or a link went out recently: nothing to send, and the same answer.
        log.info("signup %s: nothing to send", who)
        return answer(request, 200)
    if store.mails_today() >= config.daily_max:
        log.warning("signup %s: the daily limit of %d confirm emails is reached", who, config.daily_max)
        return answer(request, 429, "too many signups today, please try again tomorrow")
    try:
        await asyncio.to_thread(request.app[SEND], config, mail.build_confirm_email(config, pending))
    except Exception as error:  # noqa: BLE001 - any SMTP failure is the same to the visitor
        # The error's type only: SMTP errors can quote the address.
        log.error("signup %s: send failed: %s", who, type(error).__name__)
        return answer(request, 502, "the email couldn't be sent, please try again later")
    store.sent(pending)
    log.info("signup %s: confirm email sent (%s)", who, "new" if pending.new else "again")
    return answer(request, 200)


async def token_of(request: web.Request) -> str:
    token = request.query.get("t", "")
    if not token and request.method == "POST" and request.content_type == "application/x-www-form-urlencoded":
        token = (await request.post()).get("t", "")
    token = token if isinstance(token, str) else ""
    return token.strip() if len(token) <= MAX_TOKEN else ""


async def confirm_page(request: web.Request) -> web.Response:
    store = request.app[STORE]
    token = await token_of(request)
    lang = store.pending_lang(token) if token else None
    if lang is None:
        return html(page("en", "bad_link_title", "bad_link_line"), 404)
    return html(page(lang, "confirm_title", "confirm_line", ("confirm", token, "confirm_button")))


async def confirm(request: web.Request) -> web.Response:
    store = request.app[STORE]
    token = await token_of(request)
    lang = store.confirm(token) if token else None
    if lang is None:
        log.info("confirm: unknown or used link")
        return html(page("en", "bad_link_title", "bad_link_line"), 404)
    log.info("confirmed one address")
    return html(page(lang, "confirmed_title", "confirmed_line"))


async def unsubscribe_page(request: web.Request) -> web.Response:
    token = await token_of(request)
    lang = request.app[STORE].lang_of(token) if token else None
    if lang is None:
        # Not on the list (any more): say so the same way as after unsubscribing.
        return html(page("en", "unsubbed_title", "unsubbed_line"))
    return html(page(lang, "unsub_title", "unsub_line", ("unsubscribe", token, "unsub_button")))


async def unsubscribe(request: web.Request) -> web.Response:
    store = request.app[STORE]
    token = await token_of(request)
    lang = store.lang_of(token) if token else None
    removed = store.unsubscribe(token) if token else False
    log.info("unsubscribe: %s", "removed one address" if removed else "not on the list")
    if request.content_type == "application/x-www-form-urlencoded" and request.query.get("t"):
        # The mail app's one-click POST: it only wants a 200.
        return web.Response(text="ok", headers={"Cache-Control": "no-store"})
    return html(page(lang or "en", "unsubbed_title", "unsubbed_line"))


async def preflight(request: web.Request) -> web.Response:
    return web.Response(status=204, headers=cors_headers(request))


async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True}, headers={"Cache-Control": "no-store"})


@web.middleware
async def errors(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException as error:
        if error.status >= 400:
            return answer(request, error.status, error.reason)
        raise


async def _hourly_cleanup(app: web.Application):
    async def loop():
        while True:
            app[STORE].cleanup()
            app[STORE].write_stats()
            await asyncio.sleep(3600)
    task = asyncio.create_task(loop())
    yield
    task.cancel()
    app[STORE].close()


def make_app(config: Config, send: Callable | None = None, store: Store | None = None) -> web.Application:
    app = web.Application(client_max_size=MAX_BODY, middlewares=[errors])
    app[CONFIG] = config
    app[STORE] = store or Store(config.data_dir)
    app[LIMITER] = RateLimiter(config.rate_limit, config.rate_window)
    app[SALT] = secrets.token_bytes(16)
    app[SEND] = send or mail.send_email
    app.cleanup_ctx.append(_hourly_cleanup)
    for prefix in ("", "/news"):
        app.router.add_post(f"{prefix}/subscribe", subscribe)
        app.router.add_route("OPTIONS", f"{prefix}/subscribe", preflight)
        app.router.add_get(f"{prefix}/confirm", confirm_page)
        app.router.add_post(f"{prefix}/confirm", confirm)
        app.router.add_get(f"{prefix}/unsubscribe", unsubscribe_page)
        app.router.add_post(f"{prefix}/unsubscribe", unsubscribe)
        app.router.add_get(f"{prefix}/health", health)
    return app
