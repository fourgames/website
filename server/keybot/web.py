"""The web side of creator verification, in the same process as the bot.

/verify checks the link from /request and shows a page that says who we are and what Discord will
and won't show us; its Continue button goes to /login, which sends the person to Discord's login
(scopes identify and connections). Discord sends them back to /callback, where we read their verified YouTube and Twitch
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

LOGO = (
    '<svg viewBox="0 0 512 512" aria-hidden="true"><defs><radialGradient id="g"><stop offset="0" '
    'stop-color="#4a90e2"/><stop offset="1" stop-color="#48baff"/></radialGradient></defs><path fill="url(#g)" '
    'stroke="#fff" stroke-width="20" d="M105.186 26.426c-38.314.06-62.13 26.334-31.37 72.994C6.192 97.785-9.36 '
    '188.75 62.29 218.39c54.838 22.684 82.008-6.012 142.985 15.008-64.015-7.88-119.143 21.696-153.814 66.6-38.507 '
    '49.87-24.104 120.148 40.41 100.332-9.024 67.12 62.385 100.137 103.907 47.166 35.793-45.66 15.51-103.756 '
    '41.842-182.885 7.1 61.706-5.617 108.762 11.573 166.478 21.393 71.83 103.075 75.605 118.537 6.34 55.84 51.31 '
    '95.82-9.41 75.754-76.643-17.993-60.285-90.76-98.2-167.65-118.703 72.808-3.032 108.846 44.51 167.78 30.084 '
    '72.446-17.734 64.365-108.426-10.823-128.922 45.767-54.918-19.446-110.047-87.18-93.117-57.113 14.275-90.85 '
    '71.977-101.928 143.33-5.55-65.618-28.823-120.138-81.03-150.316-19.64-11.353-40.05-16.74-57.466-16.714z"/></svg>'
)

# Discord's mark, for the button that leads to Discord's own sign-in page.
DISCORD_MARK = (
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52'
    '.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.25a18.3 18.3 0 0 0-5.49 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04'
    'A19.7 19.7 0 0 0 3.68 4.37a.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 '
    '5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.22-2a.08.08 0 0 0-.04-.1 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1 '
    '0-.12l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08 0l.37.3a.08.08 0 0 1 0 .12c-.6'
    '.35-1.22.65-1.87.9a.08.08 0 0 0-.04.1c.36.7.77 1.37 1.22 2a.08.08 0 0 0 .08.03 19.8 19.8 0 0 0 6-3.03.08.08 0 0 '
    '0 .03-.05c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 '
    '2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 '
    '2.15-2.42 1.22 0 2.18 1.1 2.16 2.42 0 1.34-.94 2.42-2.16 2.42z"/></svg>'
)

ICONS = {
    "success": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    "pending": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    "info": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/></svg>',
    "problem": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.4v.1"/></svg>',
}

# The site's palette (src/style.css), so the pages look like fourgames.se.
PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{title} · Four Games</title>
<link rel="icon" href="https://fourgames.se/favicon.svg" type="image/svg+xml">
<style>
  @font-face {{ font-family: Montserrat; font-weight: 100 900; font-display: swap;
               src: url(https://fourgames.se/fonts/montserrat-latin-wght-normal.woff2) format("woff2"); }}
  :root {{ color-scheme: light dark; --base: #eff1f5; --card: #fff; --text: #4a5365; --title: #333f67;
          --muted: #66748f; --line: rgb(0 0 0 / .08); --primary: hsl(206 58% 42%); --good: #2f8a57;
          --wait: #b7791f; --bad: #c2415a; --shadow: 0 1px 3px rgb(0 0 0 / .08), 0 8px 24px rgb(51 63 103 / .08); }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --base: #202326; --card: #2c2f32; --text: hsl(0 0% 100% / .88); --title: #fff;
            --muted: hsl(0 0% 100% / .62); --line: rgb(255 255 255 / .1); --primary: hsl(200 60% 70%);
            --good: #5fd08f; --wait: #f0b45a; --bad: #f2849a; --shadow: 0 8px 24px rgb(0 0 0 / .35); }} }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
         justify-content: center; padding: 24px 16px; background: var(--base); color: var(--text);
         font: 16px/1.55 Montserrat, system-ui, sans-serif; }}
  .brand {{ display: flex; align-items: center; gap: 10px; margin-bottom: 20px; color: var(--title);
           font-weight: 700; font-size: 1.1rem; text-decoration: none; }}
  .brand svg {{ width: 34px; height: 34px; }}
  main {{ width: 100%; max-width: 30rem; background: var(--card); border-radius: 16px; padding: 28px;
         box-shadow: var(--shadow); }}
  h1 {{ margin: 0 0 6px; color: var(--title); font-size: 1.45rem; line-height: 1.25; }}
  p {{ margin: 0 0 14px; }}
  .lead {{ color: var(--muted); margin-bottom: 22px; }}
  .lead strong {{ color: var(--title); }}
  .status {{ width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; margin-bottom: 16px;
            background: color-mix(in srgb, currentColor 14%, transparent); }}
  .status svg {{ width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 2.2;
                stroke-linecap: round; stroke-linejoin: round; }}
  .success {{ color: var(--good); }} .pending {{ color: var(--wait); }} .problem {{ color: var(--bad); }}
  .info {{ color: var(--primary); }}
  h2 {{ font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 18px 0 8px; }}
  ul {{ list-style: none; margin: 0; padding: 0; }}
  li {{ display: flex; gap: 10px; padding: 4px 0; }}
  li::before {{ flex: none; width: 1.2em; font-weight: 700; }}
  .yes li::before {{ content: "✓"; color: var(--good); }}
  .no li::before {{ content: "✕"; color: var(--bad); }}
  .note {{ margin-top: 20px; padding: 12px 14px; border-radius: 10px; background: var(--base); font-size: .92rem; }}
  .button {{ display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; margin-top: 22px;
            padding: 13px 18px; border-radius: 10px; background: #5865f2; color: #fff; font-weight: 600;
            text-decoration: none; font-size: 1rem; }}
  .button:hover {{ background: #4752c4; }}
  .button svg {{ width: 22px; height: 22px; }}
  .small {{ margin: 12px 0 0; font-size: .85rem; color: var(--muted); text-align: center; }}
  footer {{ margin-top: 20px; font-size: .85rem; color: var(--muted); text-align: center; }}
  a {{ color: var(--primary); }}
  footer a {{ color: inherit; }}
</style>
</head>
<body>
<a class="brand" href="https://fourgames.se">{logo}<span>Four Games</span></a>
<main>{body}</main>
<footer><a href="https://fourgames.se">fourgames.se</a> · <a href="https://fourgames.se/privacy">Privacy</a>
 · <a href="https://discord.fourgames.se">Our Discord</a></footer>
</body>
</html>
"""


def render(title: str, body: str, status: int = 200) -> web.Response:
    """A page around body, which must already be escaped HTML."""
    text = PAGE.format(title=html.escape(title), logo=LOGO, body=body)
    # no-store: the page can say things about the person; no cache should keep it.
    return web.Response(text=text, status=status, content_type="text/html",
                        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                                 "X-Frame-Options": "DENY"})


# Results from KeyBot.creator_verified and this module, by how they went. Anything else is a problem.
SUCCESS_TITLES = {"Verified — check your DMs", "You already have a key"}
# Amber: waiting, or one step for them to fix. Blue: nothing wrong, just start again.
PENDING_TITLES = {"Sent for review", "Already waiting for review", "Verified, but we couldn't DM you",
                  "Too many open requests"}
INFO_TITLES = {"Cancelled", "This link has expired", "This link was already used", "This link doesn't work"}


def tone_for(title: str) -> str:
    if title in SUCCESS_TITLES:
        return "success"
    if title in PENDING_TITLES:
        return "pending"
    return "info" if title in INFO_TITLES else "problem"


def page(title: str, text: str, status: int = 200, tone: str | None = None) -> web.Response:
    tone = tone or tone_for(title)
    body = (f'<div class="status {tone}">{ICONS[tone]}</div><h1>{html.escape(title)}</h1>'
            f'<p>{html.escape(text)}</p>'
            '<p class="small">You can close this tab and go back to Discord.</p>')
    return render(title, body, status)


def expired_page(reason: str) -> web.Response:
    if reason == "expired":
        return page("This link has expired", "Links work for 15 minutes. Run /request again in Discord.", 400)
    if reason == "used":
        return page("This link was already used", "Run /request again in Discord for a new one.", 400)
    return page("This link doesn't work", "Run /request again in Discord for a new one.", 400)


def landing_page(game_name: str, token: str, minutes_left: int) -> web.Response:
    """What a creator sees first: who we are, what Discord will show us and what it won't."""
    minutes = "1 minute" if minutes_left == 1 else f"{minutes_left} minutes"
    body = (
        '<h1>Verify your channel</h1>'
        f'<p class="lead">for a free Steam key to <strong>{html.escape(game_name)}</strong></p>'
        '<p>Discord will ask you to share your connected accounts with Four Games. '
        'Here is exactly what that means:</p>'
        '<h2>We see</h2><ul class="yes">'
        '<li>Your Discord username</li>'
        '<li>Your YouTube or Twitch channel, if it\'s linked to your Discord</li>'
        '</ul>'
        '<h2>We never see</h2><ul class="no">'
        '<li>Your password or email address</li>'
        '<li>Your messages, servers or friends</li>'
        '<li>Anything that lets us post or act as you</li>'
        '</ul>'
        '<div class="note">We read your channels once, then hand the access straight back to Discord. '
        'We only keep the channel we checked, as our '
        '<a href="https://fourgames.se/privacy">privacy policy</a> says.</div>'
        f'<a class="button" href="login?state={html.escape(token, quote=True)}">{DISCORD_MARK}'
        'Continue with Discord</a>'
        f'<p class="small">This link works once and expires in {minutes}. Channel not linked yet? '
        'Link it in Discord under User Settings → Connections first.</p>'
    )
    return render("Verify your channel", body)


async def verify(request: web.Request) -> web.Response:
    """The link from /request: explains what happens, then Continue goes to login."""
    bot: KeyBot = request.app[BOT_KEY]
    token = request.query.get("state", "")
    try:
        state = verify_state(bot.config.state_secret, token)
    except StateError as error:
        return expired_page(str(error))
    if not bot.store.state_usable(state.nonce):
        return expired_page("used")
    game = bot.store.game(state.game_id)
    if game is None:
        return page("Something's off", "That game isn't in the list any more. Run /request again in Discord.", 404)
    minutes_left = max(1, (state.expires_at - int(time.time()) + 59) // 60)
    return landing_page(game["name"], token, minutes_left)


async def login(request: web.Request) -> web.Response:
    """Continue with Discord: off to Discord's own sign-in page."""
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
        app.router.add_get(f"{prefix}/login", login)
        app.router.add_get(f"{prefix}/callback", callback)
        app.router.add_get(f"{prefix}/health", health)
    return app


async def start_web(bot: KeyBot) -> web.AppRunner:
    # No access log: callback URLs carry the one-time login code and state.
    runner = web.AppRunner(build_app(bot), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, bot.config.host, bot.config.port).start()
    return runner
