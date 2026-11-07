"""The Discord side: slash commands, the admin channel's Approve/Deny buttons, and handing out keys."""

from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import aiohttp
import discord
from discord import app_commands
from discord.utils import escape_markdown

from .config import Config
from .db import MAX_PER_USER_LIMIT, STOCK_LOW, STOCK_OUT, Store, role_ids
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
POOLS_PER_PAGE = 10
# How often the bot looks for requests nobody answered (REQUEST_EXPIRE_DAYS).
EXPIRE_CHECK_SECONDS = 3600
# The DM when a request closes by itself. No reason on purpose: it's the same for everyone.
EXPIRED_TEXT = ("Thanks for asking about a key for **{name}**. We couldn't get to your request this time, "
                "so it's been closed. You're welcome to try /request again in the future!")
BANNED_TEXT = "You can't get keys{where} here. If you think that's a mistake, ask the Four Games team."


@dataclass(frozen=True)
class Outcome:
    """What hand_out did: "given", "already" (at the per-user limit), "none" (out of keys),
    "banned", or "dm_failed" (the DM was required and didn't arrive; the key went back)."""

    status: str
    key_id: int | None = None
    # repr=False: an Outcome in a log line or traceback never shows the key.
    value: str | None = field(default=None, repr=False)
    dm_sent: bool = False


@dataclass
class GrantReport:
    """What /keys grant role: did, in counts."""

    given: int = 0
    at_limit: int = 0
    banned: int = 0
    dm_failed: int = 0
    out_of_keys: int = 0

    def summary(self) -> str:
        parts = [f"**{plural(self.given, 'key')}** sent"]
        if self.at_limit:
            parts.append(f"{self.at_limit} skipped (already at the limit)")
        if self.banned:
            parts.append(f"{self.banned} skipped (banned)")
        if self.dm_failed:
            parts.append(f"{self.dm_failed} with DMs closed (no key used)")
        if self.out_of_keys:
            parts.append(f"{self.out_of_keys} not reached (out of keys)")
        return ", ".join(parts) + "."


class KeyBot(discord.Client):
    def __init__(self, config: Config, store: Store):
        # No privileged intents: roles and permissions come with each interaction. The guilds
        # intent (not privileged) keeps the server's roles and channels cached. /keys grant role: needs
        # the member list (the privileged Server Members intent), so only when it's turned on.
        intents = discord.Intents.none()
        intents.guilds = True
        if config.grantrole_enabled:
            intents.members = True
        # Mentions in cards and logs show who it is without pinging anyone.
        super().__init__(intents=intents, allowed_mentions=discord.AllowedMentions.none())
        self.config = config
        self.store = store
        self.tree = app_commands.CommandTree(self)
        self.tree.error(on_command_error)
        self.http_session: aiohttp.ClientSession | None = None
        self.twitch = TwitchAuth(config.twitch_client_id, config.twitch_client_secret)
        self.web_runner = None
        self.expire_task: asyncio.Task | None = None

    async def setup_hook(self) -> None:
        from .web import start_web  # here, so the web module can import this one

        reopened = self.store.recover()
        if reopened:
            log.info("reopened %d request(s) cut off by a restart", reopened)
        self.http_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20))
        # Approve/Deny buttons keep working after a restart: their custom_id carries the request id.
        self.add_dynamic_items(ApproveButton, DenyButton)
        self.register_commands()
        # Guild commands show up at once (global ones can take an hour), and the bot is for one server.
        guild = discord.Object(id=self.config.guild_id)
        self.tree.copy_global_to(guild=guild)
        # Only guild commands: if an older version ever registered global ones, they'd show up twice.
        self.tree.clear_commands(guild=None)
        if await self.tree.fetch_commands():
            await self.tree.sync()
            log.info("removed the global commands")
        # The sync replaces the guild's whole command list, so old commands (/mykeys, /pools, …) go.
        await self.tree.sync(guild=guild)
        self.web_runner = await start_web(self)
        log.info("commands synced to guild %s; web on %s:%s", self.config.guild_id, self.config.host,
                 self.config.port)

    def register_commands(self) -> None:
        """The three commands: /claim, /request and /keys (status, add, game, grant, ban, find)."""
        for command in (claim, request_key, keys_group):
            self.tree.add_command(command)

    async def close(self) -> None:
        if self.expire_task:
            self.expire_task.cancel()
        if self.web_runner:
            await self.web_runner.cleanup()
        if self.http_session:
            await self.http_session.close()
        await super().close()

    async def on_ready(self) -> None:
        log.info("logged in as %s (%s)", self.user, self.user.id if self.user else "?")
        # on_ready comes again after a reconnect; one loop is enough.
        if self.config.request_expire_days > 0 and self.expire_task is None:
            self.expire_task = asyncio.create_task(self.expire_loop())

    async def user_by_id(self, user_id: int) -> discord.User:
        return self.get_user(user_id) or await self.fetch_user(user_id)

    async def admin_channel(self) -> discord.abc.Messageable:
        channel = self.get_channel(self.config.admin_channel_id)
        return channel or await self.fetch_channel(self.config.admin_channel_id)

    # Requests nobody answered

    async def expire_loop(self) -> None:
        while not self.is_closed():
            try:
                await self.expire_requests()
            except Exception:
                log.exception("closing old requests failed")
            await asyncio.sleep(EXPIRE_CHECK_SECONDS)

    async def expire_requests(self, now: datetime | None = None) -> int:
        """Closes the requests older than REQUEST_EXPIRE_DAYS: a polite DM to each person and a note
        on its card (buttons off). Returns how many."""
        days = self.config.request_expire_days
        if days <= 0:
            return 0
        now = now or datetime.now(timezone.utc)
        cutoff = (now - timedelta(days=days)).isoformat(timespec="seconds")
        expired = self.store.expire_requests(cutoff)
        for request in expired:
            game = self.store.game(request["game_id"])
            name = escape_markdown(game["name"]) if game else "our game"
            try:
                user = await self.user_by_id(int(request["user_id"]))
                await user.send(EXPIRED_TEXT.format(name=name))
                told = "told them"
            except discord.HTTPException:
                told = "couldn't DM them"
            await self.note_on_card(request, f"Closed automatically after {plural(days, 'day')} "
                                             f"without an answer; {told}")
            log.info("request #%s closed after %s days without an answer (%s)", request["id"], days, told)
        return len(expired)

    async def note_on_card(self, request: sqlite3.Row, note: str) -> None:
        """Like mark_card, for a request decided outside a button click."""
        if not request["admin_message_id"]:
            return
        try:
            channel = await self.admin_channel()
            message = await channel.fetch_message(int(request["admin_message_id"]))
            embed = message.embeds[0] if message.embeds else discord.Embed()
            embed.add_field(name="Decision", value=note, inline=False)
            await message.edit(embed=embed, view=None)
        except discord.HTTPException:
            log.exception("couldn't update the card for request #%s", request["id"])

    # Handing out

    async def hand_out(self, user: discord.abc.User, game: sqlite3.Row, reason: str,
                       request_id: int | None = None, *, dm_required: bool = True) -> Outcome:
        """Takes a key and DMs it.

        dm_required (admin approvals, /keys grant to a user or a role, creator auto-approval: the DM is the only
        way the key reaches them): if the DM doesn't arrive, the key goes back. Without it (/claim,
        which shows the key in its reply), the DM is a receipt and a failed one changes nothing.
        """
        given = self.store.give_key(game["id"], user.id, reason, request_id)
        if given.status != "given":
            return Outcome(given.status, given.key_id)
        try:
            await user.send(key_message(game, given.value))
            dm_sent = True
        except discord.HTTPException as error:
            if dm_required:
                self.store.undo_give(given.key_id, user.id)
                log.info("couldn't DM %s key #%s for %s (%s); put it back", user.id, given.key_id, game["name"],
                         type(error).__name__)
                return Outcome("dm_failed")
            log.info("couldn't DM %s a copy of key #%s for %s (%s); shown in the reply only", user.id,
                     given.key_id, game["name"], type(error).__name__)
            dm_sent = False
        log.info("gave key #%s for %s to %s (%s)", given.key_id, game["name"], user.id, reason)
        await self.low_stock_alert(game)
        return Outcome("given", given.key_id, given.value, dm_sent)

    async def low_stock_alert(self, game: sqlite3.Row) -> None:
        """After a handout: the LOW_STOCK line (once, as it drops below), the 10% warning and the
        out-of-keys warning (each once until the game is restocked), in one message."""
        store = self.store
        left = store.available_count(game["id"])
        name = escape_markdown(game["name"])
        level = store.next_stock_warning(game["id"])
        lines = []
        if level == STOCK_OUT:
            lines.append(f"Out of keys for **{name}**. Add more with `/keys add`.")
        else:
            if left == self.config.low_stock - 1:
                lines.append(f"Running low on keys for **{name}**: {left} left. Add more with `/keys add`.")
            if level == STOCK_LOW:
                lines.append(f"**{name}** is down to 10% of its keys: {left} of {store.total_count(game['id'])} "
                             "left.")
        if not lines:
            return
        try:
            await (await self.admin_channel()).send("\n".join(lines))
        except discord.HTTPException:
            log.exception("couldn't post the low-stock alert")

    async def grant_to_members(self, members: list[discord.abc.User], game: sqlite3.Row) -> GrantReport:
        """/keys grant with role:, one key by DM to each of them (bots left out), skipping the banned
        and those at the limit. Stops handing out once the keys run out."""
        report = GrantReport()
        for member in members:
            if getattr(member, "bot", False):
                continue
            if report.out_of_keys:
                report.out_of_keys += 1
                continue
            outcome = await self.hand_out(member, game, "manual")
            if outcome.status == "given":
                report.given += 1
            elif outcome.status == "already":
                report.at_limit += 1
            elif outcome.status == "banned":
                report.banned += 1
            elif outcome.status == "dm_failed":
                report.dm_failed += 1
            else:
                report.out_of_keys += 1
        log.info("role grant for %s: %d given, %d at limit, %d banned, %d DMs closed, %d out of keys",
                 game["name"], report.given, report.at_limit, report.banned, report.dm_failed, report.out_of_keys)
        return report

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
            return "Game not found", "Try /request again in Discord."
        if store.is_banned(user_id, game_id):
            return "Not available", "You can't get a key for this game."
        if store.at_limit(game_id, user_id):
            return "You already have a key", "Type /claim in Discord to see it."
        if store.open_request_for(user_id, game_id):
            return "Already sent", "We'll DM you soon."
        if store.open_request_count(user_id) >= MAX_OPEN_REQUESTS:
            return "Too many requests", "Wait for an answer on the others first."

        # A channel that already got this game's key in one of our emails: the same key, not a new one.
        emailed = store.claim_emailed(game_id, [f"{'yt' if c.platform == 'youtube' else 'tw'}:{c.id}" for c in channels],
                                      user_id)
        if emailed is not None:
            user = await self.user_by_id(user_id)
            try:
                await user.send(key_message(game, emailed.value))
            except discord.HTTPException:
                pass  # it's theirs now either way: /claim shows it
            log.info("creator %s verified a channel that got key #%s for %s by email", user_id, emailed.key_id, game["name"])
            return ("You already have a key", f"We emailed your channel a {game['name']} key. It's in your DMs now, "
                                              "and /claim in Discord shows it too.")

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
                return "Check your DMs", f"Your {game['name']} key is there."
            store.delete_request(request_id)
            if outcome.status == "already":
                return "You already have a key", "Type /claim in Discord to see it."
            if outcome.status == "banned":
                return "Not available", "You can't get a key for this game."
            if outcome.status == "dm_failed":
                return ("Turn on DMs",
                        "We couldn't message you. Allow DMs from the Four Games server, then try again.")
            # Out of keys: it qualifies, so let the team hand one out once there are more.
            details["reasons"] = ["Meets the thresholds, but there were no keys left"]

        request_id = store.create_request("creator", game_id, user_id, channel_url=channel_url, details=details)
        try:
            await self.post_request_card(request_id)
        except discord.HTTPException:
            store.delete_request(request_id)
            log.exception("couldn't post the card for request #%s", request_id)
            return "Something went wrong", "Try /request again later."
        log.info("creator request #%s sent for review", request_id)
        return "Sent for review", "We'll DM you soon."


def plural(count: int | None, word: str) -> str:
    count = count or 0
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def redeem_url(value: str) -> str:
    """Steam's activation page with the key filled in."""
    return f"{REDEEM_URL}?key={quote(value, safe='-')}"


def key_message(game: sqlite3.Row, value: str) -> str:
    """The DM: the key itself, or (after /claim) the receipt."""
    lines = [f"Here's your Steam key for **{escape_markdown(game['name'])}**:", f"`{value}`",
             f"[Redeem on Steam](<{redeem_url(value)}>) (or in Steam: Games → Activate a Product on Steam)"]
    if game["steam_app_id"]:
        lines.append(f"https://store.steampowered.com/app/{game['steam_app_id']}")
    lines.append("You can see your keys again any time with /claim.")
    return "\n".join(lines)


def claim_message(game: sqlite3.Row, value: str, dm_sent: bool) -> str:
    """The /claim reply (ephemeral: only they see it)."""
    lines = [f"Here's your Steam key for **{escape_markdown(game['name'])}**:", f"`{value}`",
             f"[Redeem on Steam](<{redeem_url(value)}>) (or in Steam: Games → Activate a Product on Steam)"]
    if dm_sent:
        lines.append("A copy is in your DMs, and /claim shows it again any time.")
    else:
        lines.append("I couldn't DM you a copy (your DMs are closed), but the key is yours: "
                     "/claim shows it again any time.")
    return "\n".join(lines)


def limit_text(limit: int) -> str:
    return "no limit per person" if not limit else f"{limit} per person"


def already_text(game: sqlite3.Row) -> str:
    name = escape_markdown(game["name"])
    limit = game["per_user_limit"]
    if limit == 1:
        return f"You've already had a key for **{name}**. /claim shows it again."
    return f"You've had {limit} keys for **{name}**, the most one person can get. /claim shows them again."


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
    # Only server members have roles (a discord.User from a DM doesn't).
    roles = getattr(user, "roles", None)
    if not roles:
        return False
    role = config.member_role
    if role.isdigit():
        return any(r.id == int(role) for r in roles)
    return any(r.name.casefold() == role.casefold() for r in roles)


def has_claim_role(user: discord.abc.User, game: sqlite3.Row, config: Config) -> bool:
    """Any one of the game's required roles, or the member role when it has none set."""
    required = role_ids(game)
    if not required:
        return is_member(user, config)
    return any(r.id in required for r in getattr(user, "roles", None) or [])


def member_role_text(config: Config, guild: discord.Guild | None) -> str:
    """MEMBER_ROLE as a mention when the role can be found, else its name."""
    role = config.member_role
    if role.isdigit():
        return f"<@&{role}>"
    found = discord.utils.find(lambda r: r.name.casefold() == role.casefold(), guild.roles) if guild else None
    return found.mention if found else f"**{escape_markdown(role)}**"


def roles_text(game: sqlite3.Row, config: Config, guild: discord.Guild | None) -> str:
    required = role_ids(game)
    if not required:
        return member_role_text(config, guild)
    return " or ".join(f"<@&{r}>" for r in required)


def claim_refusal(bot: "KeyBot", user: discord.abc.User, game: sqlite3.Row,
                  guild: discord.Guild | None = None) -> str | None:
    """Why they can't /claim this game (ban, private, roles), or None. Stock and the per-user limit
    are checked by the handout itself."""
    name = escape_markdown(game["name"])
    if bot.store.is_banned(user.id, game["id"]):
        return BANNED_TEXT.format(where=f" for **{name}**")
    if not game["public"]:
        return f"Keys for **{name}** aren't open for claiming; the team hands them out."
    if not has_claim_role(user, game, bot.config):
        if not role_ids(game):
            return not_member_text(bot.config)
        return f"Keys for **{name}** are for people with the {roles_text(game, bot.config, guild)} role."
    return None


def claim_menu_games(bot: "KeyBot", user: discord.abc.User) -> list[sqlite3.Row]:
    """What they could /claim now: public, in stock, under the limit, not banned, with the roles."""
    return [g for g in bot.store.claimable_games(user.id) if has_claim_role(user, g, bot.config)]


def fit(lines: list[str], limit: int = 2000) -> str:
    """As many lines as fit in one message, and how many were left out."""
    out: list[str] = []
    used = 0
    for index, line in enumerate(lines):
        last = index == len(lines) - 1
        # Room for the "…and N more" line, unless this is the last one.
        reserve = 0 if last else len(f"…and {len(lines) - index - 1} more") + 1
        if used + len(line) + reserve > limit:
            out.append(f"…and {len(lines) - index} more")
            break
        out.append(line)
        used += len(line) + 1
    return "\n".join(out)[:limit]


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


# Everyone: /claim


def not_member_text(config: Config) -> str:
    role = "member role" if config.member_role.isdigit() else f"**{config.member_role}** role"
    return ("Free keys are a perk for our YouTube channel members.\n"
            f"Join here: {MEMBERSHIP_URL}\n"
            "Then connect YouTube to Discord (User Settings → Connections) so you get the "
            f"{role}, and run /claim again.")


async def claimable_autocomplete(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    return choices(claim_menu_games(interaction.client, interaction.user), current)


@app_commands.command(name="claim", description="Get a Steam key for one of our games, or see the games and your keys")
@app_commands.describe(game="Which game (leave out to see the games and your keys)")
@app_commands.autocomplete(game=claimable_autocomplete)
@app_commands.guild_only()
async def claim(interaction: discord.Interaction, game: str | None = None) -> None:
    bot: KeyBot = interaction.client
    user = interaction.user
    if game is None:
        await show_overview(interaction)
        return
    if bot.store.is_banned(user.id):
        await interaction.response.send_message(BANNED_TEXT.format(where=""), ephemeral=True)
        return
    row = resolve_game(bot.store, game)
    if row is None:
        await interaction.response.send_message("I don't know that game. Pick one from the list.", ephemeral=True)
        return
    refusal = claim_refusal(bot, user, row, interaction.guild)
    if refusal:
        await interaction.response.send_message(refusal, ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    await claim_game(interaction, row)


def nothing_to_claim_text(bot: "KeyBot", user: discord.abc.User) -> str:
    public = [g for g in bot.store.games() if g["public"]]
    if public and not any(has_claim_role(user, g, bot.config) for g in public):
        # They have none of the roles any game asks for: tell them how to become a member.
        return not_member_text(bot.config)
    return "There's nothing new to claim right now."


def pool_line(game: sqlite3.Row, config: Config, guild: discord.Guild | None) -> str:
    """A public game in the /claim overview: keys per person, keys left, who can claim it."""
    return (f"**{escape_markdown(game['name'])}** · {limit_text(game['per_user_limit'])} · "
            f"{plural(game['available'], 'key')} left · for {roles_text(game, config, guild)}")


def own_key_lines(store: Store, user_id: int) -> list[str]:
    """Their keys with a Steam link that fills each one in."""
    keys = store.user_keys(user_id)
    lines = [f"**{escape_markdown(k['game'])}**: `{k['value']}` · [Redeem on Steam]({redeem_url(k['value'])})"
             for k in keys]
    if keys:
        lines.append("-# Or in Steam: Games → Activate a Product on Steam")
    return lines or ["You haven't been given any keys yet."]


def overview_lines(bot: "KeyBot", user: discord.abc.User, guild: discord.Guild | None,
                   menu: list[sqlite3.Row]) -> list[str]:
    """/claim without a game: the public games with keys left, their own keys, and what to do next."""
    games = [g for g in bot.store.games() if g["public"] and g["available"]]
    lines = ["**Games with keys to claim**"]
    lines += [pool_line(g, bot.config, guild) for g in games] or ["No games have keys to claim right now."]
    lines.append("**Your keys**")
    lines += own_key_lines(bot.store, user.id)
    if bot.store.is_banned(user.id):
        lines.append(BANNED_TEXT.format(where=""))
    elif menu:
        lines.append("Pick a game below to claim it (or run /claim game:…).")
    else:
        lines.append(nothing_to_claim_text(bot, user))
    return lines


async def show_overview(interaction: discord.Interaction) -> None:
    bot: KeyBot = interaction.client
    # claimable_games leaves out the banned, so a ban means no menu.
    menu = claim_menu_games(bot, interaction.user)
    pages = pool_pages(overview_lines(bot, interaction.user, interaction.guild, menu))
    view = OverviewView(pages, menu)
    # Ephemeral: only they see their keys, and it works with DMs closed too. No link previews.
    if view.children:
        await interaction.response.send_message(pages[0], view=view, ephemeral=True, suppress_embeds=True)
    else:
        await interaction.response.send_message(pages[0], ephemeral=True, suppress_embeds=True)


def pool_pages(lines: list[str], per_page: int = POOLS_PER_PAGE) -> list[str]:
    chunks = [lines[i:i + per_page] for i in range(0, len(lines), per_page)] or [[]]
    if len(chunks) == 1:
        return [fit(chunks[0])]
    return [fit(chunk + [f"Page {n} of {len(chunks)}"]) for n, chunk in enumerate(chunks, 1)]


class PagesView(discord.ui.View):
    def __init__(self, pages: list[str]):
        super().__init__(timeout=300)
        self.pages = pages
        self.page = 0
        self.update_buttons()

    def update_buttons(self) -> None:
        self.previous_page.disabled = self.page == 0
        self.next_page.disabled = self.page == len(self.pages) - 1

    async def turn(self, interaction: discord.Interaction, step: int) -> None:
        self.page = max(0, min(len(self.pages) - 1, self.page + step))
        self.update_buttons()
        await interaction.response.edit_message(content=self.pages[self.page], view=self)

    @discord.ui.button(label="Previous", style=discord.ButtonStyle.secondary)
    async def previous_page(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await self.turn(interaction, -1)

    @discord.ui.button(label="Next", style=discord.ButtonStyle.secondary)
    async def next_page(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await self.turn(interaction, 1)


class OverviewView(PagesView):
    """The /claim overview: page buttons when it's long, and a menu of the games they can claim."""

    def __init__(self, pages: list[str], games: list[sqlite3.Row]):
        super().__init__(pages)
        if len(pages) == 1:
            self.remove_item(self.previous_page)
            self.remove_item(self.next_page)
        if games:
            self.add_item(ClaimSelect(games))


async def claim_game(interaction: discord.Interaction, game: sqlite3.Row) -> None:
    """The claim itself. The interaction is already answered (deferred or edited), so this follows up.

    The key is shown in the (ephemeral) reply; the DM is only a copy, so closed DMs don't stop it.
    """
    bot: KeyBot = interaction.client
    name = escape_markdown(game["name"])
    outcome = await bot.hand_out(interaction.user, game, "member", dm_required=False)
    if outcome.status == "given":
        text = claim_message(game, outcome.value, outcome.dm_sent)
    elif outcome.status == "already":
        text = already_text(game)
    elif outcome.status == "banned":
        text = BANNED_TEXT.format(where=f" for **{name}**")
    else:
        text = f"Sorry, there are no keys left for **{name}** right now."
    try:
        await interaction.followup.send(text, ephemeral=True)
    except discord.HTTPException as error:
        if outcome.status != "given":
            raise
        # The key is theirs either way: /claim shows it (and the DM may have gone out).
        log.warning("couldn't show key #%s to %s in the reply (%s)", outcome.key_id, interaction.user.id,
                    type(error).__name__)


class ClaimSelect(discord.ui.Select):
    def __init__(self, games: list[sqlite3.Row]):
        super().__init__(placeholder="Choose a game to claim", options=[
            discord.SelectOption(label=g["name"][:100], value=str(g["id"])) for g in games[:25]
        ])

    async def callback(self, interaction: discord.Interaction) -> None:
        bot: KeyBot = interaction.client
        game = bot.store.game(int(self.values[0]))
        if game is None:
            await interaction.response.edit_message(content="That game is gone. Run /claim again.", view=None)
            return
        # Checked again: the menu can sit there a while.
        refusal = claim_refusal(bot, interaction.user, game, interaction.guild)
        if refusal:
            await interaction.response.edit_message(content=refusal, view=None)
            return
        await interaction.response.edit_message(
            content=f"Getting your key for **{escape_markdown(game['name'])}**…", view=None)
        await claim_game(interaction, game)


# Creators and press: /request


async def stocked_autocomplete(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    return choices([g for g in interaction.client.store.games() if g["available"]], current)


async def request_precheck(interaction: discord.Interaction, game_name: str) -> sqlite3.Row | None:
    """The checks creator and press requests share. The game, or None after answering."""
    bot: KeyBot = interaction.client
    store, user_id = bot.store, interaction.user.id
    game = resolve_game(store, game_name)
    if game is None:
        text = "I don't know that game. Pick one from the list."
    elif store.is_banned(user_id, game["id"]):
        text = BANNED_TEXT.format(where=f" for **{escape_markdown(game['name'])}**")
    elif store.at_limit(game["id"], user_id):
        text = already_text(game)
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


REQUEST_TYPES = [app_commands.Choice(name="creator", value="creator"), app_commands.Choice(name="press", value="press")]


@app_commands.command(name="request", description="Content creators and press: ask for a key for one of our games")
@app_commands.describe(game="Which game",
                       kind="creator: YouTube or Twitch, checked on the web; press: a short form, reviewed by the team")
@app_commands.rename(kind="type")
@app_commands.choices(kind=REQUEST_TYPES)
@app_commands.autocomplete(game=stocked_autocomplete)
@app_commands.guild_only()
async def request_key(interaction: discord.Interaction, game: str, kind: app_commands.Choice[str]) -> None:
    if kind.value == "press":
        await request_press(interaction, game)
    else:
        await request_creator(interaction, game)


async def request_creator(interaction: discord.Interaction, game: str) -> None:
    """/request type:creator: a one-time link to verify their channel on the web."""
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
        f"Press the button and sign in with Discord to show us your YouTube or Twitch channel. Bigger channels "
        f"get their **{escape_markdown(row['name'])}** key right away, and our team looks at the rest. Link your "
        "channel in Discord first (User Settings → Connections). Works for 15 minutes.\n"
        "Writing for a site or magazine? Use `/request type:press` instead.",
        view=view, ephemeral=True)


class PressForm(discord.ui.Modal):
    """The pop-up form /request type:press opens: outlet and work email, both required."""

    outlet = discord.ui.TextInput(label="Outlet", placeholder="The publication or site you write for",
                                  min_length=1, max_length=100)
    email = discord.ui.TextInput(label="Work email", placeholder="name@outlet.com, so we can reach you",
                                 min_length=3, max_length=254)

    def __init__(self, game_name: str):
        title = f"Press key: {game_name}"
        super().__init__(title=title if len(title) <= 45 else title[:44].rstrip() + "…")
        self.game_name = game_name

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await submit_press(interaction, self.game_name, self.outlet.value, self.email.value)


async def request_press(interaction: discord.Interaction, game: str) -> None:
    """/request type:press: checks first, then the form, so nobody fills it in for nothing."""
    row = await request_precheck(interaction, game)
    if row is None:
        return
    await interaction.response.send_modal(PressForm(row["name"]))


async def submit_press(interaction: discord.Interaction, game: str, outlet: str, email: str) -> None:
    """The press form was sent: always reviewed by the team."""
    bot: KeyBot = interaction.client
    outlet, email = outlet.strip(), email.strip()
    if not outlet:
        await interaction.response.send_message("Fill in your outlet, then try /request again.", ephemeral=True)
        return
    if not EMAIL_PATTERN.match(email):
        await interaction.response.send_message(
            f"`{escape_markdown(email)[:254]}` doesn't look like an email address. Run /request again.",
            ephemeral=True)
        return
    # Checked again: things may have changed while the form was open.
    row = await request_precheck(interaction, game)
    if row is None:
        return
    # Always reviewed by hand. Once the company mail exists, the email could be verified first.
    request_id = bot.store.create_request("press", row["id"], interaction.user.id,
                                          details={"outlet": outlet, "email": email})
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
                if outcome.status == "given":
                    note = f"key #{outcome.key_id}"
                else:
                    note = f"key #{outcome.key_id} (they were at the limit already)"
                await mark_card(interaction, f"Approved by {interaction.user.mention}, {note}")
                await interaction.followup.send(f"Done: {user.mention}, {name}: {note}.", ephemeral=True)
            elif outcome.status == "banned":
                await interaction.followup.send(
                    f"{user.mention} is banned from {name} (or from every game), so no key was sent. "
                    "Deny the request, or lift the ban with `/keys ban action:unban` and press Approve again.",
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
#
# Six subcommands: status, add, grant, find, ban, game.

# Discord shows /keys only to people with Manage Server (the server's Integrations settings can let
# a team role see it too); every command still checks require_admin, so ADMIN_ROLE_ID keeps working.
keys_group = app_commands.Group(name="keys", description="Manage game keys (Four Games team)", guild_only=True,
                                default_permissions=discord.Permissions(manage_guild=True))


async def all_games_autocomplete(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    return choices(interaction.client.store.games(), current)


async def reply(interaction: discord.Interaction, text: str, **kwargs) -> None:
    await interaction.response.send_message(text, ephemeral=True, **kwargs)


def where_text(game: sqlite3.Row | None) -> str:
    return f"**{escape_markdown(game['name'])}**" if game else "every game"


async def optional_game(interaction: discord.Interaction, name: str | None) -> tuple[bool, sqlite3.Row | None]:
    """(ok, the game or None for every game). Answers when the name is unknown."""
    if name is None:
        return True, None
    row = resolve_game(interaction.client.store, name)
    if row is None:
        await reply(interaction, "I don't know that game.")
        return False, None
    return True, row


# /keys status: every game (or one), then the latest handouts


def status_line(row: sqlite3.Row) -> str:
    app = f"Steam app {row['steam_app_id']}" if row["steam_app_id"] else "no Steam app id"
    given = ", ".join(f"{row[r]} {r}" for r in ("member", "creator", "press", "manual") if row[r])
    given = f"given {given}" if given else "none given yet"
    waiting = f" · **{plural(row['open_requests'], 'open request')}**" if row["open_requests"] else ""
    return (f"**{escape_markdown(row['name'])}**: {row['available'] or 0} left · {given}{waiting} · "
            f"{'public' if row['public'] else 'private'}, {limit_text(row['per_user_limit'])} · {app}")


def holder_text(given_to: str) -> str:
    """A Discord mention, or the channel or outlet an outreach email gave the key to (yt:, tw:, press:)."""
    given_to = str(given_to or "")
    if given_to.isdigit():
        return f"<@{given_to}>"
    kind, _, ident = given_to.partition(":")
    return {"yt": f"YouTube channel {ident} (by email)", "tw": f"Twitch user {ident} (by email)",
            "press": f"press {ident} (by email)"}.get(kind, escape_markdown(given_to))


def handout_line(row: sqlite3.Row) -> str:
    """One handout, with the key's id (never the key)."""
    when = discord.utils.format_dt(discord.utils.parse_time(row["given_at"]), "R")
    extra = f", request #{row['request_id']}" if row["request_id"] else ""
    return (f"{when} **{escape_markdown(row['game'])}** → {holder_text(row['given_to'])} ({row['reason']}{extra}), "
            f"key #{row['id']}")


@keys_group.command(name="status", description="Keys left and given out per game, then the latest handouts")
@app_commands.describe(game="Only this game (leave out for every game)",
                       count="How many of the latest handouts (default 10)")
@app_commands.autocomplete(game=all_games_autocomplete)
async def keys_status(interaction: discord.Interaction, game: str | None = None,
                      count: app_commands.Range[int, 1, 25] = 10) -> None:
    if not await require_admin(interaction):
        return
    ok, row = await optional_game(interaction, game)
    if not ok:
        return
    store: Store = interaction.client.store
    rows = [r for r in store.status_summary() if row is None or r["id"] == row["id"]]
    if not rows:
        await reply(interaction, "No games yet. Add one with its first keys: `/keys add file: name:…`.")
        return
    handouts = store.recent_handouts(count, row["id"] if row else None)
    lines = [status_line(r) for r in rows]
    lines.append("**Latest handouts** (key ids only)")
    lines += [handout_line(h) for h in handouts] or ["No keys given out yet."]
    await reply(interaction, fit(lines))


# /keys add: keys for a game, or a new game with its keys


@keys_group.command(name="add", description="Add keys from a .txt or .csv file, to a game or to a new one")
@app_commands.describe(file="The key file (one per line, or a Steamworks export)",
                       game="A game the bot has",
                       steam_app_id="Its Steam app id (for a new game, or to set it)",
                       name="A new game to add with these keys (instead of game:)")
@app_commands.autocomplete(game=all_games_autocomplete)
async def keys_add(interaction: discord.Interaction, file: discord.Attachment, game: str | None = None,
                   steam_app_id: app_commands.Range[int, 1] | None = None,
                   name: app_commands.Range[str, 1, 100] | None = None) -> None:
    if not await require_admin(interaction):
        return
    bot: KeyBot = interaction.client
    name = name.strip() if name else None
    if (game is None) == (not name):
        await reply(interaction, "Give either `game:` (a game the bot has) or `name:` (a new game to add).")
        return
    row = None
    if game is not None:
        row = resolve_game(bot.store, game)
        if row is None:
            await reply(interaction, "I don't know that game. To add a new one, use `name:` instead of `game:`.")
            return
    if not file.filename.lower().endswith((".txt", ".csv")):
        await reply(interaction, "Send a .txt or .csv file.")
        return
    if file.size > MAX_KEY_FILE_BYTES:
        await reply(interaction, "That file is too big (1 MB at most).")
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    try:
        values, repeats = read_keys(text)
    except KeyFileError as error:
        # Nothing changed: a new game is only added once its file reads.
        await interaction.followup.send(f"Couldn't read the file: {error}.", ephemeral=True)
        return
    head = ""
    if row is None or steam_app_id is not None:
        row, created = bot.store.add_game(name or row["name"], steam_app_id)
        app = f" (Steam app {row['steam_app_id']})" if row["steam_app_id"] else ""
        if created:
            head = f"Added the game **{escape_markdown(row['name'])}**{app}.\n"
            log.info("%s added the game %s", interaction.user.id, row["name"])
        elif steam_app_id is not None:
            head = f"Set the Steam app id of **{escape_markdown(row['name'])}**{app}.\n"
    added, known = bot.store.add_keys(row["id"], values, added_by=str(interaction.user.id))
    log.info("%s added %d key(s) to %s (%d known, %d repeated in the file)", interaction.user.id, added,
             row["name"], known, repeats)
    await interaction.followup.send(
        f"{head}Added **{plural(added, 'key')}** to **{escape_markdown(row['name'])}**.\n"
        f"Skipped {known} already in the database and {repeats} repeated in the file.\n"
        f"Available now: {bot.store.available_count(row['id'])}.", ephemeral=True)


# /keys game: a game's settings, and its unclaimed keys


def settings_text(game: sqlite3.Row, config: Config, guild: discord.Guild | None) -> str:
    who = roles_text(game, config, guild) + ("" if role_ids(game) else " (the member role)")
    visibility = "public (members can /claim it)" if game["public"] else "private (only the team hands it out)"
    return (f"**{escape_markdown(game['name'])}**\n"
            f"Visibility: {visibility}\n"
            f"Per person: {limit_text(game['per_user_limit'])}\n"
            f"Who can /claim it: {who}\n"
            f"Steam app id: {game['steam_app_id'] or 'not set'}")


def export_filename(game: sqlite3.Row) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", game["name"].lower()).strip("-") or f"game-{game['id']}"
    return f"{slug}-unclaimed-keys.txt"


@keys_group.command(name="game",
                    description="See or change a game's settings, or download its unclaimed keys (only you see it)")
@app_commands.describe(game="Which game",
                       public="Public: members can /claim it. Private: only the team hands it out",
                       per_user_limit=f"Keys one person can have, every reason counted (0 = no limit, at most "
                                      f"{MAX_PER_USER_LIMIT})",
                       add_role="A role that may /claim it (any one of the listed roles is enough)",
                       remove_role="Take a role off the list",
                       clear_roles="Empty the list, so the member role (MEMBER_ROLE) decides again",
                       steam_app_id="Its Steam app id (the DMs link its store page)",
                       export="Send its unclaimed keys as a .txt file, only to you (they stay in the bot)")
@app_commands.autocomplete(game=all_games_autocomplete)
async def keys_game(interaction: discord.Interaction, game: str, public: bool | None = None,
                    per_user_limit: app_commands.Range[int, 0, MAX_PER_USER_LIMIT] | None = None,
                    add_role: discord.Role | None = None, remove_role: discord.Role | None = None,
                    clear_roles: bool = False, steam_app_id: app_commands.Range[int, 1] | None = None,
                    export: bool = False) -> None:
    if not await require_admin(interaction):
        return
    bot: KeyBot = interaction.client
    store = bot.store
    row = resolve_game(store, game)
    if row is None:
        await reply(interaction, "I don't know that game.")
        return
    roles = None
    if clear_roles or add_role or remove_role:
        roles = [] if clear_roles else role_ids(row)
        if add_role and add_role.id not in roles:
            roles.append(add_role.id)
        if remove_role:
            roles = [r for r in roles if r != remove_role.id]
    changed = public is not None or per_user_limit is not None or roles is not None or steam_app_id is not None
    if changed:
        row = store.update_game_settings(row["id"], public=public, per_user_limit=per_user_limit,
                                         required_role_ids=roles, steam_app_id=steam_app_id)
        log.info("%s changed the settings of %s", interaction.user.id, row["name"])
    text = ("Updated. " if changed else "") + settings_text(row, bot.config, interaction.guild)
    if not export:
        await reply(interaction, text)
        return
    # With export and no changes, only the file and its line, nothing else.
    prefix = text + "\n\n" if changed else ""
    name = escape_markdown(row["name"])
    values = store.unclaimed_keys(row["id"])
    if not values:
        await reply(interaction, f"{prefix}**{name}** has no unclaimed keys.")
        return
    log.info("%s exported %d unclaimed key(s) of %s", interaction.user.id, len(values), row["name"])
    data = io.BytesIO(("\n".join(values) + "\n").encode())
    await reply(interaction, f"{prefix}{plural(len(values), 'unclaimed key')} for **{name}**. They stay in the bot; "
                             "delete the file once you're done with it.",
                file=discord.File(data, filename=export_filename(row)))


# /keys grant: one person, or everyone with a role


def grant_text(outcome: Outcome, user: discord.abc.User, game: sqlite3.Row) -> str:
    name = escape_markdown(game["name"])
    if outcome.status == "given":
        return f"Sent: {user.mention} has key #{outcome.key_id} for **{name}** by DM."
    if outcome.status == "already":
        return (f"{user.mention} already has {limit_text(game['per_user_limit'])} for **{name}** "
                "(the per-user limit), so no key was sent. Raise it with `/keys game per_user_limit:` if needed.")
    if outcome.status == "banned":
        return f"{user.mention} is banned from **{name}** (or from every game), so no key was sent."
    if outcome.status == "dm_failed":
        return f"Couldn't DM {user.mention} (their DMs are closed), so no key was used."
    return f"No keys left for **{name}**. Add some with `/keys add`."


GRANTROLE_OFF_TEXT = ("Granting to a role is turned off: it needs Discord's Server Members intent and "
                      "`GRANTROLE_ENABLED=1` in the bot's settings (see its README). Use `user:` for one person.")


@keys_group.command(name="grant", description="Send one key by DM to someone, or to everyone with a role")
@app_commands.describe(game="Which game", user="Who gets it",
                       role="Everyone with this role, after a confirmation (turned off for now)")
@app_commands.autocomplete(game=all_games_autocomplete)
async def keys_grant(interaction: discord.Interaction, game: str, user: discord.User | None = None,
                     role: discord.Role | None = None) -> None:
    if not await require_admin(interaction):
        return
    bot: KeyBot = interaction.client
    if (user is None) == (role is None):
        await reply(interaction, "Give either `user:` (one person) or `role:` (everyone with it).")
        return
    if role is not None and not bot.config.grantrole_enabled:
        await reply(interaction, GRANTROLE_OFF_TEXT)
        return
    row = resolve_game(bot.store, game)
    if row is None:
        await reply(interaction, "I don't know that game.")
        return
    if role is not None:
        await grant_role_prompt(interaction, role, row)
        return
    if user.bot:
        await reply(interaction, "Bots can't redeem keys.")
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    outcome = await bot.hand_out(user, row, "manual")
    log.info("%s granted %s a key for %s: %s", interaction.user.id, user.id, row["name"], outcome.status)
    await interaction.followup.send(grant_text(outcome, user, row), ephemeral=True)


async def role_members(guild: discord.Guild, role_id: int) -> list[discord.Member]:
    """Everyone with the role, from the member cache (complete with the Server Members intent)."""
    if not guild.chunked:
        await guild.chunk()
    role = guild.get_role(role_id)
    return [m for m in role.members if not m.bot] if role else []


class GrantRoleView(discord.ui.View):
    def __init__(self, role_id: int, game_id: int, admin_id: int):
        super().__init__(timeout=180)
        self.role_id, self.game_id, self.admin_id = role_id, game_id, admin_id
        self.used = False

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.admin_id

    @discord.ui.button(label="Send the keys", style=discord.ButtonStyle.success)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        bot: KeyBot = interaction.client
        if self.used or not await require_admin(interaction):
            return
        self.used = True
        self.stop()
        game = bot.store.game(self.game_id)
        if game is None or interaction.guild is None:
            await interaction.response.edit_message(content="That game is gone.", view=None)
            return
        await interaction.response.edit_message(content="Sending keys…", view=None)
        members = await role_members(interaction.guild, self.role_id)
        report = await bot.grant_to_members(members, game)
        text = f"<@&{self.role_id}>, **{escape_markdown(game['name'])}**: {report.summary()}"
        try:
            await interaction.followup.send(text, ephemeral=True)
        except discord.HTTPException:
            # A big role can take longer than the reply stays open: the admin channel gets it instead.
            try:
                await (await bot.admin_channel()).send(f"/keys grant role: by {interaction.user.mention}: {text}")
            except discord.HTTPException:
                log.exception("couldn't report the role grant result")

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        self.used = True
        self.stop()
        await interaction.response.edit_message(content="Cancelled; nothing was sent.", view=None)


def grantrole_prompt(members: list[discord.abc.User], store: Store, game: sqlite3.Row, role_mention: str) -> str:
    """The confirmation: members with the role against the keys in stock."""
    eligible = sum(1 for m in members
                   if not store.is_banned(m.id, game["id"]) and not store.at_limit(game["id"], m.id))
    stock = store.available_count(game["id"])
    name = escape_markdown(game["name"])
    lines = [f"Send one **{name}** key by DM to everyone with {role_mention}?",
             f"{len(members)} member(s) with the role, {eligible} of them can get one "
             f"(the others are banned or at the limit). {plural(stock, 'key')} in stock."]
    if eligible > stock:
        lines.append(f"Not enough keys for everyone: it stops after {stock}.")
    return "\n".join(lines)


async def grant_role_prompt(interaction: discord.Interaction, role: discord.Role, game: sqlite3.Row) -> None:
    """/keys grant role: the confirmation with its Send / Cancel buttons (GRANTROLE_ENABLED only)."""
    bot: KeyBot = interaction.client
    await interaction.response.defer(ephemeral=True, thinking=True)
    members = await role_members(interaction.guild, role.id)
    if not members:
        await interaction.followup.send(f"Nobody (but bots) has {role.mention}.", ephemeral=True)
        return
    await interaction.followup.send(grantrole_prompt(members, bot.store, game, role.mention),
                                    view=GrantRoleView(role.id, game["id"], interaction.user.id), ephemeral=True)


# /keys ban: ban, unban, list

BAN_ACTIONS = [app_commands.Choice(name=name, value=name) for name in ("ban", "unban", "list")]


@keys_group.command(name="ban", description="Ban or unban someone (one game or every game), or list the bans")
@app_commands.describe(action="ban: no more keys for them; unban: lift a ban; list: who's banned",
                       user="Who (for ban and unban)",
                       game="Only this game (leave out for every game); with list, the bans that apply to it")
@app_commands.choices(action=BAN_ACTIONS)
@app_commands.autocomplete(game=all_games_autocomplete)
async def keys_ban(interaction: discord.Interaction, action: app_commands.Choice[str],
                   user: discord.User | None = None, game: str | None = None) -> None:
    if not await require_admin(interaction):
        return
    if action.value == "list":
        if user is not None:
            await reply(interaction, "`action:list` lists every ban (or a game's, with `game:`). "
                                     "`/keys find user:` shows one person's bans.")
            return
    elif user is None:
        await reply(interaction, f"Give `user:`: who to {action.value}.")
        return
    ok, row = await optional_game(interaction, game)
    if not ok:
        return
    if action.value == "ban":
        await ban_user(interaction, user, row)
    elif action.value == "unban":
        await unban_user(interaction, user, row)
    else:
        await list_bans(interaction, row)


async def ban_user(interaction: discord.Interaction, user: discord.abc.User, row: sqlite3.Row | None) -> None:
    store: Store = interaction.client.store
    new = store.ban(user.id, row["id"] if row else None, by=str(interaction.user.id))
    log.info("%s banned %s from %s", interaction.user.id, user.id, row["name"] if row else "every game")
    text = f"{user.mention} is banned from {where_text(row)}" + ("." if new else " (already was).")
    await reply(interaction, text + " Keys they already have stay theirs.")


async def unban_user(interaction: discord.Interaction, user: discord.abc.User, row: sqlite3.Row | None) -> None:
    store: Store = interaction.client.store
    lifted = store.unban(user.id, row["id"] if row else None)
    log.info("%s unbanned %s from %s (%s)", interaction.user.id, user.id, row["name"] if row else "every game",
             lifted)
    text = (f"Lifted {user.mention}'s ban from {where_text(row)}." if lifted
            else f"{user.mention} had no ban for {where_text(row)}.")
    if store.user_bans(user.id):
        text += " They still have another ban: `/keys find user:` shows it."
    await reply(interaction, text)


async def list_bans(interaction: discord.Interaction, row: sqlite3.Row | None) -> None:
    """Every ban, or those that apply to the game (its own and the every-game ones)."""
    bans = interaction.client.store.bans(row["id"] if row else None)
    if not bans:
        await reply(interaction, "No bans.")
        return
    lines = [f"<@{b['user_id']}> · {escape_markdown(b['game']) if b['game'] else 'every game'} · "
             f"{discord.utils.format_dt(discord.utils.parse_time(b['created_at']), 'd')}" for b in bans]
    await reply(interaction, fit(lines))


# /keys find: someone's keys, or who has a key


def lookup_user_lines(store: Store, user_id: int) -> list[str]:
    """Everything handed to them, with the key values (only ever shown ephemerally to an admin)."""
    lines = []
    for k in store.user_keys(user_id):
        when = discord.utils.format_dt(discord.utils.parse_time(k["given_at"]), "d")
        extra = f", request #{k['request_id']}" if k["request_id"] else ""
        lines.append(f"**{escape_markdown(k['game'])}**: key #{k['id']} `{k['value']}` ({k['reason']}{extra}, {when})")
    for b in store.user_bans(user_id):
        lines.append(f"Banned from {escape_markdown(b['game']) if b['game'] else 'every game'}")
    return lines


def lookup_key_text(key: sqlite3.Row) -> str:
    head = f"Key #{key['id']} `{key['value']}` for **{escape_markdown(key['game'])}**"
    if key["status"] == "available":
        return f"{head}: not given out yet."
    when = discord.utils.format_dt(discord.utils.parse_time(key["given_at"]), "f")
    extra = f", request #{key['request_id']}" if key["request_id"] else ""
    return f"{head}: given to {holder_text(key['given_to'])} ({key['given_to']}), {key['reason']}{extra}, {when}."


@keys_group.command(name="find", description="Every key someone got, or who has a key")
@app_commands.describe(user="Whose keys", key="A key (or #id): who has it")
async def keys_find(interaction: discord.Interaction, user: discord.User | None = None,
                    key: app_commands.Range[str, 1, 100] | None = None) -> None:
    if not await require_admin(interaction):
        return
    store: Store = interaction.client.store
    if (user is None) == (key is None):
        await reply(interaction, "Give either `user:` or `key:`.")
        return
    if user is not None:
        lines = lookup_user_lines(store, user.id)
        text = fit([f"{user.mention} ({user.id}):"] + lines) if lines else f"{user.mention} has no keys from us."
        await reply(interaction, text)
        return
    row = store.key_by_value(key)
    match = re.fullmatch(r"#?(\d{1,18})", key.strip())
    if row is None and match:
        row = store.key_by_id(int(match[1]))
    await reply(interaction, lookup_key_text(row) if row else "No such key here.")
