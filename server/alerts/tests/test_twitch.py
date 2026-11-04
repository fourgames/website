"""Twitch's EventSub: signatures, the webhook's messages and keeping one subscription (a stand-in
Twitch on localhost, no network)."""

import asyncio
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from alerts.twitch import Twitch, parse_timestamp, signature_ok
from alerts.web import build_app

from .common import TWITCH_SECRET, FakeChecks, config

CALLBACK = "https://api.fourgames.se/alerts/twitch"


def twitch_time(at: float) -> str:
    """Twitch's format, with nanoseconds."""
    return datetime.fromtimestamp(int(at), timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + ".123456789Z"


def headers(body: bytes, kind: str, message_id: str = "m-1", at: float | None = None, secret: str = TWITCH_SECRET):
    timestamp = twitch_time(time.time() if at is None else at)
    signature = "sha256=" + hmac.new(secret.encode(), message_id.encode() + timestamp.encode() + body,
                                     hashlib.sha256).hexdigest()
    return {"Twitch-Eventsub-Message-Id": message_id, "Twitch-Eventsub-Message-Timestamp": timestamp,
            "Twitch-Eventsub-Message-Signature": signature, "Twitch-Eventsub-Message-Type": kind,
            "Content-Type": "application/json"}


def online(login="fourgamesab", user_id="123"):
    return json.dumps({
        "subscription": {"id": "s-1", "type": "stream.online", "version": "1", "status": "enabled",
                         "condition": {"broadcaster_user_id": user_id}},
        "event": {"id": "9001", "broadcaster_user_id": user_id, "broadcaster_user_login": login,
                  "broadcaster_user_name": "FourGamesAB", "type": "live", "started_at": "2026-11-04T10:00:00Z"},
    }).encode()


def test_parse_timestamp():
    assert parse_timestamp("2026-11-04T10:11:12.123456789Z") == datetime(2026, 11, 4, 10, 11, 12, tzinfo=timezone.utc).timestamp() + 0.123456789
    assert parse_timestamp("2026-11-04T12:11:12+02:00") == datetime(2026, 11, 4, 10, 11, 12, tzinfo=timezone.utc).timestamp()
    assert parse_timestamp("yesterday") is None
    assert parse_timestamp("") is None


def test_signature():
    body = online()
    h = headers(body, "notification")
    args = (h["Twitch-Eventsub-Message-Id"], h["Twitch-Eventsub-Message-Timestamp"])
    assert signature_ok(TWITCH_SECRET, *args, body, h["Twitch-Eventsub-Message-Signature"])
    assert not signature_ok(TWITCH_SECRET, *args, body + b" ", h["Twitch-Eventsub-Message-Signature"])
    assert not signature_ok(TWITCH_SECRET, "m-2", args[1], body, h["Twitch-Eventsub-Message-Signature"])
    assert not signature_ok("x" * 32, *args, body, h["Twitch-Eventsub-Message-Signature"])
    assert not signature_ok(TWITCH_SECRET, *args, body, "")


async def with_client(handler, clock=time.time):
    checks = FakeChecks()
    tw = Twitch(config(), session=None, checks=checks, clock=clock)
    tw.user_id = "123"
    async with TestClient(TestServer(build_app(checks, None, tw))) as client:
        return await handler(client, tw, checks)


def test_callback_verification_echoes_the_challenge():
    body = json.dumps({"challenge": "pogchamp-kappa-360noscope-vohiyo",
                       "subscription": {"id": "s-1", "status": "webhook_callback_verification_pending",
                                        "type": "stream.online", "version": "1"}}).encode()

    async def go(client, tw, checks):
        response = await client.post("/alerts/twitch", data=body, headers=headers(body, "webhook_callback_verification"))
        return response.status, await response.text(), response.headers["Content-Type"], tw.status, checks.reasons

    status, text, kind, sub_status, reasons = asyncio.run(with_client(go))
    assert (status, text) == (200, "pogchamp-kappa-360noscope-vohiyo")
    assert kind.startswith("text/plain")
    assert sub_status == "enabled" and reasons == []


def test_stream_online_asks_for_one_check_even_if_resent():
    body = online()

    async def go(client, tw, checks):
        first = await client.post("/twitch", data=body, headers=headers(body, "notification", "m-7"))
        resent = await client.post("/alerts/twitch", data=body, headers=headers(body, "notification", "m-7"))
        return first.status, resent.status, checks.reasons, tw.health()

    first, resent, reasons, health = asyncio.run(with_client(go))
    assert (first, resent) == (204, 204)
    assert reasons == ["Twitch: fourgamesab went live"]
    assert health["notifiedAt"]


def test_someone_elses_stream_asks_for_nothing():
    body = online(login="someoneelse", user_id="999")

    async def go(client, tw, checks):
        response = await client.post("/twitch", data=body, headers=headers(body, "notification"))
        return response.status, checks.reasons

    assert asyncio.run(with_client(go)) == (204, [])


def test_bad_signatures_and_old_messages_are_refused():
    body = online()

    async def go(client, tw, checks):
        statuses = []
        statuses.append((await client.post("/twitch", data=body, headers=headers(body, "notification", secret="x" * 32))).status)
        tampered = headers(body, "notification", "m-2")
        statuses.append((await client.post("/twitch", data=body + b" ", headers=tampered)).status)
        statuses.append((await client.post("/twitch", data=body, headers={"Twitch-Eventsub-Message-Type": "notification"})).status)
        statuses.append((await client.post("/twitch", data=body, headers=headers(body, "notification", "m-3", at=time.time() - 3600))).status)
        return statuses, checks.reasons

    statuses, reasons = asyncio.run(with_client(go))
    assert statuses == [403, 403, 403, 403]
    assert reasons == []


def test_revocation_makes_it_again():
    body = json.dumps({"subscription": {"id": "s-1", "status": "notification_failures_exceeded",
                                        "type": "stream.online", "version": "1"}}).encode()

    async def go(client, tw, checks):
        response = await client.post("/twitch", data=body, headers=headers(body, "revocation"))
        return response.status, tw.status, tw._recheck.is_set(), checks.reasons

    assert asyncio.run(with_client(go)) == (204, "notification_failures_exceeded", True, [])


class FakeTwitch:
    """The bits of id.twitch.tv and the Helix API the service uses."""

    def __init__(self, pages=None, create_status=202, fail_first_with_401=False):
        self.pages = pages if pages is not None else [[]]
        self.create_status = create_status
        self.fail_first_with_401 = fail_first_with_401
        self.tokens = 0
        self.token_forms = []
        self.created = []
        self.deleted = []
        self.auth = []
        app = web.Application()
        app.router.add_post("/oauth2/token", self.token)
        app.router.add_get("/helix/users", self.users)
        app.router.add_get("/helix/eventsub/subscriptions", self.list)
        app.router.add_post("/helix/eventsub/subscriptions", self.create)
        app.router.add_delete("/helix/eventsub/subscriptions", self.delete)
        self.server = TestServer(app)

    async def token(self, request):
        self.tokens += 1
        self.token_forms.append(dict(await request.post()))
        return web.json_response({"access_token": f"token-{self.tokens}", "expires_in": 5000000, "token_type": "bearer"})

    async def users(self, request):
        self.auth.append((request.headers.get("Client-Id"), request.headers.get("Authorization")))
        if self.fail_first_with_401:
            self.fail_first_with_401 = False
            return web.json_response({"error": "Unauthorized"}, status=401)
        assert request.query["login"] == "fourgamesab"
        return web.json_response({"data": [{"id": "123", "login": "fourgamesab"}]})

    async def list(self, request):
        assert request.query["type"] == "stream.online"
        index = int(request.query.get("after", "0"))
        more = index + 1 < len(self.pages)
        return web.json_response({"data": self.pages[index], "total": 0,
                                  "pagination": {"cursor": str(index + 1)} if more else {}})

    async def create(self, request):
        self.created.append(await request.json())
        if self.create_status != 202:
            return web.json_response({"error": "Conflict"}, status=self.create_status)
        return web.json_response({"data": [{"id": "new", "status": "webhook_callback_verification_pending"}]}, status=202)

    async def delete(self, request):
        self.deleted.append(request.query["id"])
        return web.Response(status=204)


def sub(sub_id, status="enabled", callback=CALLBACK, user_id="123"):
    return {"id": sub_id, "status": status, "type": "stream.online", "version": "1",
            "condition": {"broadcaster_user_id": user_id},
            "transport": {"method": "webhook", "callback": callback}}


async def ensure(fake: FakeTwitch):
    async with fake.server, aiohttp.ClientSession() as session:
        tw = Twitch(config(), session, FakeChecks(), helix=str(fake.server.make_url("/helix")),
                    token_url=str(fake.server.make_url("/oauth2/token")))
        status = await tw.ensure_subscription()
        return status, tw


def test_creates_the_subscription_when_there_is_none():
    fake = FakeTwitch()
    status, tw = asyncio.run(ensure(fake))
    assert status == "webhook_callback_verification_pending"
    assert fake.created == [{"type": "stream.online", "version": "1", "condition": {"broadcaster_user_id": "123"},
                             "transport": {"method": "webhook", "callback": CALLBACK, "secret": TWITCH_SECRET}}]
    assert fake.deleted == []
    assert fake.token_forms == [{"client_id": "client-id", "client_secret": "client-secret", "grant_type": "client_credentials"}]
    assert fake.auth == [("client-id", "Bearer token-1")]
    assert tw.user_id == "123"


def test_keeps_a_working_one():
    for status in ("enabled", "webhook_callback_verification_pending"):
        fake = FakeTwitch(pages=[[sub("s-1", status)]])
        result, _ = asyncio.run(ensure(fake))
        assert result == status and fake.created == [] and fake.deleted == []


def test_replaces_one_twitch_gave_up_on_and_leaves_others_alone():
    fake = FakeTwitch(pages=[[sub("failed", "webhook_callback_verification_failed"),
                              sub("elsewhere", callback="https://example.com/hook"),
                              sub("other-user", user_id="999")]])
    status, _ = asyncio.run(ensure(fake))
    assert fake.deleted == ["failed"]
    assert len(fake.created) == 1 and status == "webhook_callback_verification_pending"


def test_reads_every_page():
    fake = FakeTwitch(pages=[[sub("other-user", user_id="999")], [sub("s-2")]])
    status, _ = asyncio.run(ensure(fake))
    assert status == "enabled" and fake.created == []


def test_removes_a_second_working_one():
    fake = FakeTwitch(pages=[[sub("s-1"), sub("s-2")]])
    status, _ = asyncio.run(ensure(fake))
    assert status == "enabled" and fake.deleted == ["s-2"] and fake.created == []


def test_new_token_after_a_401():
    fake = FakeTwitch(pages=[[sub("s-1")]], fail_first_with_401=True)
    status, _ = asyncio.run(ensure(fake))
    assert status == "enabled"
    assert fake.tokens == 2 and fake.auth[-1] == ("client-id", "Bearer token-2")


def test_conflict_means_it_exists():
    fake = FakeTwitch(create_status=409)
    status, _ = asyncio.run(ensure(fake))
    assert status == "enabled" and len(fake.created) == 1
