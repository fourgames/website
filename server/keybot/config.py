"""Settings, all from the environment (/etc/fourgames/keybot.env on the server)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

from .eligibility import Thresholds


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    bot_token: str
    client_id: str
    client_secret: str
    guild_id: int
    # The role YouTube members get from Discord's YouTube integration: a role id or its name.
    member_role: str
    admin_channel_id: int
    admin_role_id: int | None
    # Where /verify and /callback are reached from outside, without a trailing slash.
    public_base_url: str
    state_secret: str
    youtube_api_key: str
    twitch_client_id: str
    twitch_client_secret: str
    thresholds: Thresholds
    low_stock: int
    db_path: str
    host: str
    port: int
    # /grantrole needs the guild's member list, so the privileged Server Members intent. Off unless
    # GRANTROLE_ENABLED=1 (and the intent is switched on in the Developer Portal).
    grantrole_enabled: bool = False
    # The game-data service's internal API (server/gamedata, localhost only), for /privacy. Without
    # the key, /privacy only links fourgames.se/privacy.
    gamedata_internal_url: str = "http://127.0.0.1:8103/gamedata/v1"
    gamedata_internal_key: str = ""

    @property
    def redirect_uri(self) -> str:
        return f"{self.public_base_url}/callback"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env

        def get(name: str, default: str = "") -> str:
            return env.get(name, default).strip()

        required = [
            "DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "GUILD_ID",
            "ADMIN_CHANNEL_ID", "PUBLIC_BASE_URL", "STATE_SECRET",
        ]
        missing = [name for name in required if not get(name)]
        if missing:
            raise ConfigError("missing settings: " + ", ".join(missing))

        def integer(name: str, default: str | None = None) -> int:
            # A blank line in the env file (NAME=) means the default too.
            value = get(name) or default or ""
            try:
                return int(value)
            except ValueError:
                raise ConfigError(f"{name} must be a whole number, not {value!r}") from None

        secret = get("STATE_SECRET")
        # The secret signs the verify links; a short one could be guessed.
        if len(secret) < 32:
            raise ConfigError("STATE_SECRET must be at least 32 characters (openssl rand -hex 32)")

        return cls(
            bot_token=get("DISCORD_BOT_TOKEN"),
            client_id=get("DISCORD_CLIENT_ID"),
            client_secret=get("DISCORD_CLIENT_SECRET"),
            guild_id=integer("GUILD_ID"),
            member_role=get("MEMBER_ROLE", "YouTube Member") or "YouTube Member",
            admin_channel_id=integer("ADMIN_CHANNEL_ID"),
            admin_role_id=integer("ADMIN_ROLE_ID") if get("ADMIN_ROLE_ID") else None,
            public_base_url=get("PUBLIC_BASE_URL").rstrip("/"),
            state_secret=secret,
            youtube_api_key=get("YOUTUBE_API_KEY"),
            twitch_client_id=get("TWITCH_CLIENT_ID"),
            twitch_client_secret=get("TWITCH_CLIENT_SECRET"),
            thresholds=Thresholds(
                min_youtube_subscribers=integer("MIN_YOUTUBE_SUBSCRIBERS", "1000"),
                min_twitch_followers=integer("MIN_TWITCH_FOLLOWERS", "500"),
                max_days_since_upload=integer("MAX_DAYS_SINCE_UPLOAD", "60"),
            ),
            low_stock=integer("LOW_STOCK", "5"),
            db_path=get("DB_PATH", "/srv/fourgames/keybot/keys.db") or "/srv/fourgames/keybot/keys.db",
            # Only Caddy on the same machine talks to it.
            host=get("HOST", "127.0.0.1") or "127.0.0.1",
            port=integer("PORT", "8100"),
            grantrole_enabled=get("GRANTROLE_ENABLED").lower() in ("1", "true", "yes", "on"),
            gamedata_internal_url=(get("GAMEDATA_INTERNAL_URL") or "http://127.0.0.1:8103/gamedata/v1").rstrip("/"),
            gamedata_internal_key=get("GAMEDATA_INTERNAL_KEY"),
        )
