"""Starts the player game-data API: python -m gamedata (from the server/ folder)."""

import logging
import sys

from aiohttp import web

from .config import Config, ConfigError
from .web import make_app


def main() -> None:
    # journald adds its own timestamps, so the format leaves them out.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"gamedata: {error}", file=sys.stderr)
        sys.exit(2)
    if not config.app_ids:
        logging.getLogger("gamedata").warning(
            "GAMEDATA_APP_IDS is empty: every session start is refused until a game's app id is added")
    # access_log=None: aiohttp's access log would show every IP.
    web.run_app(make_app(config), host=config.host, port=config.port, access_log=None,
                print=lambda *_: logging.getLogger("gamedata").info(
                    "listening on %s:%s", config.host, config.port))


main()
