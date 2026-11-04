"""The HTTP side: POST /contact (or POST /) takes the form, GET /health says it's up.

Caddy forwards https://api.fourgames.se/contact here. The routes answer both with and without the
/contact prefix, so it works whether Caddy strips it (handle_path) or not (handle).

The logs never show a message, an email address or an IP: only the outcome and a hash of the IP.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import secrets
from typing import Callable

import aiohttp
from aiohttp import web

from . import mail
from .checks import RateLimiter, Rejected, check
from .config import Config

log = logging.getLogger("contact.web")

CONFIG = web.AppKey("config", Config)
LIMITER = web.AppKey("limiter", RateLimiter)
SALT = web.AppKey("salt", bytes)
# Replaceable in tests: (config, EmailMessage) -> None, blocking.
SEND = web.AppKey("send", Callable)
SESSION = web.AppKey("session", aiohttp.ClientSession)

# Form posts are small; anything bigger isn't from our form.
MAX_BODY = 64 * 1024


def client_ip(request: web.Request) -> str:
    """The visitor's IP. Behind Caddy that's in X-Forwarded-For; Caddy sets the header itself
    (it doesn't pass on one the visitor sent), so the last entry is the one Caddy saw. Only trusted
    when the request comes from this machine."""
    remote = request.remote or ""
    try:
        local = ipaddress.ip_address(remote).is_loopback
    except ValueError:
        local = False
    forwarded = request.headers.get("X-Forwarded-For", "")
    if local and forwarded:
        return forwarded.split(",")[-1].strip()
    return remote


def ip_hash(request: web.Request) -> str:
    # Salted per run, so the hash can tell repeat visits apart in the log but can't be reversed.
    return hashlib.sha256(request.app[SALT] + client_ip(request).encode()).hexdigest()[:12]


def cors_headers(request: web.Request) -> dict[str, str]:
    origin = request.headers.get("Origin", "").rstrip("/")
    if origin and origin in request.app[CONFIG].allowed_origins:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Accept",
            "Access-Control-Max-Age": "86400",
            "Vary": "Origin",
        }
    return {"Vary": "Origin"}


def answer(request: web.Request, status: int, error: str | None = None) -> web.Response:
    body = {"ok": True} if error is None else {"ok": False, "error": error}
    headers = {"Cache-Control": "no-store", **cors_headers(request)}
    return web.json_response(body, status=status, headers=headers)


async def read_fields(request: web.Request) -> dict[str, str]:
    if request.content_type == "application/json":
        try:
            data = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise Rejected("the body isn't valid JSON") from None
        if not isinstance(data, dict):
            raise Rejected("the body must be a JSON object")
    elif request.content_type in ("application/x-www-form-urlencoded", "multipart/form-data"):
        data = await request.post()
    else:
        raise Rejected("send the form as form data or JSON", status=415)
    # Only text fields; anything else (a file, a nested object) counts as empty.
    return {str(k): v if isinstance(v, str) else (str(v) if isinstance(v, (int, float)) else "")
            for k, v in data.items()}


async def contact(request: web.Request) -> web.Response:
    config = request.app[CONFIG]
    who = ip_hash(request)

    origin = request.headers.get("Origin", "").rstrip("/")
    if origin not in config.allowed_origins:
        log.info("rejected %s: origin not allowed", who)
        return answer(request, 403, "not allowed from this site")
    if not request.app[LIMITER].allow(who):
        log.info("rejected %s: rate limited", who)
        return answer(request, 429, "too many messages, please try again later")

    try:
        submission = check(await read_fields(request), config.min_seconds)
    except Rejected as rejected:
        log.info("rejected %s: %s", who, rejected.reason)
        if rejected.silent:
            return answer(request, 200)
        return answer(request, rejected.status, rejected.reason)

    try:
        message = mail.build_email(config, submission, who)
        await asyncio.to_thread(request.app[SEND], config, message)
    except Exception as error:  # noqa: BLE001 - any SMTP failure is the same to the visitor
        # The error's type only: SMTP errors can quote the addresses.
        log.error("send failed for %s: %s", who, type(error).__name__)
        return answer(request, 502, "the message couldn't be sent, please try again later")
    log.info("sent for %s", who)

    if config.discord_webhook_url:
        try:
            await mail.notify_discord(request.app[SESSION], config.discord_webhook_url, submission)
        except Exception as error:  # noqa: BLE001 - the mail went out; the notice is extra
            log.warning("discord notice failed: %s", type(error).__name__)
    return answer(request, 200)


async def preflight(request: web.Request) -> web.Response:
    return web.Response(status=204, headers=cors_headers(request))


async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True}, headers={"Cache-Control": "no-store"})


@web.middleware
async def errors(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPRequestEntityTooLarge:
        return answer(request, 413, "the message is too long")
    except web.HTTPException as error:
        if error.status >= 400:
            return answer(request, error.status, error.reason)
        raise


async def _session(app: web.Application):
    app[SESSION] = aiohttp.ClientSession()
    yield
    await app[SESSION].close()


def make_app(config: Config, send: Callable | None = None) -> web.Application:
    app = web.Application(client_max_size=MAX_BODY, middlewares=[errors])
    app[CONFIG] = config
    app[LIMITER] = RateLimiter(config.rate_limit, config.rate_window)
    app[SALT] = secrets.token_bytes(16)
    app[SEND] = send or mail.send_email
    app.cleanup_ctx.append(_session)
    for prefix in ("", "/contact"):
        app.router.add_post(prefix or "/", contact)
        app.router.add_route("OPTIONS", prefix or "/", preflight)
        app.router.add_get(f"{prefix}/health", health)
    return app
