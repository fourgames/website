"""/privacy: the verified Steam connection, the internal game-data calls, and the callback page.

The game-data service is a fake aiohttp server on localhost; Discord's login is patched out.
"""

import asyncio
import logging
from types import SimpleNamespace

import aiohttp
import discord
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from keybot import web as keybot_web
from keybot.bot import KeyBot, privacy_reply
from keybot.config import Config
from keybot.db import Store
from keybot.privacy import PRIVACY_URL, perform, steam_id
from keybot.state import StateError, sign_state, verify_state

STEAMID = "76561198000000042"
KEY = "internal-key-for-tests"
ENV = {
    "DISCORD_BOT_TOKEN": "t", "DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "s", "GUILD_ID": "10",
    "ADMIN_CHANNEL_ID": "20", "PUBLIC_BASE_URL": "https://example.test/keybot", "STATE_SECRET": "x" * 64,
}
CONNECTIONS = [
    {"type": "steam", "id": "76561198000000001", "name": "other", "verified": False},
    {"type": "youtube", "id": "UC123", "name": "yt", "verified": True},
    {"type": "steam", "id": STEAMID, "name": "me", "verified": True},
]


class FakeGamedata:
    """Records every call; answers like server/gamedata/SPEC.md's internal endpoints."""

    def __init__(self):
        self.calls = []
        app = web.Application()
        app.router.add_post("/gamedata/v1/internal/{name}", self.handle)
        self.server = TestServer(app)

    async def handle(self, request):
        self.calls.append((request.path, request.headers.get("X-Internal-Key"), await request.json()))
        if request.headers.get("X-Internal-Key") != KEY:
            return web.json_response({"ok": False, "error": "forbidden"}, status=403)
        name = request.match_info["name"]
        if name == "status":
            return web.json_response({"ok": True, "opted_out": False, "games": [
                {"app_id": 5207970, "sessions": 3, "playtime_s": 3900, "first_seen": "2026-10-01T10:00:00Z",
                 "last_seen": 1793000000}]})
        if name == "export-link":
            return web.json_response({"ok": True, "url": "https://api.fourgames.se/gamedata/v1/export/once123",
                                      "expires_in": 900})
        return web.json_response({"ok": True})

    def config(self, key=KEY):
        return Config.from_env({**ENV, "GAMEDATA_INTERNAL_URL": str(self.server.make_url("/gamedata/v1")) + "/",
                                "GAMEDATA_INTERNAL_KEY": key})


async def with_gamedata(work):
    fake = FakeGamedata()
    await fake.server.start_server()
    try:
        async with aiohttp.ClientSession() as session:
            return fake, await work(fake, session)
    finally:
        await fake.server.close()


# The Steam connection


def test_only_a_verified_steam_connection_counts():
    assert steam_id(CONNECTIONS) == STEAMID
    assert steam_id([c for c in CONNECTIONS if c["id"] != STEAMID]) is None
    assert steam_id([{"type": "steam", "id": STEAMID}]) is None  # verified missing
    assert steam_id([{"type": "steam", "id": STEAMID, "verified": "true"}]) is None  # not the boolean
    assert steam_id([{"type": "steam", "id": "not-a-steamid", "verified": True}]) is None
    assert steam_id([]) is None and steam_id(None) is None


# Each action against the internal API


@pytest.mark.parametrize("action, path, body", [
    ("optout", "/gamedata/v1/internal/optout", {"steamid": STEAMID, "opted_out": True}),
    ("optin", "/gamedata/v1/internal/optout", {"steamid": STEAMID, "opted_out": False}),
    ("status", "/gamedata/v1/internal/status", {"steamid": STEAMID}),
    ("export", "/gamedata/v1/internal/export-link", {"steamid": STEAMID}),
])
def test_each_action_calls_its_endpoint_with_the_key(action, path, body):
    fake, result = asyncio.run(with_gamedata(
        lambda fake, session: perform(session, fake.config(), action, CONNECTIONS, {5207970: "Pomo Valley"})))
    assert fake.calls == [(path, KEY, body)]
    assert result.status == 200
    # The steamid never goes back to the person or into Discord.
    assert STEAMID not in " ".join(result.lines) + result.discord_text + result.title


def test_status_and_export_results():
    _, status = asyncio.run(with_gamedata(
        lambda fake, session: perform(session, fake.config(), "status", CONNECTIONS, {5207970: "Pomo Valley"})))
    assert any("Pomo Valley: 3 session(s), 1 h 5 min played, 2026-10-01 to" in line for line in status.lines)
    assert "opted in" in status.lines[0]

    _, export = asyncio.run(with_gamedata(
        lambda fake, session: perform(session, fake.config(), "export", CONNECTIONS)))
    assert export.link == ("Download my data", "https://api.fourgames.se/gamedata/v1/export/once123")
    # The download link is only on the page, never in the Discord message.
    assert "https://" not in export.discord_text and "15 minutes" in export.discord_text


def test_an_error_from_the_service_is_a_502_without_the_steamid(caplog):
    caplog.set_level(logging.DEBUG)
    fake, result = asyncio.run(with_gamedata(
        lambda fake, session: perform(session, fake.config(key="wrong"), "optout", CONNECTIONS)))
    assert len(fake.calls) == 1 and result.status == 502
    assert PRIVACY_URL in result.discord_text
    assert STEAMID not in caplog.text


def test_no_verified_steam_connection_calls_nothing():
    unverified = [c for c in CONNECTIONS if c["id"] != STEAMID]
    for action in ("optout", "optin", "status", "export"):
        fake, result = asyncio.run(with_gamedata(
            lambda fake, session: perform(session, fake.config(), action, unverified)))
        assert fake.calls == []
        assert result.title == "No verified Steam account"
        assert "User Settings → Connections" in result.lines[0] and PRIVACY_URL in result.lines[0]


# Without GAMEDATA_INTERNAL_KEY


def test_without_the_key_privacy_only_links_the_website():
    config = Config.from_env(ENV)
    assert config.gamedata_internal_key == ""
    assert config.gamedata_internal_url == "http://127.0.0.1:8103/gamedata/v1"
    text, view = privacy_reply(config)
    assert view is None and PRIVACY_URL in text

    async def with_key():
        return privacy_reply(Config.from_env({**ENV, "GAMEDATA_INTERNAL_KEY": KEY}))

    text, view = asyncio.run(with_key())
    labels = [item.label for item in view.children]
    assert labels == ["Opt out", "Opt back in", "Download my data", "Show what you have"]

    fake, result = asyncio.run(with_gamedata(
        lambda fake, session: perform(session, fake.config(key=""), "optout", CONNECTIONS)))
    assert fake.calls == [] and PRIVACY_URL in result.lines[0]


# The signed state


def test_privacy_state_round_trip_and_old_links():
    token, state = sign_state("s" * 40, 5, 0, now=1000, purpose="privacy", action="export")
    assert verify_state("s" * 40, token, now=1001) == state
    assert (state.purpose, state.action) == ("privacy", "export")
    old, _ = sign_state("s" * 40, 5, 7, now=1000)
    assert verify_state("s" * 40, old, now=1001).purpose == "request"
    with pytest.raises(StateError) as error:
        verify_state("s" * 40, token, now=5000)
    assert str(error.value) == "expired" and error.value.state.purpose == "privacy"


# The whole callback


class FakeUser:
    def __init__(self, user_id):
        self.id = user_id
        self.sent = []

    async def send(self, content=None, **kwargs):
        self.sent.append(content)


class FakeFollowup:
    def __init__(self):
        self.sent = []

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))


async def run_callback(tmp_path, monkeypatch, action, connections, *, fresh_followup=True):
    fake = FakeGamedata()
    await fake.server.start_server()
    config = Config.from_env({**ENV, "DB_PATH": str(tmp_path / "keys.db"),
                              "GAMEDATA_INTERNAL_URL": str(fake.server.make_url("/gamedata/v1")),
                              "GAMEDATA_INTERNAL_KEY": KEY})
    bot = KeyBot(config, Store(config.db_path))
    bot.http_session = aiohttp.ClientSession()
    user = FakeUser(99)

    async def user_by_id(user_id):
        assert user_id == 99
        return user

    bot.user_by_id = user_by_id
    followup = FakeFollowup()
    interaction = SimpleNamespace(user=SimpleNamespace(id=99), followup=followup)
    url = bot.privacy_link(interaction, action)
    if not fresh_followup:
        bot.privacy_pending.clear()  # e.g. the bot restarted in between
    token = url.split("state=", 1)[1]

    async def exchange_code(session, bot_, code):
        return "access"

    async def discord_get(session, access, path):
        return {"id": "99"} if path == "/users/@me" else connections

    async def revoke(session, bot_, access):
        pass

    monkeypatch.setattr(keybot_web, "exchange_code", exchange_code)
    monkeypatch.setattr(keybot_web, "discord_get", discord_get)
    monkeypatch.setattr(keybot_web, "revoke", revoke)
    try:
        async with TestClient(TestServer(keybot_web.build_app(bot))) as client:
            response = await client.get("/keybot/callback", params={"state": token, "code": "c"})
            body = await response.text()
            again = await client.get("/keybot/callback", params={"state": token, "code": "c"})
            again_body = await again.text()
    finally:
        await bot.http_session.close()
        await fake.server.close()
        bot.store.close()
    return SimpleNamespace(status=response.status, body=body, again=(again.status, again_body),
                           calls=fake.calls, followup=followup.sent, dms=user.sent, db=tmp_path / "keys.db")


def test_callback_export_shows_the_link_only_on_the_page(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    result = asyncio.run(run_callback(tmp_path, monkeypatch, "export", CONNECTIONS))
    assert result.status == 200
    assert 'href="https://api.fourgames.se/gamedata/v1/export/once123"' in result.body
    assert result.calls == [("/gamedata/v1/internal/export-link", KEY, {"steamid": STEAMID})]
    assert len(result.followup) == 1 and result.followup[0][1] == {"ephemeral": True}
    assert "export/once123" not in result.followup[0][0] and result.dms == []
    # One use per link, and the second page points back to /privacy.
    assert result.again[0] == 400 and "/privacy" in result.again[1]
    # Nothing identifying in the logs or the bot's database.
    assert STEAMID not in caplog.text
    for path in result.db.parent.iterdir():  # keys.db and its -wal / -shm files
        assert STEAMID.encode() not in path.read_bytes()


def test_callback_optout_answers_by_dm_after_a_restart(tmp_path, monkeypatch):
    result = asyncio.run(run_callback(tmp_path, monkeypatch, "optout", CONNECTIONS, fresh_followup=False))
    assert result.status == 200 and "opted out" in result.body
    assert result.calls == [("/gamedata/v1/internal/optout", KEY, {"steamid": STEAMID, "opted_out": True})]
    assert result.followup == [] and len(result.dms) == 1 and "opted out" in result.dms[0]


def test_callback_without_verified_steam(tmp_path, monkeypatch):
    unverified = [c for c in CONNECTIONS if c["id"] != STEAMID]
    result = asyncio.run(run_callback(tmp_path, monkeypatch, "status", unverified))
    assert result.status == 200 and "No verified Steam account" in result.body
    assert result.calls == []
    assert "User Settings → Connections" in result.followup[0][0]


def test_privacy_followup_falls_back_to_dm_when_discord_refuses(tmp_path):
    async def go():
        bot = KeyBot(Config.from_env({**ENV, "DB_PATH": str(tmp_path / "keys.db")}), Store(str(tmp_path / "keys.db")))
        user = FakeUser(5)

        async def user_by_id(user_id):
            return user

        class Refusing:
            async def send(self, *args, **kwargs):
                raise discord.NotFound(SimpleNamespace(status=404, reason="Not Found"), "Unknown Webhook")

        bot.user_by_id = user_by_id
        url = bot.privacy_link(SimpleNamespace(user=SimpleNamespace(id=5), followup=Refusing()), "status", now=1000)
        nonce = verify_state(bot.config.state_secret, url.split("state=", 1)[1], now=1001).nonce
        how = await bot.privacy_followup(nonce, 5, "hello", now=1100)
        return how, user.sent

    assert asyncio.run(go()) == ("dm", ["hello"])
