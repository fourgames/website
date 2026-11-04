"""YouTube's push notifications (WebSub, formerly PubSubHubbub).

We subscribe the channel's feed at Google's hub with PUBLIC_BASE_URL/youtube as the callback. The hub
checks the subscription with a GET there (we echo hub.challenge, only for our topic and only while
we're expecting it, so no one else can swap the subscription's secret), then POSTs the feed's new or
changed entries, signed with our secret (X-Hub-Signature). A signed POST with one of our videos asks
for an announce check; the check decides what, if anything, is new.

A subscription lasts about 5 days (the hub says how long): it's renewed after half of that, or
RENEW_HOURS, whichever comes first, and retried every 15 minutes while it fails. A scheduled stream
going live doesn't always send a notification: the loop's check every 5 minutes covers that.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import time
import xml.etree.ElementTree as ET

import aiohttp
from aiohttp import web

from .checks import Checks
from .config import Config

log = logging.getLogger("alerts.youtube")

HUB = "https://pubsubhubbub.appspot.com/subscribe"
ATOM = "{http://www.w3.org/2005/Atom}"
YT = "{http://www.youtube.com/xml/schemas/2015}"
VERIFY_WAIT = 10 * 60  # how long the hub has to check a subscription request
RETRY = 15 * 60
DEFAULT_LEASE = 432000  # 5 days, the hub's usual
ALGORITHMS = {"sha1": hashlib.sha1, "sha256": hashlib.sha256, "sha384": hashlib.sha384, "sha512": hashlib.sha512}


def signature_ok(secret: str, body: bytes, header: str) -> bool:
    """X-Hub-Signature is "sha1=<hex HMAC of the body>" (YouTube's hub uses sha1; WebSub allows the others)."""
    method, _, digest = (header or "").strip().partition("=")
    algorithm = ALGORITHMS.get(method.lower())
    if algorithm is None or not digest:
        return False
    expected = hmac.new(secret.encode(), body, algorithm).hexdigest()
    return hmac.compare_digest(expected, digest.strip().lower())


def video_ids(body: bytes, channel_id: str) -> list[str] | None:
    """Our channel's video ids in a notification (none for a deleted video), or None when it isn't
    readable Atom."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None
    ids = []
    for entry in root.findall(f"{ATOM}entry"):
        video = entry.findtext(f"{YT}videoId")
        if video and entry.findtext(f"{YT}channelId", channel_id) == channel_id:
            ids.append(video)
    return ids


class YouTube:
    def __init__(self, config: Config, session: aiohttp.ClientSession, checks: Checks, hub: str = HUB):
        self.config = config
        self.session = session
        self.checks = checks
        self.hub = hub
        self._expect_until = 0.0
        self._verified = asyncio.Event()
        self.lease_seconds: int | None = None
        self.verified_at: int | None = None
        self.notified_at: int | None = None
        self.error: str | None = None
        self.sleep = asyncio.sleep  # tests replace it

    async def subscribe(self) -> bool:
        """Asks the hub to (re)subscribe; it then checks with a GET on the callback. True when the
        hub took the request."""
        self._verified.clear()
        self._expect_until = time.monotonic() + VERIFY_WAIT
        form = {
            "hub.callback": self.config.youtube_callback,
            "hub.topic": self.config.youtube_topic,
            "hub.verify": "async",
            "hub.mode": "subscribe",
            "hub.secret": self.config.youtube_secret,
        }
        try:
            async with self.session.post(self.hub, data=form) as response:
                if response.status in (202, 204):
                    return True
                self.error = f"the hub answered HTTP {response.status}"
        except (aiohttp.ClientError, TimeoutError) as error:
            self.error = f"couldn't reach the hub ({type(error).__name__})"
        log.warning("subscribing: %s", self.error)
        return False

    async def keep_subscribed(self) -> None:
        while True:
            ok = await self.subscribe()
            if ok:
                try:
                    await asyncio.wait_for(self._verified.wait(), VERIFY_WAIT)
                except TimeoutError:
                    ok = False
                    self.error = "the hub never checked the subscription (is Caddy forwarding /alerts?)"
                    log.warning(self.error)
            if ok:
                lease = self.lease_seconds or DEFAULT_LEASE
                wait = min(self.config.renew_hours * 3600, lease / 2)
                log.info("subscribed for %d hours; renewing in %.0f hours", lease // 3600, wait / 3600)
            else:
                wait = RETRY
            await self.sleep(wait)

    async def verify(self, request: web.Request) -> web.Response:
        """The hub's GET: hub.mode, hub.topic, hub.challenge, hub.lease_seconds."""
        query = request.query
        mode, topic = query.get("hub.mode", ""), query.get("hub.topic", "")
        if topic != self.config.youtube_topic:
            return web.Response(status=404, text="unknown topic")
        if mode == "denied":
            self.error = f"the hub denied the subscription ({query.get('hub.reason', 'no reason given')})"
            log.warning(self.error)
            return web.Response(text="ok")
        challenge = query.get("hub.challenge", "")
        # Only a subscription we just asked for; we never unsubscribe.
        if mode != "subscribe" or not challenge or time.monotonic() > self._expect_until:
            log.warning("refused the hub's %s check", mode or "unknown")
            return web.Response(status=404, text="not expected")
        try:
            self.lease_seconds = int(query.get("hub.lease_seconds", "")) or None
        except ValueError:
            self.lease_seconds = None
        self.verified_at = int(time.time())
        self.error = None
        self._expect_until = 0.0
        self._verified.set()
        return web.Response(text=challenge, content_type="text/plain")

    async def notify(self, request: web.Request) -> web.Response:
        body = await request.read()
        if not signature_ok(self.config.youtube_secret, body, request.headers.get("X-Hub-Signature", "")):
            # WebSub: ignore it, but still answer 2xx (the hub would only send it again).
            log.warning("ignored a notification with a missing or wrong signature")
            return web.Response(status=202, text="ignored")
        self.notified_at = int(time.time())
        ids = video_ids(body, self.config.youtube_channel_id)
        if ids == []:
            log.info("notification without a video of ours (a deleted video): no check")
        else:
            self.checks.request(f"YouTube: {', '.join(ids) if ids else 'unreadable notification'}")
        return web.Response(status=204)

    def health(self) -> dict:
        lease = self.lease_seconds or DEFAULT_LEASE
        expires = self.verified_at + lease if self.verified_at else None
        return {"subscribed": bool(expires and expires > time.time()), "verifiedAt": self.verified_at,
                "leaseExpiresAt": expires, "notifiedAt": self.notified_at, "error": self.error}
