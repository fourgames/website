"""The three slash commands (/claim, /request, /keys): what's registered, and how they answer."""

import asyncio

import discord
import pytest

from keybot.bot import (REQUEST_TYPES, ClaimSelect, KeyBot, claim, keys_group, request_key)
from keybot.config import Config
from keybot.db import Store

from .test_handout_flow import ENV, MEMBER, FakeMember, FakeUser, bot, fake_interaction, stock  # noqa: F401

KEYS_SUBCOMMANDS = {"add", "games", "status", "log", "settings", "grant", "lookup", "export", "ban", "unban", "bans"}
OLD_COMMANDS = ("mykeys", "pools", "request-press", "grant", "grantrole")


def kind(value):
    return next(choice for choice in REQUEST_TYPES if choice.value == value)


# What's registered


@pytest.mark.parametrize("grantrole", [False, True])
def test_three_commands_and_old_names_gone(tmp_path, grantrole):
    store = Store(str(tmp_path / "k.db"))
    try:
        env = {**ENV, "GRANTROLE_ENABLED": "1"} if grantrole else ENV
        bot = KeyBot(Config.from_env(env), store)
        bot.register_commands()
        assert sorted(c.name for c in bot.tree.get_commands()) == ["claim", "keys", "request"]
        for name in OLD_COMMANDS:
            assert bot.tree.get_command(name) is None
        keys = bot.tree.get_command("keys")
        expected = KEYS_SUBCOMMANDS | ({"grant-role"} if grantrole else set())
        assert {c.name for c in keys.commands} == expected
        assert "game-settings" not in {c.name for c in keys.commands}
    finally:
        store.close()


def test_keys_is_for_manage_server_and_the_rest_for_everyone(tmp_path):
    store = Store(str(tmp_path / "k.db"))
    try:
        bot = KeyBot(Config.from_env(ENV), store)
        bot.register_commands()
        assert keys_group.default_permissions == discord.Permissions(manage_guild=True)
        payload = keys_group.to_dict(bot.tree)
        assert payload["default_member_permissions"] == discord.Permissions(manage_guild=True).value
        assert claim.to_dict(bot.tree)["default_member_permissions"] is None
        assert request_key.to_dict(bot.tree)["default_member_permissions"] is None
        options = {o["name"]: o for o in request_key.to_dict(bot.tree)["options"]}
        assert [c["value"] for c in options["type"]["choices"]] == ["creator", "press"]
        assert options["type"]["required"] and not options["outlet"]["required"]
        assert not options["email"]["required"]
    finally:
        store.close()


@pytest.mark.parametrize("stale_global", [False, True])
def test_sync_replaces_guild_commands_and_clears_global_ones(bot, monkeypatch, stale_global):
    import keybot.web

    calls = []

    async def start_web(_bot):
        return None

    async def fetch_commands(*, guild=None):
        calls.append(("fetch", guild))
        return [object()] if stale_global else []

    async def sync(*, guild=None):
        calls.append(("sync", guild.id if guild else None, sorted(c.name for c in bot.tree.get_commands(guild=guild))))
        return []

    monkeypatch.setattr(keybot.web, "start_web", start_web)
    monkeypatch.setattr(bot.tree, "fetch_commands", fetch_commands)
    monkeypatch.setattr(bot.tree, "sync", sync)

    async def run():
        try:
            await bot.setup_hook()
        finally:
            if bot.http_session:
                await bot.http_session.close()

    asyncio.run(run())
    expected = [("fetch", None)]
    if stale_global:
        expected.append(("sync", None, []))
    expected.append(("sync", 10, ["claim", "keys", "request"]))
    assert calls == expected


# /claim


def test_claim_without_game_shows_games_and_own_keys(bot):
    store = bot.store
    stock(bot)
    secret, _ = store.add_game("Secret")
    store.add_keys(secret["id"], ["SEC00-AAAAA-BBBBB", "SEC00-AAAAA-CCCCC"])
    store.update_game_settings(secret["id"], public=False)
    store.add_game("Empty")
    given = store.give_key(secret["id"], 1, "manual")
    old, _ = store.add_game("Old Game")
    store.record_prior_claim(old["id"], 1)

    interaction = fake_interaction(bot, FakeMember(1, [MEMBER]))
    asyncio.run(claim.callback(interaction))
    (text, kwargs), = interaction.response.sent
    assert kwargs["ephemeral"] and kwargs["suppress_embeds"]
    # Public games with keys left, with keys per person, stock and roles; not private or empty ones.
    assert "**Hidden Ones** · 1 per person · 3 key(s) left · for **YouTube Member**" in text
    assert "**Secret** ·" not in text and "Empty" not in text and "**Old Game** ·" not in text
    # Their own keys, with the Steam link that fills each in, and the old KeyBot claims.
    assert (f"**Secret**: `{given.value}` · [Redeem on Steam]"
            f"(https://store.steampowered.com/account/registerkey?key={given.value})") in text
    assert "**Old Game**: claimed with the old KeyBot" in text
    # A menu of what they can claim; one page, so no page buttons.
    view = kwargs["view"]
    assert len(view.children) == 1 and isinstance(view.children[0], ClaimSelect)
    assert [o.label for o in view.children[0].options] == ["Hidden Ones"]


def test_claim_without_game_for_non_members_and_the_banned(bot):
    store = bot.store
    stock(bot)
    nobody = fake_interaction(bot, FakeMember(2))
    asyncio.run(claim.callback(nobody))
    (text, kwargs), = nobody.response.sent
    assert "**Hidden Ones** ·" in text and "You haven't been given any keys yet." in text
    assert "YouTube channel members" in text and "view" not in kwargs

    store.ban(1)
    banned = fake_interaction(bot, FakeMember(1, [MEMBER]))
    asyncio.run(claim.callback(banned))
    (text, kwargs), = banned.response.sent
    assert "You can't get keys here." in text and "view" not in kwargs


def test_claim_overview_pages(bot):
    store = bot.store
    for i in range(23):
        game, _ = store.add_game(f"Game {i:02d}")
        store.add_keys(game["id"], [f"G{i:02d}00-AAAAA-BBBBB"])
    interaction = fake_interaction(bot, FakeMember(1, [MEMBER]))
    asyncio.run(claim.callback(interaction))
    (text, kwargs), = interaction.response.sent
    view = kwargs["view"]
    assert text.endswith("Page 1 of 3") and len(view.pages) == 3 and "Your keys" in view.pages[2]
    labels = [getattr(c, "label", None) for c in view.children]
    assert labels[:2] == ["Previous", "Next"] and isinstance(view.children[2], ClaimSelect)
    assert len(view.children[2].options) == 23


def test_claim_with_game_hands_out(bot):
    game = stock(bot)
    user = FakeMember(1, [MEMBER])
    interaction = fake_interaction(bot, user)
    asyncio.run(claim.callback(interaction, game="Hidden Ones"))
    assert interaction.response.deferred
    assert "`AAAAA-BBBBB-00000`" in interaction.followup.sent[0][0]
    assert bot.store.user_key(game["id"], 1) is not None
    unknown = fake_interaction(bot, user)
    asyncio.run(claim.callback(unknown, game="Nope"))
    assert "don't know that game" in unknown.response.sent[0][0]


# /request


def test_request_press_needs_outlet_and_email(bot):
    stock(bot)
    bot.users_by_id[5] = FakeUser(5)
    for outlet, email, missing in ((None, None, "`outlet:` and `email:`"), ("Mag", None, "`email:`"),
                                   (None, "a@b.se", "`outlet:`"), ("  ", "a@b.se", "`outlet:`")):
        interaction = fake_interaction(bot, FakeUser(5))
        asyncio.run(request_key.callback(interaction, game="Hidden Ones", kind=kind("press"),
                                         outlet=outlet, email=email))
        (text, kwargs), = interaction.response.sent
        assert text.startswith(f"Press requests need {missing}:") and kwargs == {"ephemeral": True}
    bad = fake_interaction(bot, FakeUser(5))
    asyncio.run(request_key.callback(bad, game="Hidden Ones", kind=kind("press"), outlet="Mag", email="nope"))
    assert "doesn't look right" in bad.response.sent[0][0]
    assert bot.store.open_request_count(5) == 0

    ok = fake_interaction(bot, FakeUser(5))
    asyncio.run(request_key.callback(ok, game="Hidden Ones", kind=kind("press"), outlet=" Mag ", email="a@b.se"))
    assert "Thanks!" in ok.followup.sent[0][0]
    assert bot.store.open_request_count(5) == 1
    _, card = bot.channel.sent[-1]
    fields = {f.name: f.value for f in card["embed"].fields}
    assert fields["Outlet"] == "Mag" and fields["Email (not verified)"] == "a@b.se"


def test_request_creator_sends_the_verify_link(bot):
    game = stock(bot)
    interaction = fake_interaction(bot, FakeUser(5))
    asyncio.run(request_key.callback(interaction, game="Hidden Ones", kind=kind("creator")))
    (text, kwargs), = interaction.response.sent
    assert "sign in with Discord" in text and kwargs["ephemeral"]
    button, = kwargs["view"].children
    assert button.url.startswith("https://example.test/keybot/verify?state=")
    assert bot.store.open_request_count(5) == 0
    # The shared checks still apply.
    bot.store.ban(5, game["id"])
    banned = fake_interaction(bot, FakeUser(5))
    asyncio.run(request_key.callback(banned, game="Hidden Ones", kind=kind("creator")))
    assert "can't get keys for **Hidden Ones**" in banned.response.sent[0][0]
