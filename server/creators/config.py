"""Settings, all from the environment (/etc/fourgames/creators.env on the server)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Mapping

DEFAULT_DB_PATH = "/srv/fourgames/creators/creators.db"
DEFAULT_STEAM_DB = "/srv/fourgames/steamdata/steam.db"
# The website's game list, read for our own games' app ids (same checkout as this code).
GAMES_JS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                        "src", "data", "games.js")
USER_AGENT = "FourGamesCreators/1.0 (+https://fourgames.se; small-studio creator research, internal use)"


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    db_path: str = DEFAULT_DB_PATH
    # The Steam data collector's database, read only: which games exist, their tags and reviews.
    steam_db: str = DEFAULT_STEAM_DB
    # A YouTube Data API key from its OWN Google Cloud project. The quota (10,000 units a day) is per
    # project, and the feedback loop's key already spends ~7,500 of its project's on media searches.
    youtube_api_key: str = ""
    # Units to spend a day (YouTube's day starts at midnight Pacific time). A search is 100.
    daily_units: int = 9500
    # Our own games (searched every week; their tags make similar games go first). Empty: read
    # from the website's src/data/games.js.
    own_appids: tuple[int, ...] = field(default_factory=tuple)
    # A game is searched again after this many days, for the videos since the last search.
    research_days: int = 30
    # The first search of a game looks back this many days: creators active now, not in 2019.
    lookback_days: int = 180
    # Only games with at least this many reviews are searched (fewer: hardly any videos).
    min_reviews: int = 30
    # Games with more reviews than this are skipped (Counter-Strike 2 and the like spend the quota on
    # channels that won't answer)...
    max_reviews: int = 50_000
    # ...unless they're like our games (games.py LOOKALIKE_SIM): those are searched up to this many.
    lookalike_max_reviews: int = 1_000_000
    # Games over this full price (cents, US) are skipped: AAA releases too new to have many reviews.
    max_price: int = 3000
    # Games whose developer or publisher is exactly this name count as ours too.
    own_studio: str = "Four Games"
    # Channel numbers (subscribers, description, emails) are read again after this many days.
    channel_refresh_days: int = 30
    # Twitch's Helix API (twitch.py): the app the key bot uses. Empty: Twitch is skipped.
    twitch_client_id: str = ""
    twitch_client_secret: str = ""
    log_level: str = "INFO"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env

        def get(name: str, default: str = "") -> str:
            return env.get(name, "").strip() or default

        def number(name: str, default: int, low: int, high: int) -> int:
            value = get(name, str(default))
            try:
                result = int(value)
            except ValueError:
                raise ConfigError(f"{name} must be a whole number, not {value!r}") from None
            if not low <= result <= high:
                raise ConfigError(f"{name} must be between {low} and {high}, not {value}")
            return result

        own = get("OWN_APPIDS")
        if own and not re.fullmatch(r"\d+(\s*,\s*\d+)*", own):
            raise ConfigError(f"OWN_APPIDS must be app ids separated by commas, not {own!r}")
        level = get("LOG_LEVEL", "INFO").upper()
        if level not in ("DEBUG", "INFO", "WARNING", "ERROR"):
            raise ConfigError(f"LOG_LEVEL must be DEBUG, INFO, WARNING or ERROR, not {level!r}")
        return cls(
            db_path=get("DB_PATH", DEFAULT_DB_PATH),
            steam_db=get("STEAM_DB", DEFAULT_STEAM_DB),
            youtube_api_key=get("YOUTUBE_API_KEY"),
            daily_units=number("DAILY_UNITS", 9500, 200, 1_000_000),
            own_appids=tuple(int(x) for x in re.findall(r"\d+", own)) or read_own_appids(),
            research_days=number("RESEARCH_DAYS", 30, 1, 365),
            lookback_days=number("LOOKBACK_DAYS", 180, 7, 3650),
            min_reviews=number("MIN_REVIEWS", 30, 0, 1_000_000),
            max_reviews=number("MAX_REVIEWS", 50_000, 1, 100_000_000),
            lookalike_max_reviews=number("LOOKALIKE_MAX_REVIEWS", 1_000_000, 1, 100_000_000),
            own_studio=get("OWN_STUDIO", "Four Games"),
            max_price=number("MAX_PRICE", 3000, 0, 100_000),
            channel_refresh_days=number("CHANNEL_REFRESH_DAYS", 30, 1, 365),
            twitch_client_id=get("TWITCH_CLIENT_ID"),
            twitch_client_secret=get("TWITCH_CLIENT_SECRET"),
            log_level=level,
        )


def read_own_appids(path: str = GAMES_JS) -> tuple[int, ...]:
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return ()
    seen: list[int] = []
    for match in re.findall(r"\bappId\s*:\s*(\d+)", text):
        if int(match) not in seen:
            seen.append(int(match))
    return tuple(seen)
