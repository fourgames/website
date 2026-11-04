"""YouTube's WebSub: signatures, the hub's checks, notifications and subscribing (a stand-in hub on
localhost, no network)."""

import asyncio
import hashlib
import hmac
import time

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from alerts.web import build_app
from alerts.youtube import YouTube, signature_ok, video_ids

from .common import YOUTUBE_SECRET, FakeChecks, config

CHANNEL = "UCGf6yX8yYzo1FBzhmKhFduA"
TOPIC = f"https://www.youtube.com/xml/feeds/videos.xml?channel_id={CHANNEL}"

FEED = f"""<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <link rel="hub" href="https://pubsubhubbub.appspot.com"/>
 <link rel="self" href="{TOPIC}"/>
 <title>YouTube video feed</title>
 <updated>2026-11-04T10:00:00.123456+00:00</updated>
 <entry>
  <id>yt:video:abc123DEF45</id>
  <yt:videoId>abc123DEF45</yt:videoId>
  <yt:channelId>{CHANNEL}</yt:channelId>
  <title>A new devlog</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=abc123DEF45"/>
  <author><name>Four Games</name><uri>https://www.youtube.com/channel/{CHANNEL}</uri></author>
  <published>2026-11-04T10:00:00+00:00</published>
  <updated>2026-11-04T10:00:00.123456+00:00</updated>
 </entry>
</feed>""".encode()

DELETED = f"""<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:at="http://purl.org/atompub/tombstones/1.0" xmlns="http://www.w3.org/2005/Atom">
 <at:deleted-entry ref="yt:video:abc123DEF45" when="2026-11-04T11:00:00+00:00">
  <link href="https://www.youtube.com/watch?v=abc123DEF45"/>
  <at:by><name>Four Games</name><uri>https://www.youtube.com/channel/{CHANNEL}</uri></at:by>
 </at:deleted-entry>
</feed>""".encode()


def sign(body: bytes, secret: str = YOUTUBE_SECRET, algorithm: str = "sha1") -> str:
    return f"{algorithm}=" + hmac.new(secret.encode(), body, getattr(hashlib, algorithm)).hexdigest()


def test_signature():
    assert signature_ok(YOUTUBE_SECRET, FEED, sign(FEED))
    assert signature_ok(YOUTUBE_SECRET, FEED, sign(FEED, algorithm="sha256"))
    assert signature_ok(YOUTUBE_SECRET, FEED, sign(FEED).upper().replace("SHA1=", "sha1="))
    assert not signature_ok(YOUTUBE_SECRET, FEED, sign(FEED, secret="z" * 32))
    assert not signature_ok(YOUTUBE_SECRET, FEED + b" ", sign(FEED))
    assert not signature_ok(YOUTUBE_SECRET, FEED, "")
    assert not signature_ok(YOUTUBE_SECRET, FEED, "sha1=")
    assert not signature_ok(YOUTUBE_SECRET, FEED, "md5=" + hashlib.md5(FEED).hexdigest())


def test_video_ids():
    assert video_ids(FEED, CHANNEL) == ["abc123DEF45"]
    assert video_ids(DELETED, CHANNEL) == []
    assert video_ids(FEED, "UCsomeoneelse") == []
    assert video_ids(b"not xml", CHANNEL) is None


async def with_client(handler, checks=None, **changes):
    checks = checks or FakeChecks()
    yt = YouTube(config(**changes), session=None, checks=checks)
    async with TestClient(TestServer(build_app(checks, yt, None))) as client:
        return await handler(client, yt, checks)


def test_signed_notification_asks_for_a_check():
    async def go(client, yt, checks):
        for path in ("/youtube", "/alerts/youtube"):
            response = await client.post(path, data=FEED, headers={"X-Hub-Signature": sign(FEED),
                                                                    "Content-Type": "application/atom+xml"})
            assert response.status == 204
        return checks.reasons, yt.health()

    reasons, health = asyncio.run(with_client(go))
    assert reasons == ["YouTube: abc123DEF45"] * 2
    assert health["notifiedAt"]


def test_unsigned_or_wrongly_signed_notification_is_ignored():
    async def go(client, yt, checks):
        statuses = []
        for headers in ({}, {"X-Hub-Signature": sign(FEED, secret="z" * 32)}, {"X-Hub-Signature": "sha1=00"}):
            statuses.append((await client.post("/youtube", data=FEED, headers=headers)).status)
        return statuses, checks.reasons

    statuses, reasons = asyncio.run(with_client(go))
    assert statuses == [202, 202, 202]  # acknowledged (WebSub), but nothing done
    assert reasons == []


def test_deleted_video_asks_for_nothing():
    async def go(client, yt, checks):
        response = await client.post("/youtube", data=DELETED, headers={"X-Hub-Signature": sign(DELETED)})
        return response.status, checks.reasons

    assert asyncio.run(with_client(go)) == (204, [])


def test_hub_checks_only_what_we_asked_for():
    async def go(client, yt, checks):
        query = {"hub.mode": "subscribe", "hub.topic": TOPIC, "hub.challenge": "c-123", "hub.lease_seconds": "432000"}
        unexpected = await client.get("/youtube", params=query)
        yt._expect_until = time.monotonic() + 60  # as subscribe() does
        wrong_topic = await client.get("/youtube", params={**query, "hub.topic": TOPIC + "x"})
        unsubscribe = await client.get("/youtube", params={**query, "hub.mode": "unsubscribe"})
        ok = await client.get("/alerts/youtube", params=query)
        again = await client.get("/youtube", params=query)  # once per request
        return (unexpected.status, wrong_topic.status, unsubscribe.status, ok.status, await ok.text(),
                ok.headers["Content-Type"], again.status, yt.health())

    unexpected, wrong_topic, unsubscribe, ok, text, kind, again, health = asyncio.run(with_client(go))
    assert (unexpected, wrong_topic, unsubscribe, ok, again) == (404, 404, 404, 200, 404)
    assert text == "c-123" and kind.startswith("text/plain")
    assert health["subscribed"] is True
    assert abs(health["leaseExpiresAt"] - (time.time() + 432000)) < 10


def test_denied_is_recorded():
    async def go(client, yt, checks):
        response = await client.get("/youtube", params={"hub.mode": "denied", "hub.topic": TOPIC, "hub.reason": "nope"})
        return response.status, yt.health()

    status, health = asyncio.run(with_client(go))
    assert status == 200 and "nope" in health["error"] and health["subscribed"] is False


async def run_with_hub(hub_handler, body):
    """Our app and a stand-in hub on localhost. The hub's handler gets (request, our client)."""
    checks = FakeChecks()
    hub_app = web.Application()
    async with aiohttp.ClientSession() as session:
        cfg = config()
        hub_server = TestServer(hub_app)
        holder = {}

        async def subscribe(request):
            return await hub_handler(request, holder["client"])

        hub_app.router.add_post("/subscribe", subscribe)
        async with hub_server:
            yt = YouTube(cfg, session, checks, hub=str(hub_server.make_url("/subscribe")))
            async with TestClient(TestServer(build_app(checks, yt, None))) as client:
                holder["client"] = client
                return await body(yt)


def test_subscribing_and_the_hubs_check():
    seen = {}

    async def hub(request, client):
        seen["form"] = dict(await request.post())

        async def check_back():
            # The callback is https://api.fourgames.se/alerts/youtube; here it's our test server.
            assert seen["form"]["hub.callback"] == "https://api.fourgames.se/alerts/youtube"
            response = await client.get("/alerts/youtube", params={
                "hub.mode": "subscribe", "hub.topic": seen["form"]["hub.topic"],
                "hub.challenge": "challenge-42", "hub.lease_seconds": "432000"})
            seen["echo"] = (response.status, await response.text())

        seen["task"] = asyncio.get_running_loop().create_task(check_back())
        return web.Response(status=202)

    async def body(yt):
        assert await yt.subscribe()
        await asyncio.wait_for(yt._verified.wait(), 5)
        await seen["task"]
        return yt.health()

    health = asyncio.run(run_with_hub(hub, body))
    assert seen["form"] == {"hub.callback": "https://api.fourgames.se/alerts/youtube", "hub.topic": TOPIC,
                            "hub.verify": "async", "hub.mode": "subscribe", "hub.secret": YOUTUBE_SECRET}
    assert seen["echo"] == (200, "challenge-42")
    assert health["subscribed"] and health["error"] is None


def test_renewal_comes_before_the_lease_ends():
    waits = []

    async def hub(request, client):
        form = dict(await request.post())

        async def check_back():
            await client.get("/youtube", params={"hub.mode": "subscribe", "hub.topic": form["hub.topic"],
                                                 "hub.challenge": "c", "hub.lease_seconds": "432000"})

        asyncio.get_running_loop().create_task(check_back())
        return web.Response(status=202)

    class Stop(Exception):
        pass

    async def fake_sleep(seconds):
        waits.append(seconds)
        raise Stop

    async def body(yt):
        yt.sleep = fake_sleep
        with pytest.raises(Stop):
            await yt.keep_subscribed()

    asyncio.run(run_with_hub(hub, body))
    assert waits == [432000 / 2]  # 2.5 days: before RENEW_HOURS' 3 days


def test_hub_error_is_reported():
    async def hub(request, client):
        return web.Response(status=500)

    async def body(yt):
        return await yt.subscribe(), yt.health()

    ok, health = asyncio.run(run_with_hub(hub, body))
    assert ok is False and "500" in health["error"]
