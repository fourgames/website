"""Settings, all from the environment: /etc/fourgames/feedback.env (the Twitch app, shared with the
feedback loop) and /etc/fourgames/alerts.env (this service's own secrets) on the server."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

# The same channel and login as feedback/announce.py.
YOUTUBE_CHANNEL_ID = "UCGf6yX8yYzo1FBzhmKhFduA"
TWITCH_LOGIN = "fourgamesab"


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    # Where Caddy serves this service from outside, without a trailing slash.
    public_base_url: str
    # Signs YouTube's notifications (WebSub hub.secret). Blank: YouTube pushes off.
    youtube_secret: str
    twitch_client_id: str
    twitch_client_secret: str
    # Signs Twitch's notifications (EventSub). Blank: Twitch pushes off.
    twitch_secret: str
    youtube_channel_id: str
    twitch_login: str
    # The `own` checkout's feedback folder, whose announce.py --push does the check, and the
    # interpreter the loop runs it with.
    feedback_dir: str
    feedback_python: str
    # Seconds after a push to check, once per value (YouTube's API can take a moment to say a
    # stream is live; Twitch's to list it).
    check_delays: tuple[float, ...]
    check_timeout: float
    # How often the YouTube subscription is renewed at most (it lasts about 5 days).
    renew_hours: float
    host: str
    port: int

    @property
    def youtube_enabled(self) -> bool:
        return bool(self.youtube_secret)

    @property
    def twitch_enabled(self) -> bool:
        return bool(self.twitch_secret)

    @property
    def youtube_callback(self) -> str:
        return f"{self.public_base_url}/youtube"

    @property
    def twitch_callback(self) -> str:
        return f"{self.public_base_url}/twitch"

    @property
    def youtube_topic(self) -> str:
        return f"https://www.youtube.com/xml/feeds/videos.xml?channel_id={self.youtube_channel_id}"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env

        def get(name: str, default: str = "") -> str:
            # A blank line in the env file (NAME=) means the default too.
            return env.get(name, "").strip() or default

        def number(name: str, default: str) -> float:
            value = get(name, default)
            try:
                result = float(value)
            except ValueError:
                raise ConfigError(f"{name} must be a number, not {value!r}") from None
            if result <= 0:
                raise ConfigError(f"{name} must be more than 0")
            return result

        base = get("PUBLIC_BASE_URL").rstrip("/")
        if not base:
            raise ConfigError("missing settings: PUBLIC_BASE_URL")
        # Twitch only calls HTTPS addresses on port 443.
        if not base.startswith("https://"):
            raise ConfigError("PUBLIC_BASE_URL must start with https://")

        youtube_secret = get("YOUTUBE_WEBSUB_SECRET")
        # The hub takes up to 200 bytes; a short one could be guessed.
        if youtube_secret and not 16 <= len(youtube_secret.encode()) < 200:
            raise ConfigError("YOUTUBE_WEBSUB_SECRET must be 16 to 199 characters (openssl rand -hex 32)")

        twitch_secret = get("TWITCH_EVENTSUB_SECRET")
        if twitch_secret:
            # Twitch's own limits, ASCII only.
            if not (10 <= len(twitch_secret) <= 100 and twitch_secret.isascii()):
                raise ConfigError("TWITCH_EVENTSUB_SECRET must be 10 to 100 ASCII characters (openssl rand -hex 32)")
            missing = [n for n in ("TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET") if not get(n)]
            if missing:
                raise ConfigError("TWITCH_EVENTSUB_SECRET needs " + " and ".join(missing) + " (from feedback.env)")

        if not youtube_secret and not twitch_secret:
            raise ConfigError("set YOUTUBE_WEBSUB_SECRET, TWITCH_EVENTSUB_SECRET or both")

        raw_delays = get("CHECK_DELAYS", "30,150")
        try:
            delays = tuple(sorted(float(d) for d in raw_delays.replace(" ", "").split(",") if d))
        except ValueError:
            raise ConfigError(f"CHECK_DELAYS must be seconds separated by commas, not {raw_delays!r}") from None
        if not delays or delays[0] < 0:
            raise ConfigError("CHECK_DELAYS needs at least one delay, none below 0")

        port = get("PORT", "8102")
        try:
            port_number = int(port)
        except ValueError:
            raise ConfigError(f"PORT must be a whole number, not {port!r}") from None

        return cls(
            public_base_url=base,
            youtube_secret=youtube_secret,
            twitch_client_id=get("TWITCH_CLIENT_ID"),
            twitch_client_secret=get("TWITCH_CLIENT_SECRET"),
            twitch_secret=twitch_secret,
            youtube_channel_id=get("YOUTUBE_CHANNEL_ID", YOUTUBE_CHANNEL_ID),
            twitch_login=get("TWITCH_LOGIN", TWITCH_LOGIN).lower(),
            feedback_dir=get("FEEDBACK_DIR", "/srv/fourgames/own/feedback").rstrip("/"),
            feedback_python=get("FEEDBACK_PYTHON", "/srv/fourgames/venv/bin/python"),
            check_delays=delays,
            check_timeout=number("CHECK_TIMEOUT", "900"),
            renew_hours=number("RENEW_HOURS", "72"),
            # Only Caddy on the same machine talks to it.
            host=get("HOST", "127.0.0.1"),
            port=port_number,
        )
