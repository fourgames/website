"""The routes. Caddy forwards https://api.fourgames.se/alerts/* here; each route answers with and
without the /alerts prefix, so it works whether Caddy strips it (handle_path) or not (handle).

    GET  /youtube   the hub checking a subscription
    POST /youtube   YouTube's notifications
    POST /twitch    Twitch's notifications, checks and revocations
    GET  /health    whether it runs, the subscriptions and the last check
"""

from __future__ import annotations

import time

from aiohttp import web

from .checks import Checks
from .twitch import Twitch
from .youtube import YouTube

STATUS_PAGE_ORIGIN = "https://status.fourgames.se"
CHECKS_KEY = web.AppKey("checks", Checks)
YOUTUBE_KEY = web.AppKey("youtube", object)
TWITCH_KEY = web.AppKey("twitch", object)


async def health(request: web.Request) -> web.Response:
    app = request.app
    youtube, twitch = app[YOUTUBE_KEY], app[TWITCH_KEY]
    body = {
        "ok": True,
        "time": int(time.time()),
        "youtube": youtube.health() if youtube else None,
        "twitch": twitch.health() if twitch else None,
        "checks": app[CHECKS_KEY].health(),
    }
    # The status page (server/status-page) may read this from the visitor's browser, like the key bot's.
    return web.json_response(body, headers={"Access-Control-Allow-Origin": STATUS_PAGE_ORIGIN,
                                            "Cache-Control": "no-store"})


def build_app(checks: Checks, youtube: YouTube | None, twitch: Twitch | None) -> web.Application:
    # Notifications are small; anything bigger isn't one.
    app = web.Application(client_max_size=256 * 1024)
    app[CHECKS_KEY] = checks
    app[YOUTUBE_KEY] = youtube
    app[TWITCH_KEY] = twitch
    for prefix in ("", "/alerts"):
        app.router.add_get(f"{prefix}/health", health)
        if youtube:
            app.router.add_get(f"{prefix}/youtube", youtube.verify)
            app.router.add_post(f"{prefix}/youtube", youtube.notify)
        if twitch:
            app.router.add_post(f"{prefix}/twitch", twitch.callback)
    return app
