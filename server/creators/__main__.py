"""One collector run: python -m creators (from the server/ folder).

  python -m creators                     spends the units due by now (creators.timer, hourly)
  python -m creators --searches 3        a short trial: at most 3 game searches
  python -m creators --all               spends the whole day's units now
"""

from __future__ import annotations

import argparse
import logging
import sys

from .collector import Collector
from .config import Config, ConfigError
from .db import Store


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m creators", description="Finds YouTube creators.")
    parser.add_argument("--searches", type=int, help="stop after this many game searches")
    parser.add_argument("--all", action="store_true", help="spend the whole day's units, not just what's due")
    args = parser.parse_args(argv)
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"creators: {error}", file=sys.stderr)
        return 2
    if not config.youtube_api_key:
        print("creators: set YOUTUBE_API_KEY in /etc/fourgames/creators.env (see creators.env.example)",
              file=sys.stderr)
        return 2
    logging.basicConfig(level=config.log_level, format="%(levelname)s %(name)s: %(message)s")
    store = Store(config.db_path)
    try:
        Collector(config, store).run(spend_all=args.all, max_searches=args.searches)
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
