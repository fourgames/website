"""A player's download: everything stored for their pid, as JSON files in a zip, with a README.

Built in a worker thread with its own database connection, into a temporary file under
DATA_DIR/tmp (on disk, not in memory), one batch at a time, so a long play history costs disk for
a moment and very little memory.
"""

from __future__ import annotations

import gzip
import json
import tempfile
import zipfile
from pathlib import Path
from typing import IO, Any

from .store import Store, iso, read_gzip_json

FILENAME = "fourgames-data.zip"

README = """Your Four Games game data
=========================

This is everything Four Games' servers store about you from our games: what the game sent while
you played. It's stored under a pseudonym (the "pid" below), never next to your Steam ID; your
Steam ID is only used, when you sign in, to work out the pid again. Why we collect it, and your
choices (opt out, anonymise): https://fourgames.se/privacy

{link_months} months after your last session, everything here is anonymised by itself: it's
moved to a new random pid that nothing links to you, so you can't download it any more (and
neither can anyone else find it is yours).

Times are UTC, written like 2026-11-04T21:06:00Z. "t" in events is seconds since the session
started, counting game time (not while paused). Empty fields are null.

player.json
  pid          Your pseudonym: a keyed hash of your Steam ID. It can't be turned back into it.
  opted_out    true if you've turned data collection off (in a game's settings, or on
               fourgames.se/privacy). Nothing new is collected while it's true.
  created      When we first heard from you.
  updated      The last change (a new session, opting out or in).

sessions.json - one entry per time you started a game
  session_id       A random id for that session.
  app_id           The game's Steam app id (its store page is
                   store.steampowered.com/app/<app_id>).
  started, ended   When it started, and when the game said it ended (null after a crash).
  last_seen        The last time the game sent anything in that session.
  game_version, build_id, godot_version, platform, locale
                   The game's version and Steam build, the engine version, the system and the
                   game's language.
  country, region  Where you played from: the country (ISO code) and region, worked out from your
                   IP address when the session started. The IP address itself is never kept.
                   (IP Geolocation by DB-IP, https://db-ip.com, CC BY 4.0.)
  consent_hardware Whether the game was allowed to send hardware and settings.
  previous_crash   What the game said at start about an earlier crash, if anything.
  batches, events  How many uploads and events came in.
  last_t           The latest event time (seconds of play) we saw.
  last_progress, last_progress_t
                   The latest "progress" event of the session (how far you got) and its time.
  playtime_s       Seconds played, as the game reported at the end.
  end_seq          The number of uploads the game said it made.
  summary          The game's end-of-session summary (for example how far you got).

hardware.json - per session, only when allowed
  os, cpu, cpu_cores, ram_mb, gpu, gpu_driver, renderer, screen_w, screen_h, refresh_hz,
  steam_deck   Your system as the game saw it: operating system, processor and its cores, memory
               in MB, graphics card and driver, the engine's renderer, screen size in pixels and
               refresh rate, and whether it was a Steam Deck.

settings.json - per session, only when allowed
  data         The game's settings at the start of the session (volume, graphics options, ...).

events/<app_id>/<session_id>/<seq>.json - what happened in a session, one file per upload
  seq          The upload's number within the session (0, 1, 2, ...).
  received     When it arrived.
  events       A list of:
                 t     seconds since the session started
                 type  action (something you did, named by the game, e.g. plant_seed),
                       snapshot (a short summary of the game's state, about every 30 seconds),
                       progress (how far you are), rng (random seed changes),
                       error (a non-fatal error in the game's scripts), custom
                 name  the action's name
                 data  details, for example where and what

crashes.json - one entry per crash the game reported at its next start
  crash_id, session_id   The report's id, and the session that sent it.
  crashed_session_id     The session that crashed, if known.
  game_version, signal, os, received
                         The version, how it ended (e.g. SIGSEGV or 'unclean exit'), the system,
                         and when we got the report.
  events                 How many of the last events came with it.
  log_file               The file with the game's log and last events.

crashes/<crash_id>.json - the crash's details
  log_tail      The end of the game's log file (at most 64 KB).
  last_events   Up to 500 events from just before the crash, as in events/ above.

Questions: privacy@fourgames.se
"""

# Columns shown as times, and columns holding JSON text.
TIME_COLUMNS = {"created", "updated", "started", "ended", "last_seen", "received"}
JSON_COLUMNS = {"previous_crash", "summary", "data", "last_progress"}
# Internal bookkeeping a player doesn't need (the pid is in player.json; paths are ours).
HIDDEN_COLUMNS = {"pid", "path", "bytes"}
BOOL_COLUMNS = {"opted_out", "consent_hardware", "steam_deck"}


def clean_row(row) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in row.keys():
        if key in HIDDEN_COLUMNS:
            continue
        value = row[key]
        if key in TIME_COLUMNS:
            value = iso(value)
        elif key in JSON_COLUMNS and value is not None:
            try:
                value = json.loads(value)
            except ValueError:
                pass
        elif key in BOOL_COLUMNS and value is not None:
            value = bool(value)
        out[key] = value
    return out


def dump(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def build(data_dir: str | Path, pid: str, link_months: int) -> IO[bytes]:
    """The zip, in a temporary file (already deleted from the folder; it goes away when closed),
    positioned at its start. Run it in a thread."""
    store = Store(data_dir)
    out = tempfile.TemporaryFile(dir=store.root / "tmp")
    try:
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.writestr("README.txt", README.replace("{link_months}", str(link_months)))
            player = store.player(pid)
            archive.writestr("player.json", dump({
                "pid": pid,
                "opted_out": bool(player and player["opted_out"]),
                "created": iso(player["created"]) if player else None,
                "updated": iso(player["updated"]) if player else None,
            }))
            for table in ("sessions", "hardware", "settings"):
                archive.writestr(f"{table}.json", dump([clean_row(row) for row in store.rows(table, pid)]))

            crashes = []
            for row in store.rows("crashes", pid):
                entry = clean_row(row)
                entry["log_file"] = None
                if row["path"]:
                    try:
                        log = read_gzip_json(store.root / row["path"])
                    except (OSError, ValueError):
                        log = None  # the file is missing or damaged: the row still says what it was
                    if log is not None:
                        name = f"crashes/{row['crash_id']}.json"
                        archive.writestr(name, dump({k: log.get(k) for k in ("log_tail", "last_events")}))
                        entry["log_file"] = name
                crashes.append(entry)
            archive.writestr("crashes.json", dump(crashes))

            for row in store.rows("batches", pid):
                try:
                    with gzip.open(store.root / row["path"], "rb") as file:
                        batch = json.loads(file.read())
                except (OSError, ValueError):
                    continue
                batch["received"] = iso(batch.get("received"))
                archive.writestr(f"events/{row['app_id']}/{row['session_id']}/{row['seq']}.json",
                                 json.dumps(batch, ensure_ascii=False))
    except BaseException:
        out.close()
        raise
    finally:
        store.close()
    out.seek(0)
    return out
