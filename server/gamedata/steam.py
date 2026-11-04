"""Talking to Steam: the games' auth tickets and ownership (partner Web API, publisher key) and
the privacy page's sign-in (Steam OpenID 2.0).

Nothing here logs a steamid, a ticket or Steam's answers.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import aiohttp

from .signing import valid_steamid

# Publisher keys go to the partner host (api.steampowered.com takes them too, but Valve asks for this).
PARTNER_API = "https://partner.steam-api.com"
OPENID_LOGIN = "https://steamcommunity.com/openid/login"
OPENID_NS = "http://specs.openid.net/auth/2.0"
IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select"
CLAIMED_ID = re.compile(r"^https://steamcommunity\.com/openid/id/(\d{17})$")
# The identity the game asks its ticket for: Steam.getAuthTicketForWebApi("fourgames-gamedata").
IDENTITY = "fourgames-gamedata"
# What Steam must have signed in its answer, or a field could be swapped without breaking it.
MUST_BE_SIGNED = {"op_endpoint", "claimed_id", "identity", "return_to", "response_nonce"}
# How old Steam's answer (its response_nonce) may be when it reaches us.
MAX_NONCE_AGE = 10 * 60


class SteamError(Exception):
    """Steam couldn't be asked (down, slow, an odd answer): try again later."""


class TicketRejected(Exception):
    """Steam says the ticket isn't good (expired, for another app or identity, made up)."""


class SignInFailed(Exception):
    """The OpenID answer isn't a valid Steam sign-in. str(error) is a short reason for the log."""


class Steam:
    def __init__(self, session: aiohttp.ClientSession, publisher_key: str,
                 api_base: str = PARTNER_API, openid_login: str = OPENID_LOGIN):
        self.session = session
        self.key = publisher_key
        self.api_base = api_base.rstrip("/")
        # Where check_authentication is posted. Tests point it at a fake; the sign-in itself must
        # still name the real Steam endpoint (op_endpoint).
        self.openid_login = openid_login
        self.timeout = aiohttp.ClientTimeout(total=10)

    async def _get(self, path: str, params: dict[str, str]) -> dict:
        try:
            async with self.session.get(f"{self.api_base}{path}", params={"key": self.key, **params},
                                        timeout=self.timeout) as response:
                if response.status in (401, 403):
                    raise SteamError(f"the publisher key was refused (HTTP {response.status})")
                if response.status >= 500 or response.status == 429:
                    raise SteamError(f"HTTP {response.status}")
                if response.status >= 400:
                    # Steam answers a bad ticket with 400 or an error object, depending on the day.
                    raise TicketRejected(f"HTTP {response.status}")
                data = await response.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError, ValueError) as error:
            raise SteamError(type(error).__name__) from None
        if not isinstance(data, dict):
            raise SteamError("not a JSON object")
        return data

    async def authenticate_ticket(self, app_id: int, ticket: str) -> tuple[str, str | None]:
        """ISteamUserAuth/AuthenticateUserTicket: (steamid, ownersteamid) of the ticket's player."""
        data = await self._get("/ISteamUserAuth/AuthenticateUserTicket/v1/",
                               {"appid": str(app_id), "ticket": ticket, "identity": IDENTITY})
        response = data.get("response")
        if not isinstance(response, dict):
            raise SteamError("no response object")
        if "error" in response:
            raise TicketRejected("Steam refused the ticket")
        params = response.get("params")
        if not isinstance(params, dict) or params.get("result") != "OK":
            raise TicketRejected("Steam didn't say OK")
        steamid = valid_steamid(params.get("steamid"))
        if steamid is None:
            raise TicketRejected("no steamid in Steam's answer")
        return steamid, valid_steamid(params.get("ownersteamid"))

    async def owns_app(self, steamid: str, app_id: int) -> bool:
        """ISteamUser/CheckAppOwnership: whether the player has the game (bought, or lent to them by
        Steam Family Sharing)."""
        data = await self._get("/ISteamUser/CheckAppOwnership/v2/", {"steamid": steamid, "appid": str(app_id)})
        ownership = data.get("appownership")
        if not isinstance(ownership, dict):
            raise SteamError("no appownership object")
        return ownership.get("ownsapp") is True

    async def player_for_ticket(self, app_id: int, ticket: str) -> tuple[str, bool]:
        """(steamid, owns the game). The ticket proves who it is; a ticket made by the player's own
        copy (ownersteamid == steamid) proves ownership too, so CheckAppOwnership is only asked
        about the rest (Family Sharing, or an answer without ownersteamid)."""
        steamid, owner = await self.authenticate_ticket(app_id, ticket)
        if owner == steamid:
            return steamid, True
        return steamid, await self.owns_app(steamid, app_id)

    # Sign-in (OpenID 2.0)

    @staticmethod
    def login_url(return_to: str, realm: str) -> str:
        return OPENID_LOGIN + "?" + urlencode({
            "openid.ns": OPENID_NS,
            "openid.mode": "checkid_setup",
            "openid.return_to": return_to,
            "openid.realm": realm,
            "openid.identity": IDENTIFIER_SELECT,
            "openid.claimed_id": IDENTIFIER_SELECT,
        })

    async def verify_sign_in(self, params: dict[str, str], return_to: str,
                             now: float | None = None) -> str:
        """The steamid of a Steam OpenID answer (the callback's query), after checking every field
        and asking Steam itself (check_authentication) that it really sent it. SignInFailed if not;
        SteamError if Steam couldn't be asked."""
        now = time.time() if now is None else now
        if params.get("openid.mode") != "id_res":
            raise SignInFailed("not a positive assertion")
        if params.get("openid.ns") != OPENID_NS:
            raise SignInFailed("wrong openid.ns")
        if params.get("openid.op_endpoint") != OPENID_LOGIN:
            raise SignInFailed("not from Steam's endpoint")
        claimed = params.get("openid.claimed_id", "")
        match = CLAIMED_ID.match(claimed)
        steamid = valid_steamid(match.group(1)) if match else None
        if steamid is None:
            raise SignInFailed("claimed_id isn't a Steam account")
        if params.get("openid.identity") != claimed:
            raise SignInFailed("identity and claimed_id differ")
        if params.get("openid.return_to") != return_to:
            raise SignInFailed("return_to isn't ours")
        signed = set(params.get("openid.signed", "").split(","))
        if not MUST_BE_SIGNED <= signed:
            raise SignInFailed("Steam didn't sign every field")
        if not fresh_nonce(params.get("openid.response_nonce", ""), now):
            raise SignInFailed("the answer is too old")

        form = {k: v for k, v in params.items() if k.startswith("openid.")}
        form["openid.mode"] = "check_authentication"
        try:
            async with self.session.post(self.openid_login, data=form, timeout=self.timeout) as response:
                if response.status != 200:
                    raise SteamError(f"HTTP {response.status} from check_authentication")
                body = await response.text()
        except (aiohttp.ClientError, TimeoutError, UnicodeDecodeError) as error:
            raise SteamError(type(error).__name__) from None
        # Key-value form: "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n".
        lines = {line.partition(":")[0].strip(): line.partition(":")[2].strip() for line in body.splitlines()}
        if lines.get("is_valid") != "true":
            raise SignInFailed("Steam says the answer isn't valid")
        return steamid


def fresh_nonce(nonce: str, now: float) -> bool:
    """OpenID response nonces start with the time they were made: 2026-11-04T21:06:00Z…"""
    try:
        made = datetime.strptime(nonce[:20], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return False
    return -MAX_NONCE_AGE <= now - made <= MAX_NONCE_AGE
