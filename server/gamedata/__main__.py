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
    # shutdown_timeout=2: on a restart aiohttp otherwise waits up to 60 s for requests still being
    # worked on (a slow dashboard call, say), and the port answers nothing meanwhile, which the
    # uptime check counts as down. A request still running after 2 s is cut off.
    web.run_app(make_app(config), host=config.host, port=config.port, access_log=None,
                shutdown_timeout=2,
                print=lambda *_: logging.getLogger("gamedata").info(
                    "listening on %s:%s", config.host, config.port))


main()
