"""Settings, all from the environment (/etc/fourgames/contact.env on the server)."""

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
    # Who gets the messages, and the address they come from (the SMTP account must be allowed to
    # send as it; at Strato that's the mailbox itself or one of its aliases).
    mail_to: str
    mail_from: str
    # Origins that may post (the browser's Origin header). Anything else gets 403.
    allowed_origins: tuple[str, ...]
    # Optional: a short "new message" notice in Discord, without the message.
    discord_webhook_url: str
    # Anti-spam. A person needs a few seconds to type a message; bots post at once.
    min_seconds: float
    # Per IP: at most rate_limit messages per rate_window seconds.
    rate_limit: int
    rate_window: int
    host: str
    port: int

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env

        def get(name: str, default: str = "") -> str:
            # A blank line in the env file (NAME=) means the default too.
            return env.get(name, "").strip() or default

        def number(name: str, default: str, kind=int):
            value = get(name, default)
            try:
                return kind(value)
            except ValueError:
                raise ConfigError(f"{name} must be a number, not {value!r}") from None

        user = get("SMTP_USER")
        password = get("SMTP_PASSWORD")
        if not user or not password:
            raise ConfigError("SMTP_USER and SMTP_PASSWORD must be set (the mailbox that sends the messages)")
        origins = tuple(o.strip().rstrip("/") for o in get("CONTACT_ALLOWED_ORIGINS", "https://fourgames.se").split(",") if o.strip())

        return cls(
            smtp_host=get("SMTP_HOST", "smtp.strato.com"),
            smtp_port=number("SMTP_PORT", "587"),
            smtp_user=user,
            smtp_password=password,
            mail_to=get("CONTACT_TO", "support@fourgames.se"),
            # By default the SMTP user, which is always allowed to send as itself.
            mail_from=get("CONTACT_FROM", user),
            allowed_origins=origins,
            discord_webhook_url=get("CONTACT_DISCORD_WEBHOOK_URL"),
            min_seconds=number("CONTACT_MIN_SECONDS", "3", float),
            rate_limit=number("CONTACT_RATE_LIMIT", "5"),
            rate_window=number("CONTACT_RATE_WINDOW", "3600"),
            # Only Caddy on the same machine talks to it.
            host=get("HOST", "127.0.0.1"),
            port=number("PORT", "8101"),
        )
