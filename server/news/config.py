"""Settings, all from the environment: the Strato mailbox from /etc/fourgames/outreach.env (the same
one the creator outreach sends from), the rest from /etc/fourgames/news.env."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    # The address the emails come from: the mailbox itself or one of its aliases (news@ by default
    # in news.env.example; the alias must exist in Strato first).
    mail_from: str
    from_name: str
    # Origins that may sign up (the browser's Origin header). Anything else gets 403.
    allowed_origins: tuple[str, ...]
    # Where this service is reached from outside (the footer form posts here).
    public_url: str
    # The short address the email links use: <link_url>/c/<code> confirms, <link_url>/u/<code> unsubscribes.
    link_url: str
    # The database and stats.json (the dashboard's numbers).
    data_dir: str
    # Anti-spam: a person needs a moment to type an address; bots post at once.
    min_seconds: float
    # Per IP: at most rate_limit signups per rate_window seconds.
    rate_limit: int
    rate_window: int
    # At most this many confirm emails a day in all, so a flood of fake signups can't burn the
    # mailbox's reputation.
    daily_max: int
    host: str
    port: int

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env

        def get(name: str, default: str = "") -> str:
            return env.get(name, "").strip() or default

        def number(name: str, default: str, kind=int):
            value = get(name, default)
            try:
                return kind(value)
            except ValueError:
                raise ConfigError(f"{name} must be a number, not {value!r}") from None

        user = get("MAIL_USER")
        password = get("MAIL_PASSWORD")
        if not user or not password:
            raise ConfigError("MAIL_USER and MAIL_PASSWORD must be set (the Strato mailbox, in /etc/fourgames/outreach.env)")
        origins = tuple(o.strip().rstrip("/") for o in get("NEWS_ALLOWED_ORIGINS", "https://fourgames.se").split(",") if o.strip())
        return cls(
            smtp_host=get("SMTP_HOST", "smtp.strato.com"),
            smtp_port=number("SMTP_PORT", "587"),
            smtp_user=user,
            smtp_password=password,
            mail_from=get("NEWS_FROM", user),
            from_name=get("NEWS_FROM_NAME", "Four Games"),
            allowed_origins=origins,
            public_url=get("NEWS_PUBLIC_URL", "https://api.fourgames.se/news").rstrip("/"),
            link_url=get("NEWS_LINK_URL", "https://news.fourgames.se").rstrip("/"),
            data_dir=get("NEWS_DIR", "/srv/fourgames/news").rstrip("/") or "/",
            min_seconds=number("NEWS_MIN_SECONDS", "1.5", float),
            rate_limit=number("NEWS_RATE_LIMIT", "5"),
            rate_window=number("NEWS_RATE_WINDOW", "3600"),
            daily_max=number("NEWS_DAILY_MAX", "200"),
            # Only Caddy on the same machine talks to it.
            host=get("NEWS_HOST", "127.0.0.1"),
            port=number("NEWS_PORT", "8104"),
        )
