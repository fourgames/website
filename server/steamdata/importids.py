"""Adds a hand-copied list of games to an engine: python -m steamdata.importids godot steamdb < ids.txt

The list is any text with Steam app ids in it: one per line, a JSON list, or store/SteamDB links.
Made for the SteamDB bookmarklet in README.md (Engines: which games are Godot), which copies the
ids of the games on the page you're looking at. Only adds; run it again with newer lists.
"""

from __future__ import annotations

import argparse
import re
import sys
import time

from .config import Config, ConfigError
from .db import Store

# A link's /app/123, or a bare number of 3-8 digits (Steam app ids), not part of a longer one.
_ID = re.compile(r"/app/(\d+)|(?<![\d.:-])(\d{3,8})(?![\d.:-])")


def parse_ids(text: str) -> list[int]:
    found = []
    for link, bare in _ID.findall(text):
        appid = int(link or bare)
        if appid > 0 and appid not in found:
            found.append(appid)
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m steamdata.importids",
                                     description="Adds a hand-copied list of games to an engine.")
    parser.add_argument("engine", help="e.g. godot")
    parser.add_argument("source", help="where the list is from, e.g. steamdb")
    parser.add_argument("--evidence", help="note kept with each game (default: copied from SOURCE on today's date)")
    args = parser.parse_args(argv)
    ids = parse_ids(sys.stdin.read())
    if not ids:
        print("steamdata.importids: no app ids in the input", file=sys.stderr)
        return 1
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"steamdata.importids: {error}", file=sys.stderr)
        return 2
    now = time.time()
    evidence = args.evidence or f"on {args.source}'s {args.engine} list, copied by hand {time.strftime('%Y-%m-%d')}"
    store = Store(config.db_path)
    try:
        result = store.import_signals(ids, args.engine.lower(), args.source.lower(), evidence, now)
    finally:
        store.close()
    print(f"{result['games']} games: {result['new_signals']} new from {args.source}, "
          f"{result['new_apps']} unknown before (the snapshot fills them in), "
          f"{result['godot_changed']} joined the Godot set")
    return 0


if __name__ == "__main__":
    sys.exit(main())
