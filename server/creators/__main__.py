"""One collector run: python -m creators (from the server/ folder).

  python -m creators                     spends the units due by now (creators.timer, hourly)
  python -m creators --searches 3        a short trial: at most 3 game searches
  python -m creators --all               spends the whole day's units now
  python -m creators --all --appids 1,2,3  search just these games now (a game's look-alikes)
  python -m creators --links 0           no link following after the YouTube part (default 150 links)
"""

from __future__ import annotations

import argparse
import logging
import sys

from .collector import Collector
from .config import Config, ConfigError
from . import export
from .db import Store
from .games import own_appids
from .sites import Follower


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m creators", description="Finds YouTube creators.")
    parser.add_argument("--searches", type=int, help="stop after this many game searches")
    parser.add_argument("--all", action="store_true", help="spend the whole day's units, not just what's due")
    parser.add_argument("--appids", help="search just these games now, comma-separated (e.g. a game's look-alikes)")
    parser.add_argument("--links", type=int, default=150,
                        help="then follow up to this many creators' links for emails (0: none)")
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
        only = {int(x) for x in args.appids.split(",") if x.strip().isdigit()} if args.appids else None
        Collector(config, store).run(spend_all=args.all, max_searches=args.searches, only=only)
        if args.links:
            try:
                Follower(store).run(own_appids(config.steam_db, config.own_appids, config.own_studio), args.links)
            except Exception:  # never let the link follower break the YouTube runs
                logging.getLogger("creators").exception("following links failed")
        try:
            export.write(config, store)
        except Exception:  # the page shows the last file; the next run tries again
            logging.getLogger("creators").exception("writing the dashboard file failed")
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
