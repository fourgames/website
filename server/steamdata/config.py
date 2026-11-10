"""Settings, all from the environment (/etc/fourgames/steamdata.env on the server)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

DEFAULT_DB_PATH = "/srv/fourgames/steamdata/steam.db"
# Says who we are to every site we ask. No personal address: the site has the contact details.
USER_AGENT = "FourGamesSteamData/1.0 (+https://fourgames.se; small-studio market research, internal use)"


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    db_path: str = DEFAULT_DB_PATH
    # A Steam Web API key, only for the app list (IStoreService/GetAppList). Everything else is
    # keyless. Empty: no app list, but the apps already in the database (and PCGamingWiki's Godot
    # games) are still collected.
    web_api_key: str = ""
    # Prices are the store's for this country (US: US dollars, in cents). Don't change it once
    # data is collected: the daily prices would mix currencies.
    country: str = "US"
    # api.steampowered.com: the app list, the daily snapshots and the player counts share this.
    # The Steam Web API terms allow 100,000 calls a day; 60 a minute is at most 86,400.
    webapi_per_minute: float = 60.0
    # store.steampowered.com/api/appdetails allows about 200 per 5 minutes per IP.
    appdetails_per_5min: float = 120.0
    # www.pcgamingwiki.com: one request per this many seconds.
    pcgw_seconds: float = 10.0
    # The full metadata (appdetails) is refreshed this often; new apps are fetched first.
    details_days: int = 30
    # The store page's AI disclosure is read again this often (recent and upcoming games only).
    ai_days: int = 60
    # PCGamingWiki engine pages to read the games of, e.g. "Godot" for Engine:Godot.
    pcgw_engines: tuple[str, ...] = ("Godot",)
    # Raw player-count samples older than this many days are deleted (the daily peak stays in
    # app_daily). 0 keeps them all.
    samples_keep_days: int = 0
    log_level: str = "INFO"
    user_agent: str = USER_AGENT

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env

        def get(name: str, default: str = "") -> str:
            # A blank line in the env file (NAME=) means the default too.
            return env.get(name, "").strip() or default

        def number(name: str, default: float, low: float, high: float) -> float:
            value = get(name, str(default))
            try:
                result = float(value)
            except ValueError:
                raise ConfigError(f"{name} must be a number, not {value!r}") from None
            if not low <= result <= high:
                raise ConfigError(f"{name} must be between {low:g} and {high:g}, not {value}")
            return result

        country = get("COUNTRY", "US").upper()
        if len(country) != 2 or not country.isalpha():
            raise ConfigError(f"COUNTRY must be a two-letter country code like US, not {country!r}")
        level = get("LOG_LEVEL", "INFO").upper()
        if level not in ("DEBUG", "INFO", "WARNING", "ERROR"):
            raise ConfigError(f"LOG_LEVEL must be DEBUG, INFO, WARNING or ERROR, not {level!r}")
        engines = tuple(e.strip() for e in get("PCGW_ENGINES", "Godot").split(",") if e.strip())

        return cls(
            db_path=get("DB_PATH", DEFAULT_DB_PATH),
            web_api_key=get("STEAM_WEB_API_KEY"),
            country=country,
            webapi_per_minute=number("WEBAPI_PER_MINUTE", 60, 1, 69),
            appdetails_per_5min=number("APPDETAILS_PER_5MIN", 120, 1, 200),
            pcgw_seconds=number("PCGW_SECONDS", 10, 2, 3600),
            details_days=int(number("DETAILS_DAYS", 30, 1, 365)),
            ai_days=int(number("AI_DAYS", 60, 1, 365)),
            pcgw_engines=engines,
            samples_keep_days=int(number("SAMPLES_KEEP_DAYS", 0, 0, 100000)),
            log_level=level,
        )
