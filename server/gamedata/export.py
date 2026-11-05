"""A player's download: everything stored for their pid, as JSON files in a zip, with a README.

Built in a worker thread with its own database connection, into a temporary file under
DATA_DIR/tmp (on disk, not in memory), one batch at a time, so a long play history costs disk for
a moment and very little memory.

Also one session on its own (session()), for the owner's dashboard: the same row and files, put
together the way the replay viewer (godot/fourgames_data/game/replay/export_reader.gd) reads them.
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
  active_s, idle_s, first_session, last_scene, last_screen
                   From the end too: seconds played and away, whether it was the first session on
                   that computer, and the scene and screen it ended on.
  boot_kind, input_type, input_controller, dlc
                   Whether it was a first start or the first after an update, what you played
                   with, and which of the game's DLC you have.
  test             true for a test session: one of our own test accounts trying a game out.

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
                       error (a non-fatal error in the game's scripts), custom,
                       perf (frame rate and memory, about every 30 seconds), load (loading
                       times), input (keyboard, controller or touch), idle (away or back),
                       setting_changed, screen and ui (menus), position (where you were),
                       death, overlay (the Steam overlay), steam, achievement
                 name  the action's name
                 data  details, for example where and what
  test         true when the session was a test session (see sessions.json).

crashes.json - one entry per crash the game reported at its next start
  crash_id, session_id   The report's id, and the session that sent it.
  crashed_session_id     The session that crashed, if known.
  game_version, signal, os, received
                         The version, how it ended (e.g. SIGSEGV or 'unclean exit'), the system,
                         and when we got the report.
  events                 How many of the last events came with it.
  test                   Whether the session that reported it was a test session.
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
BOOL_COLUMNS = {"opted_out", "consent_hardware", "steam_deck", "test"}


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
            # What a test session sent says so too, so a file read on its own can't be mistaken.
            tests = store.test_session_ids(pid)

            crashes = []
            for row in store.rows("crashes", pid):
                entry = clean_row(row)
                entry["test"] = row["session_id"] in tests
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
                if row["session_id"] in tests:
                    batch["test"] = True
                archive.writestr(f"events/{row['app_id']}/{row['session_id']}/{row['seq']}.json",
                                 json.dumps(batch, ensure_ascii=False))
    except BaseException:
        out.close()
        raise
    finally:
        store.close()
    out.seek(0)
    return out


# One session, for GET /v1/admin/sessions/<id>

# A session whose event files add up to more than this (gzipped) isn't put together in memory.
MAX_SESSION_GZ = 64 * 1024 * 1024


class SessionTooLarge(Exception):
    pass


def _crash_entry(store: Store, row, test: bool) -> dict[str, Any]:
    """A crashes.json entry, with its log (log_tail, last_events) in it rather than in a file."""
    entry = clean_row(row)
    entry["test"] = test
    entry["log_file"] = None
    if row["path"]:
        try:
            log = read_gzip_json(store.root / row["path"])
        except (OSError, ValueError):
            log = None
        if isinstance(log, dict):
            entry["log_tail"] = log.get("log_tail")
            entry["last_events"] = log.get("last_events", [])
    return entry


def session(data_dir: str | Path, session_id: str) -> dict[str, Any] | None:
    """The session as one JSON object, None if there's none with that id: its sessions.json row
    (as in the download) with, as export_reader.gd attaches them to a session it reads,
      events    every batch's events, in seq order (as sent; the viewer sorts them by t)
      hardware  its hardware.json row, or {}
      settings  the settings it started with (settings.json's data), or {}
      crashes   the crash reports about this session, each a crashes.json entry plus log_tail and
                last_events
      reported  the crash report this session sent about an earlier one, or {}
    No pid in it. Run it in a thread; SessionTooLarge past MAX_SESSION_GZ of event files."""
    store = Store(data_dir)
    try:
        db = store.db
        row = db.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
        if row is None:
            return None
        test = bool(row["test"])
        out = clean_row(row)
        batches = db.execute("SELECT seq, path, bytes FROM batches WHERE session_id = ? ORDER BY seq",
                             (session_id,)).fetchall()
        if sum(b["bytes"] for b in batches) > MAX_SESSION_GZ:
            raise SessionTooLarge(session_id)
        events: list[Any] = []
        for batch in batches:
            try:
                data = read_gzip_json(store.root / batch["path"])
            except (OSError, ValueError):
                continue  # missing or damaged, as the download skips it
            if isinstance(data, dict) and isinstance(data.get("events"), list):
                events.extend(data["events"])
        out["events"] = events
        hardware = db.execute("SELECT * FROM hardware WHERE session_id = ?", (session_id,)).fetchone()
        out["hardware"] = clean_row(hardware) if hardware else {}
        settings = db.execute("SELECT data FROM settings WHERE session_id = ?", (session_id,)).fetchone()
        try:
            data = json.loads(settings["data"]) if settings else {}
        except ValueError:
            data = {}
        out["settings"] = data if isinstance(data, dict) else {}
        # The reports about it came from the same player's next launch, which may or may not be a test one.
        def reporter_test(crash) -> bool:
            found = db.execute("SELECT test FROM sessions WHERE session_id = ?", (crash["session_id"],)).fetchone()
            return bool(found and found["test"])

        out["crashes"] = [_crash_entry(store, crash, reporter_test(crash)) for crash in db.execute(
            "SELECT * FROM crashes WHERE crashed_session_id = ? ORDER BY received", (session_id,)).fetchall()]
        reported = db.execute("SELECT * FROM crashes WHERE session_id = ?", (session_id,)).fetchone()
        out["reported"] = _crash_entry(store, reported, test) if reported else {}
        return out
    finally:
        store.close()
