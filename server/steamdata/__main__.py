"""Starts the collector: python -m steamdata (from the server/ folder).

  python -m steamdata                          runs until stopped (systemd: steamdata.service)
  python -m steamdata --max-requests 20        a short trial run, then exits
  python -m steamdata --lanes snapshot,players only some lanes (applist, tags, snapshot, players,
                                               details, pcgw)
"""

import argparse
import logging
import signal
import sys

from .collector import Collector
from .config import Config, ConfigError
from .db import Store

LANES = ("applist", "tags", "snapshot", "players", "details", "pcgw")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m steamdata", description="Collects Steam market data.")
    parser.add_argument("--max-requests", type=int, help="stop after this many requests")
    parser.add_argument("--lanes", help="comma-separated lanes to run (default: all)")
    args = parser.parse_args(argv)
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"steamdata: {error}", file=sys.stderr)
        return 2
    lanes = None
    if args.lanes:
        lanes = {name.strip() for name in args.lanes.split(",") if name.strip()}
        unknown = lanes - set(LANES)
        if unknown:
            print(f"steamdata: unknown lane(s): {', '.join(sorted(unknown))} (known: {', '.join(LANES)})",
                  file=sys.stderr)
            return 2
    # journald adds its own timestamps, so the format leaves them out.
    logging.basicConfig(level=config.log_level, format="%(levelname)s %(name)s: %(message)s")
    store = Store(config.db_path)
    collector = Collector(config, store, lanes=lanes)
    # systemctl stop sends SIGTERM: finish the request in flight, save the counts, close cleanly.
    signal.signal(signal.SIGTERM, lambda *_: collector.stop())
    signal.signal(signal.SIGINT, lambda *_: collector.stop())
    try:
        collector.run(max_requests=args.max_requests)
    finally:
        store.close()
        logging.getLogger("steamdata").info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
