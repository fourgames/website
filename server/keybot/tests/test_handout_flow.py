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


# /claim: the key in the reply, the DM only a copy


class FakeMember(FakeUser):
    def __init__(self, user_id, roles=(), dms_open=True, bot=False):
        super().__init__(user_id, dms_open)
        self.roles = [SimpleNamespace(id=role_id, name=name) for role_id, name in roles]
        self.bot = bot


MEMBER = (500, "YouTube Member")
VIP = (600, "VIP")


class FakeFollowup:
    def __init__(self):
        self.sent = []

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))


class FakeResponse:
    def __init__(self):
        self.sent = []
        self.deferred = False

    async def send_message(self, content=None, **kwargs):
        self.sent.append((content, kwargs))

    async def defer(self, **kwargs):
        self.deferred = True

    async def send_modal(self, modal):
        self.modal = modal
        self.deferred = True

    def is_done(self):
        return self.deferred or bool(self.sent)


def fake_interaction(bot, user):
    return SimpleNamespace(client=bot, user=user, followup=FakeFollowup(), response=FakeResponse(), guild=None)


def test_claim_shows_key_ephemerally_and_dms_a_copy(bot):
    from keybot.bot import claim_game
    game = stock(bot)
    user = FakeMember(1, [MEMBER])
    interaction = fake_interaction(bot, user)
    asyncio.run(claim_game(interaction, game))
    (text, kwargs), = interaction.followup.sent
    assert kwargs == {"ephemeral": True}
    assert "`AAAAA-BBBBB-00000`" in text
    assert "https://store.steampowered.com/account/registerkey?key=AAAAA-BBBBB-00000" in text
    assert "A copy is in your DMs" in text
    assert len(user.sent) == 1 and "registerkey?key=AAAAA-BBBBB-00000" in user.sent[0]


def test_claim_with_dms_closed_still_hands_out(bot):
    from keybot.bot import claim_game
    game = stock(bot)
    user = FakeMember(1, [MEMBER], dms_open=False)
    interaction = fake_interaction(bot, user)
    asyncio.run(claim_game(interaction, game))
    (text, _), = interaction.followup.sent
    assert "`AAAAA-BBBBB-00000`" in text and "couldn't DM you a copy" in text
    assert bot.store.user_key(game["id"], 1)["value"] == "AAAAA-BBBBB-00000"
    assert bot.store.available_count(game["id"]) == 2
    # A second claim is refused, without showing anything new.
    again = fake_interaction(bot, user)
    asyncio.run(claim_game(again, game))
    assert "already had a key" in again.followup.sent[0][0]
    assert bot.store.available_count(game["id"]) == 2


def test_claim_reply_failing_keeps_the_key(bot):
    from keybot.bot import claim_game
    game = stock(bot)
    user = FakeMember(1, [MEMBER])
    interaction = fake_interaction(bot, user)

    async def broken(*args, **kwargs):
        raise discord.HTTPException(SimpleNamespace(status=404, reason="Not Found"), "Unknown interaction")

    interaction.followup.send = broken
    asyncio.run(claim_game(interaction, game))  # logged, not raised
    assert bot.store.user_key(game["id"], 1) is not None and len(user.sent) == 1


def test_claim_refusals_roles_private_bans(bot):
    from keybot.bot import claim_menu_games, claim_refusal, nothing_to_claim_text
    store = bot.store
    open_game = stock(bot)
    vip_game, _ = store.add_game("VIP Only")
    store.add_keys(vip_game["id"], ["VIP00-AAAAA-BBBBB"])
    vip_game = store.update_game_settings(vip_game["id"], required_role_ids=[VIP[0]])
    secret, _ = store.add_game("Secret")
    store.add_keys(secret["id"], ["SEC00-AAAAA-BBBBB"])
    secret = store.update_game_settings(secret["id"], public=False)

    member, vip, nobody = FakeMember(1, [MEMBER]), FakeMember(2, [VIP]), FakeMember(3)
    assert claim_refusal(bot, member, open_game) is None
    assert "<@&600>" in claim_refusal(bot, member, vip_game)
    assert claim_refusal(bot, vip, vip_game) is None
    assert "YouTube channel members" in claim_refusal(bot, vip, open_game)  # no roles set: MEMBER_ROLE
    assert "aren't open for claiming" in claim_refusal(bot, member, secret)
    assert [g["name"] for g in claim_menu_games(bot, member)] == ["Hidden Ones"]
    assert [g["name"] for g in claim_menu_games(bot, vip)] == ["VIP Only"]
    assert claim_menu_games(bot, nobody) == []
    assert "YouTube channel members" in nothing_to_claim_text(bot, nobody)

    store.ban(1, open_game["id"])
    assert "can't get keys for **Hidden Ones**" in claim_refusal(bot, member, open_game)
    assert claim_menu_games(bot, member) == []
    assert "nothing new to claim" in nothing_to_claim_text(bot, member)
    store.ban(2)
    assert "can't get keys" in claim_refusal(bot, vip, vip_game)


def test_request_and_creator_respect_bans_and_limits(bot):
    game = stock(bot)
    bot.users_by_id[5] = user = FakeUser(5)
    big = Channel("twitch", "9", "big", "https://www.twitch.tv/big", audience=10_000)
    bot.store.ban(5, game["id"])
    assert asyncio.run(bot.creator_verified(5, game["id"], [big]))[0] == "Not available"
    bot.store.unban(5, game["id"])
    bot.store.record_prior_claim(game["id"], 5)
    assert asyncio.run(bot.creator_verified(5, game["id"], [big]))[0] == "You already have a key"
    bot.store.update_game_settings(game["id"], per_user_limit=2)
    assert asyncio.run(bot.creator_verified(5, game["id"], [big]))[0] == "Verified — check your DMs"
    assert len(user.sent) == 1


# /keys grant, to a user or to everyone with a role


def test_grant_needs_the_dm_and_respects_limit_and_bans(bot):
    from keybot.bot import grant_text
    game = stock(bot)
    private = bot.store.update_game_settings(game["id"], public=False)
    closed = FakeUser(1, dms_open=False)
    outcome = asyncio.run(bot.hand_out(closed, private, "manual"))
    assert outcome.status == "dm_failed" and bot.store.available_count(game["id"]) == 3
    assert "DMs are closed" in grant_text(outcome, closed, private)
    user = FakeUser(2)
    outcome = asyncio.run(bot.hand_out(user, private, "manual"))
    assert outcome.status == "given" and bot.store.user_key(game["id"], 2)["reason"] == "manual"
    assert "Sent" in grant_text(outcome, user, private)
    outcome = asyncio.run(bot.hand_out(user, private, "manual"))
    assert outcome.status == "already" and "per-user limit" in grant_text(outcome, user, private)
    bot.store.ban(3)
    outcome = asyncio.run(bot.hand_out(FakeUser(3), private, "manual"))
    assert outcome.status == "banned" and "banned" in grant_text(outcome, FakeUser(3), private)


def test_grant_to_members_counts(bot):
    from keybot.bot import grantrole_prompt
    game = stock(bot, keys=3)
    bot.store.ban(2, game["id"])
    bot.store.record_prior_claim(game["id"], 3)
    members = [FakeMember(1), FakeMember(2), FakeMember(3), FakeMember(4, dms_open=False),
               FakeMember(5), FakeMember(6), FakeMember(7), FakeMember(99, bot=True)]
    prompt = grantrole_prompt([m for m in members if not m.bot], bot.store, game, "<@&700>")
    assert "7 member(s) with the role, 5 of them can get one" in prompt and "3 key(s) in stock" in prompt
    assert "it stops after 3" in prompt
    report = asyncio.run(bot.grant_to_members(members, game))
    assert (report.given, report.banned, report.at_limit, report.dm_failed, report.out_of_keys) == (3, 1, 1, 1, 1)
    assert [m.id for m in members if m.sent] == [1, 5, 6]
    assert bot.store.available_count(game["id"]) == 0
    assert "**3** key(s) sent" in report.summary()


# Stock warnings


def test_stock_warnings_at_ten_percent_and_out(bot):
    game, _ = bot.store.add_game("Big Pool")
    bot.store.add_keys(game["id"], [f"BIG{i:02d}-AAAAA-BBBBB" for i in range(20)])
    game = bot.store.update_game_settings(game["id"], per_user_limit=0)
    user = FakeUser(1)
    for _ in range(20):
        asyncio.run(bot.hand_out(user, game, "manual"))
    texts = [content for content, _ in bot.channel.sent]
    # LOW_STOCK=2: "1 left"; 10% of 20: at 2 left; and out of keys. Once each.
    assert len(texts) == 3
    assert "10% of its keys: 2 of 20 left" in texts[0]
    assert "Running low" in texts[1] and "1 left" in texts[1]
    assert "Out of keys" in texts[2]
    # Restocked: warnings can come again.
    bot.store.add_keys(game["id"], ["NEW00-AAAAA-BBBBB"])
    asyncio.run(bot.hand_out(user, game, "manual"))
    assert "Out of keys" in bot.channel.sent[-1][0] and len(bot.channel.sent) == 4


def test_outcome_never_shows_the_key(bot):
    game = stock(bot)
    outcome = asyncio.run(bot.hand_out(FakeUser(1), game, "member", dm_required=False))
    assert outcome.value == "AAAAA-BBBBB-00000" and outcome.value not in repr(outcome)


# Lists and files


def test_pool_lines_and_pages(bot):
    from keybot.bot import pool_line, pool_pages
    game = stock(bot)
    store = bot.store
    row = store.games()[0]
    line = pool_line(row, bot.config, None)
    assert "**Hidden Ones** · 1 per person · 3 key(s) left · for **YouTube Member**" == line
    store.update_game_settings(game["id"], per_user_limit=0)
    assert "no limit per person" in pool_line(store.games()[0], bot.config, None)
    store.update_game_settings(game["id"], required_role_ids=[600, 601])
    assert "for <@&600> or <@&601>" in pool_line(store.games()[0], bot.config, None)
    pages = pool_pages([f"line {i}" for i in range(23)])
    assert len(pages) == 3 and pages[0].endswith("Page 1 of 3") and "line 22" in pages[2]
    assert pool_pages(["only"]) == ["only"]


def test_fit_says_how_many_were_left_out():
    from keybot.bot import fit
    lines = ["x" * 100 for _ in range(50)]
    text = fit(lines)
    assert len(text) <= 2000 and text.endswith("more")
    shown = text.count("x" * 100)
    assert text.endswith(f"…and {50 - shown} more")
    assert fit(["a", "b"]) == "a\nb"


def test_lookup_and_export_helpers(bot):
    from keybot.bot import export_filename, lookup_key_text, lookup_user_lines
    game = stock(bot)
    store = bot.store
    given = store.give_key(game["id"], 9, "press")
    store.record_prior_claim(game["id"], 9, "KeyBot")
    store.ban(9)
    lines = lookup_user_lines(store, 9)
    assert f"key #{given.key_id} `{given.value}` (press" in lines[0]
    assert "old KeyBot: KeyBot" in lines[1] and lines[2] == "Banned from every game"
    assert "given to <@9>" in lookup_key_text(store.key_by_value(given.value))
    assert "not given out yet" in lookup_key_text(store.key_by_value("AAAAA-BBBBB-00001"))
    assert export_filename(game) == "hidden-ones-unclaimed-keys.txt"


def test_grantrole_is_opt_in(tmp_path):
    store = Store(str(tmp_path / "k.db"))
    try:
        off = KeyBot(Config.from_env({**ENV}), store)
        on = KeyBot(Config.from_env({**ENV, "GRANTROLE_ENABLED": "1"}), store)
        assert not off.intents.members and on.intents.members
        assert not off.intents.message_content and not on.intents.presences
    finally:
        store.close()
