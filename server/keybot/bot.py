"""The Discord side: slash commands, the admin channel's Approve/Deny buttons, and handing out keys."""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
from dataclasses import dataclass

import aiohttp
import discord
from discord import app_commands
from discord.utils import escape_markdown

from .config import Config
from .db import Store
from .eligibility import Channel, evaluate
from .keyfile import KeyFileError, read_keys
from .lookups import TwitchAuth
from .state import sign_state

log = logging.getLogger("keybot")

MEMBERSHIP_URL = "https://www.youtube.com/@FourGamesAB/join"
REDEEM_URL = "https://store.steampowered.com/account/registerkey"
MAX_OPEN_REQUESTS = 3
MAX_KEY_FILE_BYTES = 1_000_000
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass(frozen=True)
class Outcome:
    """What hand_out did: "given", "already" (they had one), "none" (out of keys) or "dm_failed"."""

    status: str
    key_id: int | None = None


class KeyBot(discord.Client):
    def __init__(self, config: Config, store: Store):
        # No privileged intents: roles and permissions come with each interaction. The guilds
        # intent (not privileged) keeps the server's roles and channels cached.
        intents = discord.Intents.none()
        intents.guilds = True
        # Mentions in cards and logs show who it is without pinging anyone.
        super().__init__(intents=intents, allowed_mentions=discord.AllowedMentions.none())
        self.config = config
        self.store = store
        self.tree = app_commands.CommandTree(self)
        self.tree.error(on_command_error)
        self.http_session: aiohttp.ClientSession | None = None
        self.twitch = TwitchAuth(config.twitch_client_id, config.twitch_client_secret)
        self.web_runner = None

    async def setup_hook(self) -> None:
        from .web import start_web  # here, so the web module can import this one

        reopened = self.store.recover()
        if reopened:
            log.info("reopened %d request(s) cut off by a restart", reopened)
        self.http_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20))
        # Approve/Deny buttons keep working after a restart: their custom_id carries the request id.
        self.add_dynamic_items(ApproveButton, DenyButton)
        for command in (claim, mykeys, request_key, request_press, keys_group):
            self.tree.add_command(command)
        # Guild commands show up at once (global ones can take an hour), and the bot is for one server.
        guild = discord.Object(id=self.config.guild_id)
        self.tree.copy_global_to(guild=guild)
        await self.tree.sync(guild=guild)
        self.web_runner = await start_web(self)
        log.info("commands synced to guild %s; web on %s:%s", self.config.guild_id, self.config.host,
                 self.config.port)

    async def close(self) -> None:
        if self.web_runner:
            await self.web_runner.cleanup()
        if self.http_session:
            await self.http_session.close()
        await super().close()

    async def on_ready(self) -> None:
        log.info("logged in as %s (%s)", self.user, self.user.id if self.user else "?")

    async def user_by_id(self, user_id: int) -> discord.User:
        return self.get_user(user_id) or await self.fetch_user(user_id)

    async def admin_channel(self) -> discord.abc.Messageable:
        channel = self.get_channel(self.config.admin_channel_id)
        return channel or await self.fetch_channel(self.config.admin_channel_id)

    # Handing out

    async def hand_out(self, user: discord.abc.User, game: sqlite3.Row, reason: str,
                       request_id: int | None = None) -> Outcome:
        """Takes a key and DMs it. If the DM doesn't arrive, the key goes back."""
        given = self.store.give_key(game["id"], user.id, reason, request_id)
        if given.status != "given":
            return Outcome(given.status, given.key_id)
        try:
            await user.send(key_message(game, given.value))
        except discord.HTTPException as error:
            self.store.undo_give(given.key_id, user.id)
            log.info("couldn't DM %s key #%s for %s (%s); put it back", user.id, given.key_id, game["name"],
                     type(error).__name__)
            return Outcome("dm_failed")
        log.info("gave key #%s for %s to %s (%s)", given.key_id, game["name"], user.id, reason)
        await self.low_stock_alert(game)
        return Outcome("given", given.key_id)

    async def low_stock_alert(self, game: sqlite3.Row) -> None:
        left = self.store.available_count(game["id"])
        # Once when it drops below the line and once when it runs out, not on every key.
        if left == 0:
            text = f"Out of keys for **{escape_markdown(game['name'])}**. Add more with `/keys add`."
        elif left == self.config.low_stock - 1:
            text = (f"Running low on keys for **{escape_markdown(game['name'])}**: {left} left. "
                    "Add more with `/keys add`.")
        else:
            return
        try:
            await (await self.admin_channel()).send(text)
        except discord.HTTPException:
            log.exception("couldn't post the low-stock alert")

    # Requests

    async def post_request_card(self, request_id: int) -> None:
        request = self.store.request(request_id)
        game = self.store.game(request["game_id"])
        user = await self.user_by_id(int(request["user_id"]))
        view = discord.ui.View(timeout=None)
        view.add_item(ApproveButton(request_id))
        view.add_item(DenyButton(request_id))
        message = await (await self.admin_channel()).send(embed=request_embed(request, game, user), view=view)
        self.store.set_admin_message(request_id, message.id)

    async def creator_verified(self, user_id: int, game_id: int, channels: list[Channel]) -> tuple[str, str]:
        """After the Discord login on the web: approve or send for review. (title, text) for the page."""
        store = self.store
        game = store.game(game_id)
        if game is None:
            return "Something's off", "That game isn't in the list any more. Run /request again in Discord."
        if store.user_key(game_id, user_id):
            return "You already have a key", "Run /mykeys in the Four Games Discord to see it again."
        if store.open_request_for(user_id, game_id):
            return "Already waiting for review", "Your request for this game is with the team already."
        if store.open_request_count(user_id) >= MAX_OPEN_REQUESTS:
            return "Too many open requests", "Wait until the team has answered one of your requests."

        decision = evaluate(channels, self.config.thresholds)
        details = {"channels": [channel.to_dict() for channel in channels], "reasons": decision.reasons}
        best = decision.channel or (channels[0] if channels else None)
        channel_url = best.url if best else None

        if decision.approved:
            user = await self.user_by_id(user_id)
            # processing while the DM goes out, so it counts as open and can't be doubled.
            request_id = store.create_request("creator", game_id, user_id, status="processing",
                                              channel_url=channel_url, details=details)
            outcome = await self.hand_out(user, game, "creator", request_id)
            if outcome.status == "given":
                store.finish_request(request_id, "approved", "auto", outcome.key_id)
                log.info("creator request #%s auto-approved (%s)", request_id, channel_url)
                return "Verified — check your DMs", f"Your key for {game['name']} is in your Discord DMs."
            store.delete_request(request_id)
            if outcome.status == "already":
                return "You already have a key", "Run /mykeys in the Four Games Discord to see it again."
            if outcome.status == "dm_failed":
                return ("Verified, but we couldn't DM you",
                        "Allow direct messages from server members (right-click the Four Games server → "
                        "Privacy Settings), then run /request again.")
            # Out of keys: it qualifies, so let the team hand one out once there are more.
            details["reasons"] = ["Meets the thresholds, but there were no keys left"]

        request_id = store.create_request("creator", game_id, user_id, channel_url=channel_url, details=details)
        try:
            await self.post_request_card(request_id)
        except discord.HTTPException:
            store.delete_request(request_id)
            log.exception("couldn't post the card for request #%s", request_id)
            return "Something went wrong", "We couldn't pass your request on. Try /request again later."
        log.info("creator request #%s sent for review", request_id)
        return "Sent for review", "The team will take a look, and you'll get a DM either way."


def key_message(game: sqlite3.Row, value: str) -> str:
    lines = [f"Here's your Steam key for **{escape_markdown(game['name'])}**:", f"`{value}`",
             f"Redeem it in Steam (Games → Activate a Product on Steam) or at {REDEEM_URL}"]
    if game["steam_app_id"]:
        lines.append(f"https://store.steampowered.com/app/{game['steam_app_id']}")
    lines.append("You can see your keys again any time with /mykeys.")
    return "\n".join(lines)


def request_embed(request: sqlite3.Row, game: sqlite3.Row, user: discord.abc.User | None) -> discord.Embed:
    details = json.loads(request["details"] or "{}")
    kind = "Creator" if request["kind"] == "creator" else "Press"
    embed = discord.Embed(title=f"{kind} key request #{request['id']}", colour=discord.Colour.blurple())
    who = f"<@{request['user_id']}>"
    if user:
        who += f" ({escape_markdown(user.name)}, {user.id})"
    embed.add_field(name="Who", value=who, inline=False)
    embed.add_field(name="Game", value=escape_markdown(game["name"]), inline=False)
    for data in details.get("channels", []):
        channel = Channel.from_dict(data)
        platform = "YouTube" if channel.platform == "youtube" else "Twitch"
        embed.add_field(name=platform, value=f"[{escape_markdown(channel.name) or channel.url}]({channel.url})\n"
                                             f"{channel.summary()}"[:1024], inline=False)
    if request["kind"] == "press":
        embed.add_field(name="Outlet", value=escape_markdown(details.get("outlet", ""))[:1024], inline=False)
        embed.add_field(name="Email (not verified)", value=escape_markdown(details.get("email", ""))[:1024],
                        inline=False)
    reasons = details.get("reasons") or []
    if reasons:
        embed.add_field(name="Why it needs a look", value="\n".join(reasons)[:1024], inline=False)
    return embed


# Who's who


def is_member(user: discord.abc.User, config: Config) -> bool:
    if not isinstance(user, discord.Member):
        return False
    role = config.member_role
    if role.isdigit():
        return any(r.id == int(role) for r in user.roles)
    return any(r.name.casefold() == role.casefold() for r in user.roles)


def is_admin(interaction: discord.Interaction, config: Config) -> bool:
    user = interaction.user
    if not isinstance(user, discord.Member):
        return False
    perms = interaction.permissions
    if perms.administrator or perms.manage_guild:
        return True
    return config.admin_role_id is not None and any(r.id == config.admin_role_id for r in user.roles)


async def require_admin(interaction: discord.Interaction) -> bool:
    if is_admin(interaction, interaction.client.config):
        return True
    await interaction.response.send_message("That's for the Four Games team.", ephemeral=True)
    return False


def resolve_game(store: Store, name: str) -> sqlite3.Row | None:
    return store.game_by_name(name)


def choices(games: list[sqlite3.Row], current: str) -> list[app_commands.Choice[str]]:
    current = current.casefold()
    return [app_commands.Choice(name=g["name"][:100], value=g["name"][:100])
            for g in games if current in g["name"].casefold()][:25]


async def on_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
    log.error("command failed", exc_info=error)
    text = "Something went wrong on our side. Try again in a bit."
    try:
        if interaction.response.is_done():
            await interaction.followup.send(text, ephemeral=True)
        else:
            await interaction.response.send_message(text, ephemeral=True)
    except discord.HTTPException:
        pass


# Members: /claim and /mykeys


def not_member_text(config: Config) -> str:
    role = "member role" if config.member_role.isdigit() else f"**{config.member_role}** role"
    return ("Free keys are a perk for our YouTube channel members.\n"
            f"Join here: {MEMBERSHIP_URL}\n"
            "Then connect YouTube to Discord (User Settings → Connections) so you get the "
            f"{role}, and run /claim again.")


async def claimable_autocomplete(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    return choices(interaction.client.store.claimable_games(interaction.user.id), current)


@app_commands.command(name="claim", description="Get a Steam key for one of our games (YouTube members)")
@app_commands.describe(game="Which game (leave out to pick from a list)")
@app_commands.autocomplete(game=claimable_autocomplete)
@app_commands.guild_only()
async def claim(interaction: discord.Interaction, game: str | None = None) -> None:
    bot: KeyBot = interaction.client
    if not is_member(interaction.user, bot.config):
        await interaction.response.send_message(not_member_text(bot.config), ephemeral=True)
        return
    if game is None:
        games = bot.store.claimable_games(interaction.user.id)
        if not games:
            await interaction.response.send_message(
                "There's nothing new to claim right now. /mykeys shows the keys you already have.", ephemeral=True)
            return
        await interaction.response.send_message("Which game?", view=ClaimView(games), ephemeral=True)
        return
    row = resolve_game(bot.store, game)
    if row is None:
        await interaction.response.send_message("I don't know that game. Pick one from the list.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    await claim_game(interaction, row)


async def claim_game(interaction: discord.Interaction, game: sqlite3.Row) -> None:
    """The claim itself. The interaction is already answered (deferred or edited), so this follows up."""
    bot: KeyBot = interaction.client
    name = escape_markdown(game["name"])
    outcome = await bot.hand_out(interaction.user, game, "member")
    if outcome.status == "given":
        text = f"Your key for **{name}** is in your DMs. Enjoy!"
    elif outcome.status == "already":
        text = f"You've already had a key for **{name}**. /mykeys shows it again."
    elif outcome.status == "none":
        text = f"Sorry, there are no keys left for **{name}** right now."
    else:
        text = ("I couldn't DM you, so I kept the key for you. Allow direct messages from server members "
                "(right-click the server → Privacy Settings), then run /claim again.")
    await interaction.followup.send(text, ephemeral=True)


class ClaimSelect(discord.ui.Select):
    def __init__(self, games: list[sqlite3.Row]):
        super().__init__(placeholder="Choose a game", options=[
            discord.SelectOption(label=g["name"][:100], value=str(g["id"])) for g in games[:25]
        ])

    async def callback(self, interaction: discord.Interaction) -> None:
        bot: KeyBot = interaction.client
        # Checked again: the menu can sit there a while.
        if not is_member(interaction.user, bot.config):
            await interaction.response.edit_message(content=not_member_text(bot.config), view=None)
            return
        game = bot.store.game(int(self.values[0]))
        if game is None:
            await interaction.response.edit_message(content="That game is gone. Run /claim again.", view=None)
            return
        await interaction.response.edit_message(
            content=f"Getting your key for **{escape_markdown(game['name'])}**…", view=None)
        await claim_game(interaction, game)


class ClaimView(discord.ui.View):
    def __init__(self, games: list[sqlite3.Row]):
        super().__init__(timeout=300)
        self.add_item(ClaimSelect(games))


@app_commands.command(name="mykeys", description="See the keys you've been given")
@app_commands.guild_only()
async def mykeys(interaction: discord.Interaction) -> None:
    keys = interaction.client.store.user_keys(interaction.user.id)
    if not keys:
        await interaction.response.send_message("You haven't been given any keys yet.", ephemeral=True)
        return
    lines = [f"**{escape_markdown(k['game'])}**: `{k['value']}`" for k in keys]
    lines.append(f"Redeem in Steam (Games → Activate a Product on Steam) or at {REDEEM_URL}")
    # Ephemeral: only they see it, and it works with DMs closed too.
    await interaction.response.send_message("\n".join(lines)[:2000], ephemeral=True)


# Creators and press: /request and /request-press


async def stocked_autocomplete(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    return choices([g for g in interaction.client.store.games() if g["available"]], current)


async def request_precheck(interaction: discord.Interaction, game_name: str) -> sqlite3.Row | None:
    """The checks /request and /request-press share. The game, or None after answering."""
    bot: KeyBot = interaction.client
    store, user_id = bot.store, interaction.user.id
    game = resolve_game(store, game_name)
    if game is None:
        text = "I don't know that game. Pick one from the list."
    elif store.user_key(game["id"], user_id):
        text = f"You've already had a key for **{escape_markdown(game['name'])}**. /mykeys shows it again."
    elif store.open_request_for(user_id, game["id"]):
        text = "Your request for this game is already with the team."
    elif store.open_request_count(user_id) >= MAX_OPEN_REQUESTS:
        text = f"You have {MAX_OPEN_REQUESTS} requests waiting already. Wait until the team has answered one."
    elif store.available_count(game["id"]) == 0:
        text = f"There are no keys for **{escape_markdown(game['name'])}** right now. Try again later."
    else:
        return game
    await interaction.response.send_message(text, ephemeral=True)
    return None


@app_commands.command(name="request", description="Content creators: ask for a key for one of our games")
@app_commands.describe(game="Which game")
@app_commands.autocomplete(game=stocked_autocomplete)
@app_commands.guild_only()
async def request_key(interaction: discord.Interaction, game: str) -> None:
    bot: KeyBot = interaction.client
    row = await request_precheck(interaction, game)
    if row is None:
        return
    now = time.time()
    token, state = sign_state(bot.config.state_secret, interaction.user.id, row["id"], now)
    bot.store.save_state(state.nonce, interaction.user.id, row["id"], state.expires_at, int(now))
    view = discord.ui.View()
    view.add_item(discord.ui.Button(label="Verify your channel", style=discord.ButtonStyle.link,
                                    url=f"{bot.config.public_base_url}/verify?state={token}"))
    await interaction.response.send_message(
        f"To get a key for **{escape_markdown(row['name'])}**, sign in with Discord so we can see your "
        "verified YouTube or Twitch connection (add it under User Settings → Connections first). "
        "The link works once, for 15 minutes.",
        view=view, ephemeral=True)


@app_commands.command(name="request-press", description="Press: ask for a review key for one of our games")
@app_commands.describe(game="Which game", outlet="The publication or site you write for",
                       email="Your work email, so we can reach you")
@app_commands.autocomplete(game=stocked_autocomplete)
@app_commands.guild_only()
async def request_press(interaction: discord.Interaction, game: str,
                        outlet: app_commands.Range[str, 1, 100], email: app_commands.Range[str, 3, 254]) -> None:
    bot: KeyBot = interaction.client
    if not EMAIL_PATTERN.match(email.strip()):
        await interaction.response.send_message("That email address doesn't look right.", ephemeral=True)
        return
    row = await request_precheck(interaction, game)
    if row is None:
        return
    # Always reviewed by hand. Once the company mail exists, the email could be verified first.
    request_id = bot.store.create_request("press", row["id"], interaction.user.id,
                                          details={"outlet": outlet.strip(), "email": email.strip()})
    await interaction.response.defer(ephemeral=True, thinking=True)
    try:
        await bot.post_request_card(request_id)
    except discord.HTTPException:
        bot.store.delete_request(request_id)
        log.exception("couldn't post the card for request #%s", request_id)
        await interaction.followup.send("We couldn't pass your request on. Try again later.", ephemeral=True)
        return
    log.info("press request #%s sent for review", request_id)
    await interaction.followup.send("Thanks! The team will take a look, and you'll get a DM either way.",
                                    ephemeral=True)


# The admin channel's buttons


class ApproveButton(discord.ui.DynamicItem[discord.ui.Button], template=r"keybot:approve:(?P<id>[0-9]+)"):
    def __init__(self, request_id: int):
        super().__init__(discord.ui.Button(label="Approve", style=discord.ButtonStyle.success,
                                           custom_id=f"keybot:approve:{request_id}"))
        self.request_id = request_id

    @classmethod
    async def from_custom_id(cls, interaction: discord.Interaction, item: discord.ui.Button, match: re.Match, /):
        return cls(int(match["id"]))

    async def callback(self, interaction: discord.Interaction) -> None:
        await decide(interaction, self.request_id, approve=True)


class DenyButton(discord.ui.DynamicItem[discord.ui.Button], template=r"keybot:deny:(?P<id>[0-9]+)"):
    def __init__(self, request_id: int):
        super().__init__(discord.ui.Button(label="Deny", style=discord.ButtonStyle.danger,
                                           custom_id=f"keybot:deny:{request_id}"))
        self.request_id = request_id

    @classmethod
    async def from_custom_id(cls, interaction: discord.Interaction, item: discord.ui.Button, match: re.Match, /):
        return cls(int(match["id"]))

    async def callback(self, interaction: discord.Interaction) -> None:
        await decide(interaction, self.request_id, approve=False)


async def decide(interaction: discord.Interaction, request_id: int, approve: bool) -> None:
    bot: KeyBot = interaction.client
    store = bot.store
    if not await require_admin(interaction):
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    # Only one admin's click goes through; a second one is told it's handled.
    if not store.start_decision(request_id):
        request = store.request(request_id)
        status = request["status"] if request else "gone"
        await interaction.followup.send(f"Request #{request_id} is already {status}.", ephemeral=True)
        return
    finished = False
    try:
        request = store.request(request_id)
        game = store.game(request["game_id"])
        user = await bot.user_by_id(int(request["user_id"]))
        admin = str(interaction.user.id)
        name = escape_markdown(game["name"])
        if approve:
            outcome = await bot.hand_out(user, game, request["kind"], request_id)
            if outcome.status in ("given", "already"):
                store.finish_request(request_id, "approved", admin, outcome.key_id)
                finished = True
                note = f"key #{outcome.key_id}" + (" (they already had it)" if outcome.status == "already" else "")
                await mark_card(interaction, f"Approved by {interaction.user.mention}, {note}")
                await interaction.followup.send(f"Done: {user.mention} has key #{outcome.key_id} for {name}.",
                                                ephemeral=True)
            elif outcome.status == "none":
                await interaction.followup.send(
                    f"No keys left for {name}. Add some with `/keys add`, then press Approve again.", ephemeral=True)
            else:
                await interaction.followup.send(
                    f"Couldn't DM {user.mention} (their DMs are closed), so no key was used. "
                    "The request stays open.", ephemeral=True)
        else:
            store.finish_request(request_id, "denied", admin)
            finished = True
            try:
                await user.send(
                    f"Thanks for asking about a key for **{name}**. We can't send one this time, "
                    "but we appreciate your interest in Four Games!")
                told = "told them"
            except discord.HTTPException:
                told = "couldn't DM them"
            await mark_card(interaction, f"Denied by {interaction.user.mention}")
            await interaction.followup.send(f"Denied; {told}.", ephemeral=True)
        log.info("request #%s %s by %s", request_id, "approved" if approve and finished else
                 "denied" if finished else "left open", admin)
    finally:
        # Anything short of a decision (DM failed, no keys, an error) leaves it open to try again.
        if not finished:
            store.reopen_request(request_id)


async def mark_card(interaction: discord.Interaction, note: str) -> None:
    """Writes the decision on the card and takes the buttons off."""
    message = interaction.message
    if message is None:
        return
    embed = message.embeds[0] if message.embeds else discord.Embed()
    embed.add_field(name="Decision", value=note, inline=False)
    try:
        await message.edit(embed=embed, view=None)
    except discord.HTTPException:
        log.exception("couldn't update the card")


# Admins: /keys …

keys_group = app_commands.Group(name="keys", description="Manage game keys (Four Games team)", guild_only=True)


async def all_games_autocomplete(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    return choices(interaction.client.store.games(), current)


@keys_group.command(name="add", description="Add keys from a .txt or .csv file (one per line, or a Steamworks export)")
@app_commands.describe(game="Which game", file="The key file")
@app_commands.autocomplete(game=all_games_autocomplete)
async def keys_add(interaction: discord.Interaction, game: str, file: discord.Attachment) -> None:
    if not await require_admin(interaction):
        return
    bot: KeyBot = interaction.client
    row = resolve_game(bot.store, game)
    if row is None:
        await interaction.response.send_message("Add the game first with `/keys games name:…`.", ephemeral=True)
        return
    if not file.filename.lower().endswith((".txt", ".csv")):
        await interaction.response.send_message("Send a .txt or .csv file.", ephemeral=True)
        return
    if file.size > MAX_KEY_FILE_BYTES:
        await interaction.response.send_message("That file is too big (1 MB at most).", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    try:
        values, repeats = read_keys(text)
    except KeyFileError as error:
        await interaction.followup.send(f"Couldn't read the file: {error}.", ephemeral=True)
        return
    added, known = bot.store.add_keys(row["id"], values, added_by=str(interaction.user.id))
    log.info("%s added %d key(s) to %s (%d known, %d repeated in the file)", interaction.user.id, added,
             row["name"], known, repeats)
    await interaction.followup.send(
        f"Added **{added}** key(s) to **{escape_markdown(row['name'])}**.\n"
        f"Skipped {known} already in the database and {repeats} repeated in the file.\n"
        f"Available now: {bot.store.available_count(row['id'])}.", ephemeral=True)


@keys_group.command(name="games", description="List the games, or add one (or set its Steam app id)")
@app_commands.describe(name="A game to add or update (leave out to list them)", steam_app_id="Its Steam app id")
async def keys_games(interaction: discord.Interaction, name: app_commands.Range[str, 1, 100] | None = None,
                     steam_app_id: app_commands.Range[int, 1] | None = None) -> None:
    if not await require_admin(interaction):
        return
    store: Store = interaction.client.store
    if name:
        row, created = store.add_game(name, steam_app_id)
        app = f" (Steam app {row['steam_app_id']})" if row["steam_app_id"] else ""
        verb = "Added" if created else "Updated"
        await interaction.response.send_message(f"{verb} **{escape_markdown(row['name'])}**{app}.", ephemeral=True)
        return
    games = store.games()
    if not games:
        await interaction.response.send_message("No games yet. Add one with `/keys games name:…`.", ephemeral=True)
        return
    lines = [f"**{escape_markdown(g['name'])}**: Steam app {g['steam_app_id'] or '?'}, {g['available']} key(s) left"
             for g in games]
    await interaction.response.send_message("\n".join(lines)[:2000], ephemeral=True)


@keys_group.command(name="status", description="Keys left and given out, per game")
async def keys_status(interaction: discord.Interaction) -> None:
    if not await require_admin(interaction):
        return
    rows = interaction.client.store.status_summary()
    if not rows:
        await interaction.response.send_message("No games yet.", ephemeral=True)
        return
    lines = []
    for r in rows:
        lines.append(f"**{escape_markdown(r['name'])}**: {r['available'] or 0} available · given "
                     f"{r['member'] or 0} member, {r['creator'] or 0} creator, {r['press'] or 0} press, "
                     f"{r['manual'] or 0} manual · {r['open_requests']} open request(s)")
    await interaction.response.send_message("\n".join(lines)[:2000], ephemeral=True)


@keys_group.command(name="log", description="The latest handouts (key ids only)")
@app_commands.describe(count="How many (default 15)")
async def keys_log(interaction: discord.Interaction, count: app_commands.Range[int, 1, 25] = 15) -> None:
    if not await require_admin(interaction):
        return
    rows = interaction.client.store.recent_handouts(count)
    if not rows:
        await interaction.response.send_message("No keys given out yet.", ephemeral=True)
        return
    lines = []
    for r in rows:
        when = discord.utils.format_dt(discord.utils.parse_time(r["given_at"]), "R")
        extra = f", request #{r['request_id']}" if r["request_id"] else ""
        lines.append(f"{when} **{escape_markdown(r['game'])}** → <@{r['given_to']}> ({r['reason']}{extra}), "
                     f"key #{r['id']}")
    await interaction.response.send_message("\n".join(lines)[:2000], ephemeral=True)
