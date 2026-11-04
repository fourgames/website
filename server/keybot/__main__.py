"""Starts the key bot: python -m keybot (from the server/ folder)."""

import logging
import sys

from .bot import KeyBot
from .config import Config, ConfigError
from .db import Store


def main() -> None:
    # journald adds its own timestamps, so the format leaves them out.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"keybot: {error}", file=sys.stderr)
        sys.exit(2)
    store = Store(config.db_path)
    bot = KeyBot(config, store)
    # log_handler=None keeps the logging set up above instead of discord.py's own.
    bot.run(config.bot_token, log_handler=None)


main()
