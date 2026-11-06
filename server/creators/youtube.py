"""The YouTube Data API calls, and turning their replies into rows.

Costs (units): search 100, videos 1 per 50 videos, channels 1 per 50 channels. The free quota is
10,000 a day per Google Cloud project and starts over at midnight Pacific time.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from steamdata.net import Http, HttpError

from . import contacts
from .games import normalize

API = "https://www.googleapis.com/youtube/v3"
SEARCH_COST = 100
LIST_COST = 1
GAMING = "20"


class QuotaExceeded(Exception):
    pass


def iso_time(text: str | None) -> int | None:
    if not text:
        return None
    try:
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def to_iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def duration(text: str | None) -> int | None:
    """ISO 8601 durations like PT1H2M3S -> 3723."""
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", text or "")
    if not m or not any(m.groups()):
        return None
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + s


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def mentions(name: str, video: dict) -> bool:
    """The game's name, as whole words, in the title or tags; or in the description of a Gaming video."""
    target = f" {normalize(name)} "
    sn = video.get("snippet") or {}
    if target in f" {normalize(sn.get('title'))} ":
        return True
    if any(target in f" {normalize(t)} " for t in sn.get("tags") or []):
        return True
    return sn.get("categoryId") == GAMING and target in f" {normalize(sn.get('description'))} "


def video_row(appid: int, video: dict) -> dict:
    sn = video.get("snippet") or {}
    st = video.get("statistics") or {}
    return {
        "video_id": video["id"], "appid": appid, "channel_id": sn.get("channelId"),
        "channel_title": sn.get("channelTitle"), "title": sn.get("title"),
        "published": iso_time(sn.get("publishedAt")), "views": _int(st.get("viewCount")),
        "likes": _int(st.get("likeCount")), "comments": _int(st.get("commentCount")),
        "duration": duration((video.get("contentDetails") or {}).get("duration")),
        "language": sn.get("defaultAudioLanguage") or sn.get("defaultLanguage"),
    }


def channel_row(channel: dict) -> dict:
    sn = channel.get("snippet") or {}
    st = channel.get("statistics") or {}
    description = sn.get("description") or ""
    return {
        "channel_id": channel["id"], "title": sn.get("title"), "handle": sn.get("customUrl"),
        "description": description, "country": sn.get("country"), "language": sn.get("defaultLanguage"),
        "subscribers": None if st.get("hiddenSubscriberCount") else _int(st.get("subscriberCount")),
        "videos": _int(st.get("videoCount")), "views": _int(st.get("viewCount")),
        "created": iso_time(sn.get("publishedAt")),
        "emails": contacts.emails(description), "links": contacts.links(description),
    }


class YouTube:
    def __init__(self, http: Http, key: str):
        self.http = http
        self.key = key

    def _get(self, path: str, params: dict) -> dict:
        try:
            return self.http.get_json(f"{API}/{path}", {**params, "key": self.key}) or {}
        except HttpError as error:
            # 403 is the quota (or a key not allowed to use the API): nothing more today either way.
            if error.status == 403:
                raise QuotaExceeded(str(error)) from None
            raise

    def search(self, name: str, published_after: int) -> list[str]:
        reply = self._get("search", {
            "part": "snippet", "q": f'"{name}"', "type": "video", "order": "relevance",
            "maxResults": 50, "publishedAfter": to_iso(published_after)})
        return [i["id"]["videoId"] for i in reply.get("items") or [] if (i.get("id") or {}).get("videoId")]

    def videos(self, ids: list[str]) -> list[dict]:
        out: list[dict] = []
        for start in range(0, len(ids), 50):
            out += self._get("videos", {"part": "snippet,statistics,contentDetails",
                                        "id": ",".join(ids[start:start + 50])}).get("items") or []
        return out

    def channels(self, ids: list[str]) -> list[dict]:
        out: list[dict] = []
        for start in range(0, len(ids), 50):
            out += self._get("channels", {"part": "snippet,statistics",
                                          "id": ",".join(ids[start:start + 50])}).get("items") or []
        return out

    def latest_upload(self, channel_id: str) -> int | None:
        """When the channel last uploaded anything (1 unit), from its uploads playlist (UU + the id's
        rest). None: no uploads. Raises HttpError as it came: a 403 here may also be a private playlist."""
        if not channel_id.startswith("UC"):
            return None
        try:
            reply = self.http.get_json(f"{API}/playlistItems", {
                "part": "contentDetails", "playlistId": "UU" + channel_id[2:], "maxResults": 1, "key": self.key}) or {}
        except HttpError as error:
            if error.status == 404:
                return None
            raise
        items = reply.get("items") or []
        return iso_time(((items[0].get("contentDetails") or {}).get("videoPublishedAt")) if items else None)
