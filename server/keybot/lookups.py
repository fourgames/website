"""Looks up a creator's verified Discord connections on YouTube and Twitch.

Each lookup returns a Channel; a failure becomes Channel.error instead of an exception, so one
broken platform still sends the request to the admins rather than losing it.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime

import aiohttp

from .eligibility import Channel

log = logging.getLogger("keybot.lookups")

YOUTUBE_API = "https://www.googleapis.com/youtube/v3"
TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token"
TWITCH_API = "https://api.twitch.tv/helix"


def verified_connections(connections: list[dict]) -> list[dict]:
    """Only connections Discord has verified (the person proved they own it) on platforms we check."""
    return [
        c for c in connections
        if c.get("verified") is True and c.get("type") in ("youtube", "twitch") and c.get("id")
    ]


def parse_time(text: str | None) -> datetime | None:
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_youtube(channel_id: str, fallback_name: str, channels_json: dict,
                  playlist_json: dict | None) -> Channel:
    """A Channel from channels.list and playlistItems.list (the uploads playlist) responses."""
    items = channels_json.get("items") or []
    if not items:
        return Channel("youtube", channel_id, fallback_name, f"https://www.youtube.com/channel/{channel_id}",
                       error="channel not found")
    item = items[0]
    snippet = item.get("snippet", {})
    stats = item.get("statistics", {})
    handle = snippet.get("customUrl")  # "@name"
    url = f"https://www.youtube.com/{handle}" if handle else f"https://www.youtube.com/channel/{channel_id}"
    audience = None
    if not stats.get("hiddenSubscriberCount") and stats.get("subscriberCount") is not None:
        audience = int(stats["subscriberCount"])
    last_upload = None
    if playlist_json:
        uploads = playlist_json.get("items") or []
        if uploads:
            details = uploads[0].get("contentDetails", {})
            last_upload = parse_time(details.get("videoPublishedAt")) or parse_time(
                uploads[0].get("snippet", {}).get("publishedAt"))
    return Channel("youtube", channel_id, snippet.get("title") or fallback_name, url,
                   audience=audience, last_upload=last_upload)


def parse_twitch(user_id: str, fallback_name: str, users_json: dict, followers_json: dict) -> Channel:
    users = users_json.get("data") or []
    if not users:
        return Channel("twitch", user_id, fallback_name, f"https://www.twitch.tv/{fallback_name}",
                       error="channel not found")
    login = users[0].get("login") or fallback_name
    total = followers_json.get("total")
    return Channel("twitch", user_id, users[0].get("display_name") or login, f"https://www.twitch.tv/{login}",
                   audience=int(total) if total is not None else None)


async def youtube_channel(session: aiohttp.ClientSession, api_key: str, connection: dict) -> Channel:
    channel_id, name = str(connection["id"]), connection.get("name") or ""
    if not api_key:
        return Channel("youtube", channel_id, name, f"https://www.youtube.com/channel/{channel_id}",
                       error="YOUTUBE_API_KEY isn't set")
    try:
        async with session.get(f"{YOUTUBE_API}/channels", params={
            "part": "snippet,statistics,contentDetails", "id": channel_id, "key": api_key,
        }) as response:
            response.raise_for_status()
            channels_json = await response.json()
        playlist_json = None
        items = channels_json.get("items") or []
        uploads = items[0].get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads") if items else None
        if uploads:
            async with session.get(f"{YOUTUBE_API}/playlistItems", params={
                "part": "contentDetails", "playlistId": uploads, "maxResults": "1", "key": api_key,
            }) as response:
                # A channel with no videos has no uploads playlist: YouTube answers 404.
                if response.status != 404:
                    response.raise_for_status()
                    playlist_json = await response.json()
        return parse_youtube(channel_id, name, channels_json, playlist_json)
    except (aiohttp.ClientError, TimeoutError, ValueError) as error:
        # The URL holds the API key, so log the error type only.
        log.warning("YouTube lookup for %s failed: %s", channel_id, type(error).__name__)
        return Channel("youtube", channel_id, name, f"https://www.youtube.com/channel/{channel_id}",
                       error="YouTube API error")


class TwitchAuth:
    """An app access token (client credentials), reused until it's about to expire."""

    def __init__(self, client_id: str, client_secret: str):
        self.client_id = client_id
        self.client_secret = client_secret
        self._token: str | None = None
        self._expires = 0.0

    async def token(self, session: aiohttp.ClientSession) -> str:
        if self._token and time.time() < self._expires - 60:
            return self._token
        async with session.post(TWITCH_TOKEN_URL, data={
            "client_id": self.client_id, "client_secret": self.client_secret, "grant_type": "client_credentials",
        }) as response:
            response.raise_for_status()
            data = await response.json()
        self._token = data["access_token"]
        self._expires = time.time() + float(data.get("expires_in", 3600))
        return self._token


async def twitch_channel(session: aiohttp.ClientSession, auth: TwitchAuth, connection: dict) -> Channel:
    user_id, name = str(connection["id"]), connection.get("name") or ""
    if not auth.client_id or not auth.client_secret:
        return Channel("twitch", user_id, name, f"https://www.twitch.tv/{name}",
                       error="TWITCH_CLIENT_ID/SECRET aren't set")
    try:
        headers = {"Client-Id": auth.client_id, "Authorization": f"Bearer {await auth.token(session)}"}
        # Discord stores the Twitch user id; fall back to the login name if it ever isn't one.
        query = {"id": user_id} if user_id.isdigit() else {"login": name or user_id}
        async with session.get(f"{TWITCH_API}/users", params=query, headers=headers) as response:
            response.raise_for_status()
            users_json = await response.json()
        users = users_json.get("data") or []
        followers_json: dict = {}
        if users:
            async with session.get(f"{TWITCH_API}/channels/followers",
                                   params={"broadcaster_id": users[0]["id"]}, headers=headers) as response:
                response.raise_for_status()
                followers_json = await response.json()
        return parse_twitch(user_id, name, users_json, followers_json)
    except (aiohttp.ClientError, TimeoutError, ValueError, KeyError) as error:
        log.warning("Twitch lookup for %s failed: %s", user_id, type(error).__name__)
        return Channel("twitch", user_id, name, f"https://www.twitch.tv/{name}", error="Twitch API error")


async def look_up(session: aiohttp.ClientSession, youtube_api_key: str, twitch: TwitchAuth,
                  connections: list[dict]) -> list[Channel]:
    channels = []
    for connection in verified_connections(connections):
        if connection["type"] == "youtube":
            channels.append(await youtube_channel(session, youtube_api_key, connection))
        else:
            channels.append(await twitch_channel(session, twitch, connection))
    return channels
