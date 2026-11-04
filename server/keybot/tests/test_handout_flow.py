"""The bot's handout and creator flows with fake Discord users (no network, no login)."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import discord
import pytest

from keybot.bot import KeyBot
from keybot.config import Config
from keybot.db import Store
from keybot.eligibility import Channel

ENV = {
    "DISCORD_BOT_TOKEN": "t", "DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "s", "GUILD_ID": "10",
    "ADMIN_CHANNEL_ID": "20", "PUBLIC_BASE_URL": "https://example.test/keybot", "STATE_SECRET": "x" * 64,
    "LOW_STOCK": "2",
}


class FakeUser:
    def __init__(self, user_id, dms_open=True):
        self.id = user_id
        self.name = f"user{user_id}"
        self.mention = f"<@{user_id}>"
        self.dms_open = dms_open
        self.sent = []

    async def send(self, content=None, **kwargs):
        if not self.dms_open:
            raise discord.Forbidden(SimpleNamespace(status=403, reason="Forbidden"), "Cannot send messages")
        self.sent.append(content)


class FakeChannel:
    def __init__(self):
        self.sent = []

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))
        return SimpleNamespace(id=len(self.sent))


@pytest.fixture
def bot(tmp_path):
    store = Store(str(tmp_path / "keys.db"))
    bot = KeyBot(Config.from_env({**ENV, "DB_PATH": str(tmp_path / "keys.db")}), store)
    bot.channel = FakeChannel()
    bot.users_by_id = {}

    async def admin_channel():
        return bot.channel

    async def user_by_id(user_id):
        return bot.users_by_id[user_id]

    bot.admin_channel = admin_channel
    bot.user_by_id = user_by_id
    yield bot
    store.close()


def stock(bot, keys=3):
    game, _ = bot.store.add_game("Hidden Ones", 123)
    bot.store.add_keys(game["id"], [f"AAAAA-BBBBB-{i:05d}" for i in range(keys)])
    return game


def test_dm_failure_keeps_the_key(bot):
    game = stock(bot)
    user = FakeUser(1, dms_open=False)
    outcome = asyncio.run(bot.hand_out(user, game, "member"))
    assert outcome.status == "dm_failed"
    assert bot.store.available_count(game["id"]) == 3
    assert bot.store.user_key(game["id"], 1) is None
    user.dms_open = True
    assert asyncio.run(bot.hand_out(user, game, "member")).status == "given"
    assert "AAAAA-BBBBB-00000" in user.sent[0]


def test_second_claim_is_refused(bot):
    game = stock(bot)
    user = FakeUser(1)
    assert asyncio.run(bot.hand_out(user, game, "member")).status == "given"
    assert asyncio.run(bot.hand_out(user, game, "member")).status == "already"
    assert len(user.sent) == 1


def test_low_stock_alert_once_below_the_line(bot):
    game = stock(bot, keys=3)  # LOW_STOCK=2: alert at 1 left, and at 0
    for user_id in (1, 2, 3):
        asyncio.run(bot.hand_out(FakeUser(user_id), game, "member"))
    texts = [content for content, _ in bot.channel.sent]
    assert len(texts) == 2 and "1 left" in texts[0] and "Out of keys" in texts[1]


def recent():
    return datetime.now(timezone.utc) - timedelta(days=2)


def test_creator_auto_approved(bot):
    game = stock(bot)
    bot.users_by_id[5] = user = FakeUser(5)
    big = Channel("youtube", "UC1", "Big", "https://www.youtube.com/@big", audience=50_000, last_upload=recent())
    title, _ = asyncio.run(bot.creator_verified(5, game["id"], [big]))
    assert title == "Verified — check your DMs"
    assert len(user.sent) == 1
    key = bot.store.user_key(game["id"], 5)
    assert key["reason"] == "creator"
    request = bot.store.request(key["request_id"])
    assert request["status"] == "approved" and request["decided_by"] == "auto"
    assert request["channel_url"] == "https://www.youtube.com/@big"


def test_small_creator_goes_to_review(bot):
    game = stock(bot)
    bot.users_by_id[5] = user = FakeUser(5)
    small = Channel("twitch", "9", "small", "https://www.twitch.tv/small", audience=12)
    title, _ = asyncio.run(bot.creator_verified(5, game["id"], [small]))
    assert title == "Sent for review"
    assert not user.sent and bot.store.user_key(game["id"], 5) is None
    assert bot.store.open_request_count(5) == 1
    _, kwargs = bot.channel.sent[-1]
    assert "embed" in kwargs and "view" in kwargs
    # The same game again waits on the first request.
    assert asyncio.run(bot.creator_verified(5, game["id"], [small]))[0] == "Already waiting for review"


def test_creator_with_dms_closed_keeps_key_and_request_free(bot):
    game = stock(bot)
    bot.users_by_id[5] = FakeUser(5, dms_open=False)
    big = Channel("twitch", "9", "big", "https://www.twitch.tv/big", audience=10_000)
    title, _ = asyncio.run(bot.creator_verified(5, game["id"], [big]))
    assert title.startswith("Verified, but")
    assert bot.store.available_count(game["id"]) == 3
    assert bot.store.open_request_count(5) == 0


def test_open_request_limit(bot):
    stock(bot)
    games = []
    for name in ("A", "B", "C", "D"):
        g, _ = bot.store.add_game(name)
        bot.store.add_keys(g["id"], [f"{name}AAAA-BBBBB-CCCCC"])
        games.append(g)
    for g in games[:3]:
        bot.store.create_request("press", g["id"], 5)
    bot.users_by_id[5] = FakeUser(5)
    assert asyncio.run(bot.creator_verified(5, games[3]["id"], []))[0] == "Too many open requests"
