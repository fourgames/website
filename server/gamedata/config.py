"""Settings, all from the environment (/etc/fourgames/gamedata.env on the server)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping
from urllib.parse import urlsplit

from .signing import valid_steamid


class ConfigError(Exception):
    pass


# The secrets are HMAC keys; short ones could be guessed.
MIN_SECRET = 32


# repr=False on the secrets: printing or logging a Config never shows them.
@dataclass(frozen=True, kw_only=True)
class Config:
    # pid = HMAC-SHA256(pepper, "steam:" + steamid64)[:32]. Changing it loses every player's data
    # (their pids change), so it's set once and never again.
    pepper: str = field(repr=False)
    # Signs the privacy page's cookie and the Steam sign-in's state.
    cookie_secret: str = field(repr=False)
    # Local tools send it as X-Internal-Key on the internal endpoints (localhost only).
    internal_key: str = field(repr=False)
    # Signs the games' session tokens.
    token_secret: str = field(repr=False)
    # The Steamworks publisher Web API key (AuthenticateUserTicket, CheckAppOwnership).
    steam_publisher_key: str = field(repr=False)
    # The games that may send data. Empty (the default): none, until their app ids are added.
    app_ids: frozenset[int]
    # Test mode: apps whose sessions are only taken from the test_steamids accounts, every one of
    # them marked test (kept and downloadable like the rest, left out of the internal lookup).
    test_app_ids: frozenset[int] = frozenset()
    # The steamid64s allowed to send test sessions. They're ours, but still never shown in a repr.
    test_steamids: frozenset[str] = field(default=frozenset(), repr=False)
    # Demo app id -> its full game's app id (GAMEDATA_DEMO_OF), for "played the demo, owns the game".
    demo_of: dict[int, int]
    data_dir: str
    # DB-IP's city database (MMDB) for the country and region at session start. Missing: both null.
    geoip_db: str
    # Where the API is reached from outside, without a trailing slash, e.g.
    # https://api.fourgames.se/gamedata (the routes add /v1/...).
    public_base_url: str
    # The privacy page's site: the only origin that may call the player endpoints.
    site_origin: str
    privacy_url: str
    # A player's data stays linked to their pid until this many months after their last session;
    # then it's anonymised (never deleted).
    link_months: int
    # What the game is told at session start.
    upload_every_s: int
    max_batch_kb: int
    # Per player: at most this many MB of gzipped events a day (a runaway game can't fill the disk).
    max_mb_per_day: int
    # Events and crashes are refused (503) while the disk has less than this free.
    min_free_mb: int
    host: str
    port: int

    @property
    def callback_url(self) -> str:
        return f"{self.public_base_url}/v1/auth/callback"

    @property
    def cookie_domain(self) -> str:
        return urlsplit(self.public_base_url).hostname or ""

    @property
    def realm(self) -> str:
        """The OpenID realm: the API's origin (Steam's sign-in page shows it)."""
        parts = urlsplit(self.public_base_url)
        return f"{parts.scheme}://{parts.netloc}"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env

        def get(name: str, default: str = "") -> str:
            # A blank line in the env file (NAME=) means the default too.
            return env.get(name, "").strip() or default

        def integer(name: str, default: str, low: int = 1) -> int:
            value = get(name, default)
            try:
                number = int(value)
            except ValueError:
                raise ConfigError(f"{name} must be a whole number, not {value!r}") from None
            if number < low:
                raise ConfigError(f"{name} must be at least {low}")
            return number

        secrets = {
            "GAMEDATA_PEPPER": get("GAMEDATA_PEPPER"),
            "GAMEDATA_COOKIE_SECRET": get("GAMEDATA_COOKIE_SECRET"),
            "GAMEDATA_INTERNAL_KEY": get("GAMEDATA_INTERNAL_KEY"),
            "GAMEDATA_TOKEN_SECRET": get("GAMEDATA_TOKEN_SECRET"),
        }
        missing = [name for name, value in secrets.items() if not value]
        if not get("STEAM_PUBLISHER_KEY"):
            missing.append("STEAM_PUBLISHER_KEY")
        if missing:
            raise ConfigError("missing settings: " + ", ".join(missing))
        short = [name for name, value in secrets.items() if len(value) < MIN_SECRET]
        if short:
            raise ConfigError(", ".join(short) + f" must be at least {MIN_SECRET} characters (openssl rand -hex 32)")
        if len(set(secrets.values())) < len(secrets):
            raise ConfigError("the GAMEDATA_ secrets must all be different")

        raw_ids = get("GAMEDATA_APP_IDS")
        try:
            app_ids = frozenset(int(part) for part in raw_ids.split(",") if part.strip())
        except ValueError:
            raise ConfigError(f"GAMEDATA_APP_IDS must be Steam app ids separated by commas, not {raw_ids!r}") from None
        if app_ids and min(app_ids) <= 0:
            raise ConfigError("GAMEDATA_APP_IDS must be Steam app ids (positive numbers)")

        raw_test_ids = get("GAMEDATA_TEST_APP_IDS")
        try:
            test_app_ids = frozenset(int(part) for part in raw_test_ids.split(",") if part.strip())
        except ValueError:
            raise ConfigError(f"GAMEDATA_TEST_APP_IDS must be Steam app ids separated by commas, not {raw_test_ids!r}") from None
        if test_app_ids and min(test_app_ids) <= 0:
            raise ConfigError("GAMEDATA_TEST_APP_IDS must be Steam app ids (positive numbers)")
        test_steamids: set[str] = set()
        for part in (p.strip() for p in get("GAMEDATA_TEST_STEAMIDS").split(",") if p.strip()):
            steamid = valid_steamid(part)
            if steamid is None:
                raise ConfigError("GAMEDATA_TEST_STEAMIDS must be SteamID64s (17 digits) separated by commas")
            test_steamids.add(steamid)

        raw_demos = get("GAMEDATA_DEMO_OF")
        demo_of: dict[int, int] = {}
        for pair in (p.strip() for p in raw_demos.split(",") if p.strip()):
            demo, _, game = pair.partition(":")
            try:
                demo_id, game_id = int(demo), int(game)
            except ValueError:
                raise ConfigError(f"GAMEDATA_DEMO_OF must be demo_app_id:game_app_id pairs, not {pair!r}") from None
            if demo_id <= 0 or game_id <= 0 or demo_id == game_id:
                raise ConfigError(f"GAMEDATA_DEMO_OF: {pair!r} isn't a demo and a different game")
            demo_of[demo_id] = game_id

        public_base_url = get("PUBLIC_BASE_URL", "https://api.fourgames.se/gamedata").rstrip("/")
        site_origin = get("SITE_ORIGIN", "https://fourgames.se").rstrip("/")
        for name, url in (("PUBLIC_BASE_URL", public_base_url), ("SITE_ORIGIN", site_origin)):
            parts = urlsplit(url)
            if parts.scheme not in ("https", "http") or not parts.hostname:
                raise ConfigError(f"{name} must be a full URL like https://…, not {url!r}")
        if urlsplit(site_origin).path:
            raise ConfigError("SITE_ORIGIN is an origin, without a path (https://fourgames.se)")

        data_dir = get("DATA_DIR", "/srv/fourgames/gamedata").rstrip("/") or "/"
        return cls(
            pepper=secrets["GAMEDATA_PEPPER"],
            cookie_secret=secrets["GAMEDATA_COOKIE_SECRET"],
            internal_key=secrets["GAMEDATA_INTERNAL_KEY"],
            token_secret=secrets["GAMEDATA_TOKEN_SECRET"],
            steam_publisher_key=get("STEAM_PUBLISHER_KEY"),
            app_ids=app_ids,
            test_app_ids=test_app_ids,
            test_steamids=frozenset(test_steamids),
            demo_of=demo_of,
            data_dir=data_dir,
            geoip_db=get("GEOIP_DB", f"{data_dir}/geo/dbip-city-lite.mmdb"),
            public_base_url=public_base_url,
            site_origin=site_origin,
            privacy_url=get("PRIVACY_URL", f"{site_origin}/privacy"),
            link_months=integer("GAMEDATA_LINK_MONTHS", "24"),
            upload_every_s=integer("GAMEDATA_UPLOAD_EVERY_S", "60", low=10),
            max_batch_kb=integer("GAMEDATA_MAX_BATCH_KB", "256"),
            max_mb_per_day=integer("GAMEDATA_MAX_MB_PER_DAY", "50"),
            min_free_mb=integer("GAMEDATA_MIN_FREE_MB", "2048", low=0),
            # Only Caddy on the same machine talks to it.
            host=get("HOST", "127.0.0.1"),
            port=integer("PORT", "8103"),
        )
