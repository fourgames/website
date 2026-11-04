"""Twitch's push notifications (EventSub webhooks): stream.online for TWITCH_LOGIN.

On start (and every 6 hours, and soon after Twitch revokes one) we make sure there's one webhook
subscription for stream.online with PUBLIC_BASE_URL/twitch as the callback: listed first, so a
restart never adds a second; one that Twitch gave up on (failed checks, too many failed deliveries)
is deleted and made again. The app access token comes from TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET,
the feedback loop's Twitch app.

Every message Twitch sends is signed with TWITCH_EVENTSUB_SECRET (HMAC-SHA256 of id + timestamp +
body); unsigned, wrongly signed or older than 10 minutes gets 403. Twitch resends a message it isn't
sure arrived, so message ids are remembered and a repeat is only acknowledged.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
from collections import OrderedDict
from datetime import datetime
from typing import Callable

import aiohttp
from aiohttp import web

from .checks import Checks
from .config import Config

log = logging.getLogger("alerts.twitch")

HELIX = "https://api.twitch.tv/helix"
TOKEN_URL = "https://id.twitch.tv/oauth2/token"
TYPE = "stream.online"
# Statuses of a subscription that works or is about to.
WORKING = ("enabled", "webhook_callback_verification_pending")
MAX_AGE = 10 * 60  # Twitch's advice: older messages may be replays
RECHECK = 6 * 3600
PENDING_RECHECK = 5 * 60  # a new subscription should be enabled by then
RETRY = 10 * 60
AFTER_REVOCATION = 60
SEEN = 1000  # message ids remembered


class TwitchError(Exception):
    def __init__(self, status: int, what: str):
        super().__init__(f"HTTP {status} from Twitch ({what})")
        self.status = status


def signature_ok(secret: str, message_id: str, timestamp: str, body: bytes, header: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), message_id.encode() + timestamp.encode() + body,
                                    hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, (header or "").strip().lower())


def parse_timestamp(text: str) -> float | None:
    """Twitch's RFC 3339 times carry nanoseconds ("2026-11-04T10:11:12.123456789Z"), more than
    datetime reads, so the fraction is added separately."""
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})", (text or "").strip())
    if not match:
        return None
    zone = "+00:00" if match[3] == "Z" else match[3]
    try:
        whole = datetime.fromisoformat(match[1] + zone).timestamp()
    except ValueError:
        return None
    return whole + (float("0." + match[2]) if match[2] else 0.0)


class Twitch:
    def __init__(self, config: Config, session: aiohttp.ClientSession, checks: Checks,
                 helix: str = HELIX, token_url: str = TOKEN_URL, clock: Callable[[], float] = time.time):
        self.config = config
        self.session = session
        self.checks = checks
        self.helix = helix.rstrip("/")
        self.token_url = token_url
        self.clock = clock
        self._token: str | None = None
        self._token_until = 0.0
        self.user_id: str | None = None
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._recheck = asyncio.Event()
        self.status: str | None = None  # the subscription's, as Twitch last reported it
        self.checked_at: int | None = None
        self.notified_at: int | None = None
        self.error: str | None = None

    # -- Helix ---------------------------------------------------------------------------------

    async def _app_token(self) -> str:
        if self._token and self.clock() < self._token_until:
            return self._token
        form = {"client_id": self.config.twitch_client_id, "client_secret": self.config.twitch_client_secret,
                "grant_type": "client_credentials"}
        async with self.session.post(self.token_url, data=form) as response:
            if response.status != 200:
                raise TwitchError(response.status, "app token")
            body = await response.json()
        self._token = body["access_token"]
        # Renewed a little before it runs out.
        self._token_until = self.clock() + max(60, int(body.get("expires_in", 3600)) - 300)
        return self._token

    async def _helix(self, method: str, path: str, params: dict | None = None, payload: dict | None = None):
        """One Helix call; a 401 (an expired or revoked token) gets a new token and one more try.
        The JSON answer, or None for 204."""
        for attempt in (1, 2):
            headers = {"Client-Id": self.config.twitch_client_id, "Authorization": f"Bearer {await self._app_token()}"}
            async with self.session.request(method, f"{self.helix}/{path}", params=params, json=payload,
                                            headers=headers) as response:
                if response.status == 401 and attempt == 1:
                    self._token = None
                    continue
                if response.status >= 300:
                    raise TwitchError(response.status, f"{method} {path}")
                return None if response.status == 204 else await response.json()
        raise AssertionError("unreachable")

    async def _user_id(self) -> str:
        if self.user_id is None:
            users = (await self._helix("GET", "users", {"login": self.config.twitch_login})).get("data") or []
            if not users:
                raise TwitchError(404, f"no Twitch user {self.config.twitch_login}")
            self.user_id = str(users[0]["id"])
        return self.user_id

    async def _subscriptions(self) -> list[dict]:
        found, cursor = [], None
        while True:
            params = {"type": TYPE, **({"after": cursor} if cursor else {})}
            page = await self._helix("GET", "eventsub/subscriptions", params)
            found += page.get("data") or []
            cursor = (page.get("pagination") or {}).get("cursor")
            if not cursor:
                return found

    async def ensure_subscription(self) -> str:
        """Makes sure there's one working subscription to our callback. Its status."""
        user_id = await self._user_id()
        ours = [s for s in await self._subscriptions()
                if s.get("type") == TYPE
                and str((s.get("condition") or {}).get("broadcaster_user_id")) == user_id
                and (s.get("transport") or {}).get("method") == "webhook"
                and (s.get("transport") or {}).get("callback") == self.config.twitch_callback]
        working = [s for s in ours if s.get("status") in WORKING]
        for sub in ours:
            if sub not in working[:1]:  # given up on by Twitch, or a second one
                log.info("deleting subscription %s (%s)", sub.get("id"), sub.get("status"))
                await self._helix("DELETE", "eventsub/subscriptions", {"id": sub["id"]})
        if working:
            self.status = working[0]["status"]
            log.info("%s subscription for %s: %s", TYPE, self.config.twitch_login, self.status)
        else:
            payload = {"type": TYPE, "version": "1", "condition": {"broadcaster_user_id": user_id},
                       "transport": {"method": "webhook", "callback": self.config.twitch_callback,
                                     "secret": self.config.twitch_secret}}
            try:
                made = (await self._helix("POST", "eventsub/subscriptions", payload=payload)).get("data") or [{}]
                self.status = made[0].get("status", "webhook_callback_verification_pending")
                log.info("subscribed to %s for %s: %s", TYPE, self.config.twitch_login, self.status)
            except TwitchError as error:
                if error.status != 409:  # 409: it exists already (made a moment ago)
                    raise
                self.status = "enabled"
        self.checked_at = int(time.time())
        self.error = None
        return self.status

    async def keep_subscribed(self) -> None:
        while True:
            self._recheck.clear()  # a revocation from here on means: again, soon
            try:
                status = await self.ensure_subscription()
                wait = PENDING_RECHECK if status != "enabled" else RECHECK
            except (TwitchError, aiohttp.ClientError, TimeoutError, KeyError, ValueError) as error:
                self.error = str(error) if isinstance(error, TwitchError) else f"couldn't reach Twitch ({type(error).__name__})"
                log.warning("subscription check: %s", self.error)
                wait = RETRY
            try:
                await asyncio.wait_for(self._recheck.wait(), wait)
                await asyncio.sleep(AFTER_REVOCATION)
            except TimeoutError:
                pass

    # -- The webhook ---------------------------------------------------------------------------

    def _first_time(self, message_id: str) -> bool:
        if message_id in self._seen:
            return False
        self._seen[message_id] = None
        while len(self._seen) > SEEN:
            self._seen.popitem(last=False)
        return True

    async def callback(self, request: web.Request) -> web.Response:
        body = await request.read()
        headers = request.headers
        message_id = headers.get("Twitch-Eventsub-Message-Id", "")
        timestamp = headers.get("Twitch-Eventsub-Message-Timestamp", "")
        signature = headers.get("Twitch-Eventsub-Message-Signature", "")
        if not (message_id and timestamp and signature) or not signature_ok(
                self.config.twitch_secret, message_id, timestamp, body, signature):
            log.warning("refused a message with a missing or wrong signature")
            return web.Response(status=403, text="bad signature")
        sent = parse_timestamp(timestamp)
        if sent is None or abs(self.clock() - sent) > MAX_AGE:
            log.warning("refused a message sent at %r (too old, or a replay)", timestamp)
            return web.Response(status=403, text="too old")
        try:
            message = json.loads(body)
        except ValueError:
            return web.Response(status=400, text="not JSON")
        kind = headers.get("Twitch-Eventsub-Message-Type", "")
        subscription = message.get("subscription") or {}

        if kind == "webhook_callback_verification":
            # Signed with our secret, so it's a subscription we made.
            self.status = "enabled"
            return web.Response(text=str(message.get("challenge", "")), content_type="text/plain")
        if not self._first_time(message_id):
            return web.Response(status=204)  # a resend
        if kind == "revocation":
            self.status = subscription.get("status", "revoked")
            log.warning("Twitch revoked the subscription (%s): making it again", self.status)
            self._recheck.set()
            return web.Response(status=204)
        if kind == "notification":
            event = message.get("event") or {}
            ours = (subscription.get("type") == TYPE
                    and (str(event.get("broadcaster_user_id")) == self.user_id
                         or str(event.get("broadcaster_user_login", "")).lower() == self.config.twitch_login))
            if ours:
                self.notified_at = int(time.time())
                self.checks.request(f"Twitch: {self.config.twitch_login} went live")
            return web.Response(status=204)
        return web.Response(status=204)

    def health(self) -> dict:
        return {"subscription": self.status, "userId": self.user_id, "checkedAt": self.checked_at,
                "notifiedAt": self.notified_at, "error": self.error}
