"""The web side of creator verification, in the same process as the bot.

/verify checks the link from /request and sends the person to Discord's login (scopes identify and
connections). Discord sends them back to /callback, where we read their verified YouTube and Twitch
connections, look the channels up, and approve or pass the request to the admins.

Caddy forwards https://api.fourgames.se/keybot/* here. The routes answer both with and without the
/keybot prefix, so it works whether Caddy strips it (handle_path) or not (handle).
"""

from __future__ import annotations

import html
import logging
import time
from typing import TYPE_CHECKING
from urllib.parse import urlencode

import aiohttp
from aiohttp import web

from .lookups import look_up
from .state import StateError, verify_state

if TYPE_CHECKING:
    from .bot import KeyBot

log = logging.getLogger("keybot.web")

DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize"
DISCORD_API = "https://discord.com/api/v10"
BOT_KEY = web.AppKey("bot", object)

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{title} · Four Games</title>
<style>
  body {{ font-family: system-ui, sans-serif; background: #f6f6f6; color: #1a1a1a; margin: 0;
         display: grid; place-items: center; min-height: 100vh; padding: 16px; box-sizing: border-box; }}
  main {{ max-width: 28rem; }}
  h1 {{ font-size: 1.5rem; margin: 0 0 .5rem; }}
  p {{ line-height: 1.5; margin: 0; }}
  @media (prefers-color-scheme: dark) {{ body {{ background: #161616; color: #eee; }} }}
</style>
</head>
<body><main><h1>{title}</h1><p>{text}</p></main></body>
</html>
"""


def page(title: str, text: str, status: int = 200) -> web.Response:
    body = PAGE.format(title=html.escape(title), text=html.escape(text))
    # no-store: the page can say things about the person; no cache should keep it.
    return web.Response(text=body, status=status, content_type="text/html",
                        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


def expired_page(reason: str) -> web.Response:
    if reason == "expired":
        return page("This link has expired", "Links work for 15 minutes. Run /request again in Discord.", 400)
    if reason == "used":
        return page("This link was already used", "Run /request again in Discord for a new one.", 400)
    return page("This link doesn't work", "Run /request again in Discord for a new one.", 400)


async def verify(request: web.Request) -> web.Response:
    bot: KeyBot = request.app[BOT_KEY]
    token = request.query.get("state", "")
    try:
        state = verify_state(bot.config.state_secret, token)
    except StateError as error:
        return expired_page(str(error))
    if not bot.store.state_usable(state.nonce):
        return expired_page("used")
    query = urlencode({
        "client_id": bot.config.client_id,
        "redirect_uri": bot.config.redirect_uri,
        "response_type": "code",
        "scope": "identify connections",
        "state": token,
    })
    raise web.HTTPFound(f"{DISCORD_AUTHORIZE}?{query}")


async def callback(request: web.Request) -> web.Response:
    bot: KeyBot = request.app[BOT_KEY]
    if request.query.get("error"):
        return page("Cancelled", "Nothing was sent. Run /request again in Discord whenever you like.")
    try:
        state = verify_state(bot.config.state_secret, request.query.get("state", ""))
    except StateError as error:
        return expired_page(str(error))
    code = request.query.get("code")
    if not code:
        return expired_page("invalid")
    # One use per link, taken before anything else so a reload can't run it twice.
    if not bot.store.use_state(state.nonce):
        return expired_page("used")

    session = bot.http_session
    try:
        token = await exchange_code(session, bot, code)
        try:
            me = await discord_get(session, token, "/users/@me")
            connections = await discord_get(session, token, "/users/@me/connections")
        finally:
            await revoke(session, bot, token)  # we only needed it for these two reads
    except (aiohttp.ClientError, TimeoutError, ValueError, KeyError) as error:
        log.warning("Discord login failed: %s", type(error).__name__)
        return page("Discord login didn't work", "Run /request again in Discord and try once more.", 502)

    # The link belongs to whoever ran /request. Someone else's login can't stand in for them.
    if str(me.get("id")) != str(state.user_id):
        return page("That's a different Discord account",
                    "Sign in with the account you used for /request, then run /request again.", 403)

    try:
        channels = await look_up(session, bot.config.youtube_api_key, bot.twitch, connections)
        title, text = await bot.creator_verified(state.user_id, state.game_id, channels)
    except Exception:
        log.exception("creator verification failed for %s", state.user_id)
        return page("Something went wrong", "Try /request again in Discord in a bit.", 500)
    return page(title, text)


async def exchange_code(session: aiohttp.ClientSession, bot: KeyBot, code: str) -> str:
    async with session.post(f"{DISCORD_API}/oauth2/token", data={
        "grant_type": "authorization_code", "code": code, "redirect_uri": bot.config.redirect_uri,
    }, auth=aiohttp.BasicAuth(bot.config.client_id, bot.config.client_secret)) as response:
        response.raise_for_status()
        return (await response.json())["access_token"]


async def discord_get(session: aiohttp.ClientSession, token: str, path: str):
    async with session.get(f"{DISCORD_API}{path}", headers={"Authorization": f"Bearer {token}"}) as response:
        response.raise_for_status()
        return await response.json()


async def revoke(session: aiohttp.ClientSession, bot: KeyBot, token: str) -> None:
    try:
        async with session.post(f"{DISCORD_API}/oauth2/token/revoke", data={
            "token": token, "token_type_hint": "access_token",
        }, auth=aiohttp.BasicAuth(bot.config.client_id, bot.config.client_secret)):
            pass
    except aiohttp.ClientError:
        pass  # it expires by itself within a week


STATUS_PAGE_ORIGIN = "https://status.fourgames.se"


async def health(request: web.Request) -> web.Response:
    # The status page (server/status-page) reads this from the visitor's browser.
    return web.json_response({"ok": True, "time": int(time.time())},
                             headers={"Access-Control-Allow-Origin": STATUS_PAGE_ORIGIN,
                                      "Cache-Control": "no-store"})


def build_app(bot: KeyBot) -> web.Application:
    app = web.Application()
    app[BOT_KEY] = bot
    for prefix in ("", "/keybot"):
        app.router.add_get(f"{prefix}/verify", verify)
        app.router.add_get(f"{prefix}/callback", callback)
        app.router.add_get(f"{prefix}/health", health)
    return app


async def start_web(bot: KeyBot) -> web.AppRunner:
    # No access log: callback URLs carry the one-time login code and state.
    runner = web.AppRunner(build_app(bot), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, bot.config.host, bot.config.port).start()
    return runner
