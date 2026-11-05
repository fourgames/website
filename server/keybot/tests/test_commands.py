"""The three slash commands (/claim, /request, /keys): what's registered, and how they answer."""

import asyncio

import discord
import pytest

from keybot.bot import (REQUEST_TYPES, ClaimSelect, KeyBot, PressForm, claim, keys_group, request_key)
from keybot.config import Config
from keybot.db import Store

from .test_handout_flow import ENV, MEMBER, FakeMember, FakeUser, bot, fake_interaction, stock  # noqa: F401

KEYS_SUBCOMMANDS = {"status", "add", "game", "grant", "find", "ban"}
OLD_SUBCOMMANDS = ("games", "log", "settings", "grant-role", "lookup", "export", "unban", "bans", "game-settings")
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
        # The same six either way: GRANTROLE_ENABLED only decides whether grant's role: is accepted.
        assert {c.name for c in keys.commands} == KEYS_SUBCOMMANDS
        for name in OLD_SUBCOMMANDS:
            assert keys.get_command(name) is None
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
        # Press asks for outlet and email in a pop-up form, not as typed options.
        assert set(options) == {"game", "type"} and options["type"]["required"]
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

    interaction = fake_interaction(bot, FakeMember(1, [MEMBER]))
    asyncio.run(claim.callback(interaction))
    (text, kwargs), = interaction.response.sent
    assert kwargs["ephemeral"] and kwargs["suppress_embeds"]
    # Public games with keys left, with keys per person, stock and roles; not private or empty ones.
    assert "**Hidden Ones** · 1 per person · 3 keys left · for **YouTube Member**" in text
    assert "**Secret** ·" not in text and "Empty" not in text
    # Their own keys, with the Steam link that fills each in.
    assert (f"**Secret**: `{given.value}` · [Redeem on Steam]"
            f"(https://store.steampowered.com/account/registerkey?key={given.value})") in text
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


def press_form(bot, user_id=5):
    """Runs /request type:press and returns the pop-up form it opened."""
    interaction = fake_interaction(bot, FakeUser(user_id))
    asyncio.run(request_key.callback(interaction, game="Hidden Ones", kind=kind("press")))
    assert interaction.response.sent == []
    form = interaction.response.modal
    assert isinstance(form, PressForm)
    return form


def submit(bot, form, outlet, email, user_id=5):
    form.outlet._value, form.email._value = outlet, email
    interaction = fake_interaction(bot, FakeUser(user_id))
    asyncio.run(form.on_submit(interaction))
    return interaction


def test_request_press_opens_a_form_with_both_fields_required(bot):
    stock(bot)
    form = press_form(bot)
    assert form.title == "Press key: Hidden Ones"
    assert [item.label for item in form.children] == ["Outlet", "Work email"]
    assert all(item.required for item in form.children)


def test_request_press_checks_before_the_form(bot):
    interaction = fake_interaction(bot, FakeUser(5))
    asyncio.run(request_key.callback(interaction, game="Nope", kind=kind("press")))
    assert "don't know that game" in interaction.response.sent[0][0]
    assert not hasattr(interaction.response, "modal")


def test_request_press_form_submit(bot):
    stock(bot)
    bot.users_by_id[5] = FakeUser(5)
    form = press_form(bot)
    bad = submit(bot, form, "Mag", "nope")
    assert "doesn't look like an email" in bad.response.sent[0][0]
    blank = submit(bot, form, "   ", "a@b.se")
    assert "Fill in your outlet" in blank.response.sent[0][0]
    assert bot.store.open_request_count(5) == 0

    ok = submit(bot, form, " Mag ", " a@b.se ")
    assert "Thanks!" in ok.followup.sent[0][0]
    assert bot.store.open_request_count(5) == 1
    _, card = bot.channel.sent[-1]
    fields = {f.name: f.value for f in card["embed"].fields}
    assert fields["Outlet"] == "Mag" and fields["Email (not verified)"] == "a@b.se"

    again = submit(bot, form, "Mag", "a@b.se")
    assert "already with the team" in again.response.sent[0][0]
    assert bot.store.open_request_count(5) == 1


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


# /keys: the six subcommands and their options

KEYS_OPTIONS = {
    "status": [("game", False), ("count", False)],
    "add": [("file", True), ("game", False), ("steam_app_id", False), ("name", False)],
    "grant": [("game", True), ("user", False), ("role", False)],
    "find": [("user", False), ("key", False)],
    "ban": [("action", True), ("user", False), ("game", False)],
    "game": [("game", True), ("public", False), ("per_user_limit", False), ("add_role", False),
             ("remove_role", False), ("clear_roles", False), ("steam_app_id", False), ("export", False)],
}


def test_keys_subcommand_options(tmp_path):
    store = Store(str(tmp_path / "k.db"))
    try:
        bot = KeyBot(Config.from_env(ENV), store)
        bot.register_commands()
        subcommands = {o["name"]: o for o in keys_group.to_dict(bot.tree)["options"]}
        assert set(subcommands) == set(KEYS_OPTIONS)
        for name, expected in KEYS_OPTIONS.items():
            options = subcommands[name].get("options", [])
            assert [(o["name"], o.get("required", False)) for o in options] == expected, name
            games = [o for o in options if o["name"] == "game"]
            assert all(o["autocomplete"] for o in games), name
        action = next(o for o in subcommands["ban"]["options"] if o["name"] == "action")
        assert [c["value"] for c in action["choices"]] == ["ban", "unban", "list"]
        count = next(o for o in subcommands["status"]["options"] if o["name"] == "count")
        assert (count["min_value"], count["max_value"]) == (1, 25)
    finally:
        store.close()


@pytest.fixture
def admin(bot, monkeypatch):
    """The bot, with everyone counting as the team (fake users aren't discord.Member)."""
    import keybot.bot
    monkeypatch.setattr(keybot.bot, "is_admin", lambda interaction, config: True)
    return bot


def keys_command(name):
    return keys_group.get_command(name)


def run(command, interaction, /, **kwargs):
    asyncio.run(keys_command(command).callback(interaction, **kwargs))


def answer(interaction):
    """The one ephemeral answer, whether sent at once or after deferring."""
    sent = interaction.response.sent + interaction.followup.sent
    assert len(sent) == 1, sent
    text, kwargs = sent[0]
    assert kwargs.get("ephemeral") is True
    return text, kwargs


def ask(bot, command, /, as_user=None, **kwargs):
    interaction = fake_interaction(bot, as_user or FakeUser(1000))
    run(command, interaction, **kwargs)
    return answer(interaction)


def choice(value):
    return discord.app_commands.Choice(name=value, value=value)


class FakeAttachment:
    def __init__(self, text, filename="keys.txt", size=None):
        self.data = text.encode()
        self.filename = filename
        self.size = len(self.data) if size is None else size

    async def read(self):
        return self.data


class FakeRole:
    def __init__(self, role_id):
        self.id = role_id
        self.mention = f"<@&{role_id}>"


@pytest.mark.parametrize("name, kwargs", [
    ("status", {}), ("add", {"file": FakeAttachment("A")}), ("grant", {"game": "Hidden Ones", "user": FakeUser(2)}),
    ("find", {"user": FakeUser(2)}), ("ban", {"action": choice("list")}), ("game", {"game": "Hidden Ones"}),
])
def test_keys_refuses_everyone_but_the_team(bot, name, kwargs):
    stock(bot)
    text, _ = ask(bot, name, as_user=FakeMember(1, [MEMBER]), **kwargs)
    assert text == "That's for the Four Games team."
    assert bot.store.bans() == [] and bot.store.user_key(1, 2) is None


# /keys status (was status, log and games)


def test_status_shows_games_then_the_latest_handouts(admin):
    store = admin.store
    game = stock(admin)
    other, _ = store.add_game("Other")
    store.add_keys(other["id"], ["OTH00-AAAAA-BBBBB", "OTH00-AAAAA-CCCCC"])
    store.update_game_settings(other["id"], public=False, per_user_limit=0)
    first = store.give_key(game["id"], 8, "member")
    second = store.give_key(other["id"], 9, "manual")
    store.create_request("press", game["id"], 5)

    text, _ = ask(admin, "status")
    lines = text.split("\n")
    assert lines[0] == ("**Hidden Ones**: 2 left · given 1 member · **1 open request** · "
                        "public, 1 per person · Steam app 123")
    assert lines[1].startswith("**Other**: 1 left · given 1 manual · ")
    assert lines[1].endswith("private, no limit per person · no Steam app id")
    assert lines[2] == "**Latest handouts** (key ids only)"
    assert f"**Other** → <@9> (manual), key #{second.key_id}" in lines[3]
    assert f"**Hidden Ones** → <@8> (member), key #{first.key_id}" in lines[4]
    assert first.value not in text and second.value not in text

    one, _ = ask(admin, "status", game="Hidden Ones")
    assert "**Other**" not in one and f"key #{first.key_id}" in one and f"key #{second.key_id}" not in one
    latest, _ = ask(admin, "status", count=1)
    assert f"key #{second.key_id}" in latest and f"key #{first.key_id}" not in latest


def test_status_default_count_unknown_game_and_no_games(admin):
    assert ask(admin, "status")[0].startswith("No games yet. Add one with its first keys: `/keys add file: name:")
    game, _ = admin.store.add_game("Big")
    admin.store.add_keys(game["id"], [f"BIG{i:02d}-AAAAA-BBBBB" for i in range(12)])
    empty, _ = ask(admin, "status")
    assert empty.endswith("**Latest handouts** (key ids only)\nNo keys given out yet.")
    for user in range(12):
        admin.store.give_key(game["id"], user, "member")
    text, _ = ask(admin, "status")
    assert text.count("→") == 10  # as /keys log did, but 10 by default
    assert ask(admin, "status", game="Nope")[0] == "I don't know that game."


# /keys add (was add and games name:)


def test_add_to_an_existing_game_reports_duplicates(admin):
    game = stock(admin)
    file = FakeAttachment("Key\nAAAAA-BBBBB-00000\nNEW00-AAAAA-BBBBB\nNEW00-AAAAA-BBBBB\n", "batch.csv")
    text, _ = ask(admin, "add", file=file, game="Hidden Ones")
    assert text == ("Added **1 key** to **Hidden Ones**.\n"
                    "Skipped 1 already in the database and 1 repeated in the file.\nAvailable now: 4.")
    assert admin.store.available_count(game["id"]) == 4


def test_add_with_name_creates_the_game(admin):
    text, _ = ask(admin, "add", file=FakeAttachment("NEW00-AAAAA-BBBBB\n"), name=" New Game ", steam_app_id=555)
    assert text.startswith("Added the game **New Game** (Steam app 555).\nAdded **1 key** to **New Game**.")
    row = admin.store.game_by_name("New Game")
    assert row["steam_app_id"] == 555 and admin.store.available_count(row["id"]) == 1
    # name: of a game it has already just adds to it; steam_app_id: then sets the id.
    text, _ = ask(admin, "add", file=FakeAttachment("NEW00-AAAAA-CCCCC\n"), name="New Game")
    assert text.startswith("Added **1 key** to **New Game**.")
    text, _ = ask(admin, "add", file=FakeAttachment("NEW00-AAAAA-DDDDD\n"), game="New Game", steam_app_id=556)
    assert text.startswith("Set the Steam app id of **New Game** (Steam app 556).\nAdded **1 key**")
    assert admin.store.game_by_name("New Game")["steam_app_id"] == 556


ONE_OF_GAME_AND_NAME = "Give either `game:` (a game the bot has) or `name:` (a new game to add)."


@pytest.mark.parametrize("kwargs, expected", [
    ({}, ONE_OF_GAME_AND_NAME),
    ({"name": "   "}, ONE_OF_GAME_AND_NAME),
    ({"game": "Hidden Ones", "name": "New"}, ONE_OF_GAME_AND_NAME),
    ({"game": "Nope"}, "I don't know that game. To add a new one, use `name:` instead of `game:`."),
    ({"name": "New", "file": FakeAttachment("X", "keys.pdf")}, "Send a .txt or .csv file."),
    ({"name": "New", "file": FakeAttachment("X", size=2_000_000)}, "That file is too big (1 MB at most)."),
    ({"name": "New", "file": FakeAttachment("a,b\nc,d\n", "keys.csv")},
     "Couldn't read the file: couldn't find the key column: name it \"Key\" in the first row."),
])
def test_add_refusals_change_nothing(admin, kwargs, expected):
    stock(admin)
    kwargs.setdefault("file", FakeAttachment("NEW00-AAAAA-BBBBB\n"))
    assert ask(admin, "add", **kwargs)[0] == expected
    assert [g["name"] for g in admin.store.games()] == ["Hidden Ones"]
    assert admin.store.available_count(admin.store.game_by_name("Hidden Ones")["id"]) == 3


# /keys grant (was grant and grant-role)


def test_grant_to_a_user(admin):
    game = stock(admin)
    user = FakeMember(2)
    text, _ = ask(admin, "grant", game="Hidden Ones", user=user)
    key = admin.store.user_key(game["id"], 2)
    assert text == f"Sent: <@2> has key #{key['id']} for **Hidden Ones** by DM." and key["reason"] == "manual"
    assert len(user.sent) == 1
    again, _ = ask(admin, "grant", game="Hidden Ones", user=user)
    assert "per-user limit" in again and "`/keys game per_user_limit:`" in again
    assert ask(admin, "grant", game="Hidden Ones", user=FakeMember(3, bot=True))[0] == "Bots can't redeem keys."
    assert ask(admin, "grant", game="Nope", user=FakeMember(4))[0] == "I don't know that game."


@pytest.mark.parametrize("grantrole", [False, True])
def test_grant_needs_exactly_one_of_user_and_role(admin, grantrole):
    from dataclasses import replace
    admin.config = replace(admin.config, grantrole_enabled=grantrole)
    stock(admin)
    for kwargs in ({}, {"user": FakeUser(2), "role": FakeRole(700)}):
        text, _ = ask(admin, "grant", game="Hidden Ones", **kwargs)
        assert text == "Give either `user:` (one person) or `role:` (everyone with it)."
    assert admin.store.available_count(admin.store.game_by_name("Hidden Ones")["id"]) == 3


def test_grant_to_a_role_is_refused_while_off(admin, monkeypatch):
    import keybot.bot

    async def role_members(guild, role_id):
        raise AssertionError("not asked for while it's off")

    monkeypatch.setattr(keybot.bot, "role_members", role_members)
    stock(admin)
    text, _ = ask(admin, "grant", game="Hidden Ones", role=FakeRole(700))
    assert "turned off" in text and "GRANTROLE_ENABLED=1" in text and "`user:`" in text


def test_grant_to_a_role_asks_first_when_on(admin, monkeypatch):
    from dataclasses import replace

    import keybot.bot
    from keybot.bot import GrantRoleView
    admin.config = replace(admin.config, grantrole_enabled=True)
    members = {700: [FakeMember(1), FakeMember(2)], 701: []}

    async def role_members(guild, role_id):
        return members[role_id]

    monkeypatch.setattr(keybot.bot, "role_members", role_members)
    game = stock(admin)
    interaction = fake_interaction(admin, FakeUser(1000))
    run("grant", interaction, game="Hidden Ones", role=FakeRole(700))
    assert interaction.response.deferred
    text, kwargs = answer(interaction)
    assert text.startswith("Send one **Hidden Ones** key by DM to everyone with <@&700>?")
    assert "2 member(s) with the role, 2 of them can get one" in text
    view = kwargs["view"]
    assert isinstance(view, GrantRoleView) and (view.role_id, view.game_id, view.admin_id) == (700, game["id"], 1000)
    # Nothing is sent before the confirmation.
    assert admin.store.available_count(game["id"]) == 3 and not members[700][0].sent
    nobody, _ = ask(admin, "grant", game="Hidden Ones", role=FakeRole(701))
    assert nobody == "Nobody (but bots) has <@&701>."


# /keys find (was lookup)


def test_find_by_user_or_key(admin):
    game = stock(admin)
    given = admin.store.give_key(game["id"], 9, "press")
    text, _ = ask(admin, "find", user=FakeUser(9))
    assert text.startswith("<@9> (9):") and f"`{given.value}`" in text
    assert ask(admin, "find", user=FakeUser(8))[0] == "<@8> has no keys from us."
    assert "given to <@9>" in ask(admin, "find", key=given.value)[0]
    assert "not given out yet" in ask(admin, "find", key="#2")[0]
    assert ask(admin, "find", key="ZZZZZ-ZZZZZ-ZZZZZ")[0] == "No such key here."
    for kwargs in ({}, {"user": FakeUser(9), "key": given.value}):
        assert ask(admin, "find", **kwargs)[0] == "Give either `user:` or `key:`."


# /keys ban (was ban, unban and bans)


def test_ban_unban_and_list(admin):
    game = stock(admin)
    store = admin.store
    user = FakeUser(5)
    text, _ = ask(admin, "ban", action=choice("ban"), user=user, game="Hidden Ones")
    assert text == "<@5> is banned from **Hidden Ones**. Keys they already have stay theirs."
    assert store.is_banned(5, game["id"]) and not store.is_banned(5)
    assert "(already was)." in ask(admin, "ban", action=choice("ban"), user=user, game="Hidden Ones")[0]
    ask(admin, "ban", action=choice("ban"), user=FakeUser(6))
    assert store.is_banned(6)

    listed, _ = ask(admin, "ban", action=choice("list"))
    assert "<@6> · every game" in listed and "<@5> · Hidden Ones" in listed
    other, _ = admin.store.add_game("Other")
    store.ban(7, other["id"])
    filtered, _ = ask(admin, "ban", action=choice("list"), game="Hidden Ones")
    assert "<@5>" in filtered and "<@6>" in filtered and "<@7>" not in filtered

    store.ban(5)
    text, _ = ask(admin, "ban", action=choice("unban"), user=user, game="Hidden Ones")
    assert text == "Lifted <@5>'s ban from **Hidden Ones**. They still have another ban: `/keys find user:` shows it."
    assert ask(admin, "ban", action=choice("unban"), user=user)[0] == "Lifted <@5>'s ban from every game."
    assert ask(admin, "ban", action=choice("unban"), user=user)[0] == "<@5> had no ban for every game."
    store.unban(6)
    store.unban(7, other["id"])
    assert ask(admin, "ban", action=choice("list"))[0] == "No bans."


def test_ban_option_errors(admin):
    stock(admin)
    assert ask(admin, "ban", action=choice("ban"))[0] == "Give `user:`: who to ban."
    assert ask(admin, "ban", action=choice("unban"), game="Hidden Ones")[0] == "Give `user:`: who to unban."
    text, _ = ask(admin, "ban", action=choice("list"), user=FakeUser(5))
    assert text.startswith("`action:list` lists every ban") and "`/keys find user:`" in text
    assert ask(admin, "ban", action=choice("ban"), user=FakeUser(5), game="Nope")[0] == "I don't know that game."
    assert admin.store.bans() == []


# /keys game (was settings and export, and games steam_app_id:)


def test_game_shows_and_changes_settings(admin):
    stock(admin)
    text, kwargs = ask(admin, "game", game="Hidden Ones")
    assert text == ("**Hidden Ones**\nVisibility: public (members can /claim it)\nPer person: 1 per person\n"
                    "Who can /claim it: **YouTube Member** (the member role)\nSteam app id: 123")
    assert "file" not in kwargs
    text, _ = ask(admin, "game", game="Hidden Ones", public=False, per_user_limit=3, add_role=FakeRole(600),
                  steam_app_id=999)
    assert text.startswith("Updated. **Hidden Ones**\nVisibility: private")
    assert "Per person: 3 per person" in text and "Who can /claim it: <@&600>\n" in text
    assert text.endswith("Steam app id: 999")
    row = admin.store.game_by_name("Hidden Ones")
    assert (row["public"], row["per_user_limit"], row["steam_app_id"]) == (0, 3, 999)
    text, _ = ask(admin, "game", game="Hidden Ones", add_role=FakeRole(601), remove_role=FakeRole(600))
    assert "Who can /claim it: <@&601>\n" in text
    text, _ = ask(admin, "game", game="Hidden Ones", clear_roles=True)
    assert "(the member role)" in text
    assert ask(admin, "game", game="Nope")[0] == "I don't know that game."


def test_game_export_sends_the_unclaimed_keys(admin):
    game = stock(admin)
    admin.store.give_key(game["id"], 1, "member")
    text, kwargs = ask(admin, "game", game="Hidden Ones", export=True)
    assert text == ("2 unclaimed keys for **Hidden Ones**. They stay in the bot; "
                    "delete the file once you're done with it.")
    file = kwargs["file"]
    assert file.filename == "hidden-ones-unclaimed-keys.txt"
    assert file.fp.read().decode() == "AAAAA-BBBBB-00001\nAAAAA-BBBBB-00002\n"
    assert admin.store.available_count(game["id"]) == 2  # the keys stay in the bot
    # With a change too: the settings first, then the file.
    text, kwargs = ask(admin, "game", game="Hidden Ones", public=False, export=True)
    assert text.startswith("Updated. **Hidden Ones**\nVisibility: private") and "\n\n2 unclaimed keys" in text
    assert "file" in kwargs


def test_game_export_with_no_unclaimed_keys(admin):
    admin.store.add_game("Empty")
    text, kwargs = ask(admin, "game", game="Empty", export=True)
    assert text == "**Empty** has no unclaimed keys." and "file" not in kwargs
