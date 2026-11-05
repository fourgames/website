"""The key bot's command line, for the server (no Discord needed): python -m keybot.admin … (from server/).

  import-keys --game "Name" [--steam-app-id N] FILE...   keys from .txt/.csv files (e.g. KeyBot's export)
  mark-claimed --game "Name" --user DISCORD_ID [--note TEXT]   a claim made with the old KeyBot
  list                                                   the games and their counts

The database is DB_PATH from the environment (default /srv/fourgames/keybot/keys.db). It's safe to
run while the bot is running. Nothing here prints a key.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .db import Store, role_ids
from .keyfile import KeyFileError, read_keys

DEFAULT_DB_PATH = "/srv/fourgames/keybot/keys.db"


def db_path(env=None) -> str:
    env = os.environ if env is None else env
    return env.get("DB_PATH", "").strip() or DEFAULT_DB_PATH


def import_keys(store: Store, game_name: str, steam_app_id: int | None, files: list[str]) -> int:
    game, created = store.add_game(game_name, steam_app_id)
    print(f"{'Created' if created else 'Using'} game {game['name']!r} (id {game['id']}"
          f"{', Steam app ' + str(game['steam_app_id']) if game['steam_app_id'] else ''})")
    total_added = total_known = 0
    for path in files:
        try:
            text = Path(path).read_bytes().decode("utf-8-sig", errors="replace")
            values, repeats = read_keys(text)
        except (OSError, KeyFileError) as error:
            print(f"{path}: couldn't read it: {error}", file=sys.stderr)
            return 1
        added, known = store.add_keys(game["id"], values, added_by="import")
        total_added += added
        total_known += known
        print(f"{path}: {len(values)} key(s) read, {added} added, {known} already in the database, "
              f"{repeats} repeated in the file")
    print(f"Added {total_added}, skipped {total_known}. Available now: {store.available_count(game['id'])}.")
    return 0


def mark_claimed(store: Store, game_name: str, user: str, note: str | None) -> int:
    if not user.isdigit():
        print(f"--user must be a Discord user id (digits), not {user!r}", file=sys.stderr)
        return 2
    game = store.game_by_name(game_name)
    if game is None:
        print(f"No game named {game_name!r}. Add it first (import-keys, or /keys add name: in Discord).",
              file=sys.stderr)
        return 1
    count = store.record_prior_claim(game["id"], int(user), note)
    limit = game["per_user_limit"]
    print(f"Recorded a KeyBot claim of {game['name']!r} for {user}. They have {count} for it now "
          f"(limit {limit or 'none'}).")
    return 0


def list_games(store: Store) -> int:
    rows = store.status_summary()
    if not rows:
        print("No games yet.")
        return 0
    by_id = {g["id"]: g for g in store.games()}
    for r in rows:
        game = by_id[r["id"]]
        given = sum((r[reason] or 0) for reason in ("member", "creator", "press", "manual"))
        roles = ",".join(str(i) for i in role_ids(game)) or "member role"
        print(f"{r['name']}: {r['available'] or 0} available, {given} given, {r['prior']} KeyBot claim(s), "
              f"{r['open_requests']} open request(s) | {'public' if r['public'] else 'private'}, "
              f"limit {r['per_user_limit'] or 'none'}, roles {roles}, Steam app {r['steam_app_id'] or '?'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m keybot.admin", description="The key bot's command line.")
    commands = parser.add_subparsers(dest="command", required=True)

    p = commands.add_parser("import-keys", help="add keys from files to a game (creates the game if missing)")
    p.add_argument("--game", required=True, help="the game's name, as in Discord")
    p.add_argument("--steam-app-id", type=int, help="its Steam app id")
    p.add_argument("files", nargs="+", metavar="FILE", help=".txt (one key per line) or .csv")

    p = commands.add_parser("mark-claimed", help="record a claim made with the old KeyBot (counts for the limit)")
    p.add_argument("--game", required=True)
    p.add_argument("--user", required=True, help="their Discord user id")
    p.add_argument("--note", help="e.g. where it came from")

    commands.add_parser("list", help="the games and their counts")

    args = parser.parse_args(argv)
    store = Store(db_path())
    try:
        if args.command == "import-keys":
            return import_keys(store, args.game, args.steam_app_id, args.files)
        if args.command == "mark-claimed":
            return mark_claimed(store, args.game, args.user, args.note)
        return list_games(store)
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
