"""Starts the contact form backend: python -m contact (from the server/ folder)."""

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
        print(f"contact: {error}", file=sys.stderr)
        sys.exit(2)
    # access_log=None: aiohttp's access log would show every IP in full; web.py logs a hash instead.
    web.run_app(make_app(config), host=config.host, port=config.port, access_log=None,
                print=lambda *_: logging.getLogger("contact").info(
                    "listening on %s:%s", config.host, config.port))


main()
