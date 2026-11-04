"""/privacy: players opt out, opt back in, download or see their game data, via their Steam account.

The Steam account is the one linked to their Discord, read on /callback with the same login as
/request (scopes identify and connections), and only if Discord has verified it. The steamid goes
straight to the game-data service's internal API (server/gamedata/SPEC.md, "Internal endpoints")
and is never stored or logged here.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Mapping

import aiohttp

from .config import Config

log = logging.getLogger("keybot.privacy")

PRIVACY_URL = "https://fourgames.se/privacy"

# action → the button's label.
ACTIONS = {
    "optout": "Opt out",
    "optin": "Opt back in",
    "export": "Download my data",
    "status": "Show what you have",
}

INTRO_TEXT = (
    "Our games send us how you play (sessions, game actions), your hardware and settings, and crash "
    "reports, tied to your Steam account, only to improve the games and fix bugs.\n"
    f"It's on by default and you can opt out any time. The details: {PRIVACY_URL}"
)
NO_KEY_TEXT = f"Sign in with Steam at {PRIVACY_URL} to opt out, opt back in, or see and download your data."
BUTTONS_TEXT = "Pick one below; each asks you to sign in with Discord so we can see your linked Steam account."

NO_STEAM_TEXT = (
    "Your Discord account has no verified Steam connection. Link Steam in Discord (User Settings → "
    "Connections → Steam), then run /privacy again, or sign in with Steam on " + PRIVACY_URL + "."
)


class GamedataError(Exception):
    """The internal API didn't answer, or answered with an error."""


@dataclass(frozen=True)
class Result:
    """What the callback page shows, and what the bot tells them in Discord."""

    title: str
    lines: list[str]
    discord_text: str
    status: int = 200
    # (label, url) for the export's one-time download link. Only ever shown on the page.
    link: tuple[str, str] | None = field(default=None, repr=False)


def steam_id(connections: list[dict]) -> str | None:
    """The steamid64 of their Steam connection, only if Discord verified it (they proved they own it)."""
    for connection in connections or []:
        if not isinstance(connection, dict):
            continue
        if connection.get("type") != "steam" or connection.get("verified") is not True:
            continue
        value = str(connection.get("id") or "")
        if value.isdigit() and len(value) == 17:
            return value
    return None


async def call(session: aiohttp.ClientSession, config: Config, path: str, body: dict) -> dict:
    """POST to the internal API. Raises GamedataError without saying what was sent."""
    try:
        async with session.post(f"{config.gamedata_internal_url}{path}", json=body,
                                headers={"X-Internal-Key": config.gamedata_internal_key}) as response:
            data = await response.json(content_type=None)
            if response.status >= 400 or not isinstance(data, dict) or data.get("ok") is not True:
                code = data.get("error") if isinstance(data, dict) else None
                raise GamedataError(f"{path}: HTTP {response.status} {code or ''}".strip())
            return data
    except (aiohttp.ClientError, TimeoutError, ValueError) as error:
        raise GamedataError(f"{path}: {type(error).__name__}") from None


def duration_text(seconds: int) -> str:
    minutes = max(0, int(seconds)) // 60
    hours, minutes = divmod(minutes, 60)
    return f"{hours} h {minutes} min" if hours else f"{minutes} min"


def date_text(value) -> str:
    """first_seen / last_seen as a date, whether the service sends unix time or ISO text."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value, timezone.utc).date().isoformat()
    if isinstance(value, str) and value:
        return value[:10]
    return "?"


def status_lines(data: dict, game_names: Mapping[int, str]) -> list[str]:
    lines = ["You're opted out: the games send nothing." if data.get("opted_out")
             else "You're opted in: the games send data while you play."]
    games = [g for g in data.get("games") or [] if isinstance(g, dict)]
    if not games:
        lines.append("We have no game data from your Steam account.")
    for game in games:
        try:
            app_id = int(game.get("app_id"))
        except (TypeError, ValueError):
            app_id = 0
        name = game_names.get(app_id) or f"App {app_id}"
        lines.append(f"{name}: {int(game.get('sessions') or 0)} session(s), "
                     f"{duration_text(game.get('playtime_s') or 0)} played, "
                     f"{date_text(game.get('first_seen'))} to {date_text(game.get('last_seen'))}.")
    return lines


async def perform(session: aiohttp.ClientSession, config: Config, action: str, connections: list[dict],
                  game_names: Mapping[int, str] | None = None) -> Result:
    """Does the action for the Steam account in their verified connections."""
    if not config.gamedata_internal_key:
        return Result("Use the website instead", [NO_KEY_TEXT], NO_KEY_TEXT)
    if action not in ACTIONS:
        return Result("This link doesn't work", ["Run /privacy again in Discord for a new one."],
                      "That didn't work. Run /privacy again.", 400)
    steamid = steam_id(connections)
    if steamid is None:
        return Result("No verified Steam account", [NO_STEAM_TEXT], NO_STEAM_TEXT)

    try:
        if action in ("optout", "optin"):
            opted_out = action == "optout"
            await call(session, config, "/internal/optout", {"steamid": steamid, "opted_out": opted_out})
            if opted_out:
                text = ("You're opted out. Our games stop sending data from your Steam account from their "
                        "next start. Opt back in any time with /privacy.")
                return Result("You're opted out", [text], text)
            text = "You're opted back in. Thanks: it helps us find bugs and make the games better."
            return Result("You're opted back in", [text], text)
        if action == "status":
            data = await call(session, config, "/internal/status", {"steamid": steamid})
            lines = status_lines(data, game_names or {})
            return Result("What we have", lines + [f"To download all of it, use /privacy or {PRIVACY_URL}."],
                          "\n".join(lines))
        data = await call(session, config, "/internal/export-link", {"steamid": steamid})
        url = str(data.get("url") or "")
        if not url.startswith("https://"):
            raise GamedataError("/internal/export-link: no usable url")
        minutes = max(1, int(data.get("expires_in") or 900) // 60)
        return Result(
            "Your data is ready",
            [f"The link downloads a zip of everything we store for your Steam account (JSON, with a "
             f"README). It works once, for {minutes} minutes."],
            "Your download link is on the page you signed in on. It works once, for "
            f"{minutes} minutes; run /privacy again for a new one.",
            link=("Download my data", url),
        )
    except GamedataError as error:
        # The error names the endpoint and status only, never the steamid.
        log.warning("privacy %s failed: %s", action, error)
        text = f"We couldn't reach the game data right now. Try /privacy again in a bit, or use {PRIVACY_URL}."
        return Result("Something went wrong", [text], text, 502)
