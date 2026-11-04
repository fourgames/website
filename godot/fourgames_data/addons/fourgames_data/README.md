# fourgames_data

Four Games' player game data for Godot 4.7: sessions, what the player did, the
machine and its settings, performance, and crash reports, sent to
`https://api.fourgames.se/gamedata/v1` to improve the games and fix bugs. The
contract it follows is `server/gamedata/SPEC.md` in the website repo.

It never breaks or stalls the game: every failure is quiet (a `GameData:` line
in the log at most), requests run on a thread, and the only wait is at quit,
capped at 1.5 s.

## Adding it to a game

1. Copy this folder to the game's `addons/fourgames_data/`.
2. Enable "Four Games data" in Project Settings > Plugins. That registers the
   autoload `GameData` (or add `GameData="*res://addons/fourgames_data/game_data.gd"`
   under `[autoload]` by hand).
3. Set `application/config/version` in Project Settings: it is the
   `game_version` every session reports (`"unknown"` without it).
4. Once Steam is up (GodotSteam, reached only through
   `Engine.get_singleton("Steam")`, so builds without it still parse), start it:

```gdscript
GameData.start(APP_ID, {"volume": 0.8, "fullscreen": true, "language": "sv"})
```

`APP_ID` is the Steam app id of the build that runs. A demo build passes the
demo's app id and the full game its own; nothing else differs. The plugin does
not run Steam's callbacks: the game's Steam code must call
`Steam.run_callbacks()` every frame (or initialise with embedded callbacks), or
the ticket never arrives.

## The calls

| Call | What it is |
|---|---|
| `GameData.start(app_id, settings)` | Once a run, after Steam is up. Later calls are ignored. |
| `GameData.action(name, data)` | Something the player did: `action("plant_seed", {"x": 3, "crop": "carrot"})`. |
| `GameData.progress(data)` | How far they are: `{"day": 4, "coins": 120}`. The last one is also in the session's summary. |
| `GameData.snapshot(data)` | A small state summary; call it every ~30 s. |
| `GameData.set_setting(key, value)` | A setting changed. Before `start()` it only fills in the session's settings. |
| `GameData.screen(name)` | The menu or screen now up (`"main_menu"`, `"options"`). Optional. |
| `GameData.mark_playing()` | The player can actually play: the end of the boot. Optional; without it the first scene change after the main scene stands in. |
| `GameData.loaded(what, ms)` | A load the game timed itself (a threaded one). Optional. |
| `GameData.rng(name, seed)` / `GameData.custom(name, data)` | A seed rolled from; anything else. |
| `GameData.opted_out()` / `GameData.set_opt_out(on)` | For a game that shows its own switch. Optional: players opt out on the website or with `/privacy` in the Discord bot, and the server tells the game at session start. |
| `GameData.PRIVACY_URL` | `https://fourgames.se/privacy`, for a "Privacy" link. |
| `GameData.share_hardware` | Set false before `start()` to send no machine, settings or controller details (`consent.hardware`). |

Data values may be numbers, strings, bools, `Vector2`/`Vector2i` (sent as
`[x, y]`), arrays and dictionaries a few levels deep; objects are dropped.

## What it records by itself

Each is an event in the `/v1/events` batches, with no call from the game:

| Type | When | Data |
|---|---|---|
| `perf` | every 30 s, at each scene change and at quit | `scene`, `screen`, `why`, `frames`, `fps_avg`, `fps_1pct_low` (fps of the 99th-percentile frame), `frame_ms_max`, `slow_frames` (over 50 ms), `static_mb` (debug builds only), `video_mb`, `focused`, `idle`. Frames are only counted while the window has focus. |
| `load` `"scene"` | each scene change | `scene`, `from`, `ms` (the frame the change took, which holds a `change_scene_to_file()` load) |
| `load` `"boot"` | once | `boot_kind` (`first_install`, `first_after_update`, `normal`), `boot_ms` (engine start to the first frame with a scene), `to_play_ms` (to `mark_playing()`, else the first scene change; null if neither happened), `by`, `init_ms` (engine start to this autoload) |
| `input` | at start and on every switch | `type` (`keyboard_mouse`, `controller`, `touch`), and with hardware consent `controller` (`Input.get_joy_name`), `steam_input` (Steam Input's type, when the game called `Steam.inputInit()`), `deck_mode` (`handheld`/`docked` on a Steam Deck) |
| `idle` | focus lost, or no input for 60 s, and back | `idle`, `why` (`unfocused`, `no_input`), `after_s` (how long the state before lasted) |
| `setting_changed` | `set_setting()` with a new value | `key`, `old`, `new` (hardware consent only) |
| `screen` | `screen(name)` | `name`, `from` |
| `error` | a script or engine error, once each per session (50 at most) | `message`, `file`, `line`, `function`; repeats are counted in the summary |

`/session/start` also carries `boot_kind`, `first_session`, `input` (hardware
consent only) and `dlc` (`[{app_id, owned}]` from Steam's DLC list), and
`/session/end`'s `summary` carries `events`, `actions`, `errors`, `progress`,
`last_scene`, `last_screen`, `playtime_s`, `active_s`, `idle_s`,
`first_session`, `session_number` and `boot_kind`. Its `seq` is the number of
event batches the session sent.

Hardware is `os`, `cpu`, `cpu_cores`, `ram_mb`, `gpu`, `gpu_driver`,
`renderer`, `screen`, `refresh_hz` and `steam_deck`, and nothing else: no
serial numbers, MAC addresses, device ids or `OS.get_unique_id()`.

## How it works

- **Session.** `start()` asks Steam for a Web API ticket
  (`getAuthTicketForWebApi("fourgames-gamedata")`, answered by the
  `get_ticket_for_web_api` signal), sends it to `/session/start`, and cancels
  the ticket once the server has answered. If the player opted out, nothing more
  is kept or sent this run and what was kept is deleted; the next launch keeps
  everything in memory until the server says they are in again.
- **Batches.** Events are buffered from the first call. Every `upload_every_s`
  (the server says; 60 s until it does), or at 2000 events, the buffer is cut
  into a batch, gzipped (`PackedByteArray.compress(FileAccess.COMPRESSION_GZIP)`)
  and written to `user://fourgames_data/queue/`. The queue goes out oldest first,
  one request at a time, with `Content-Encoding: gzip`, backing off from 5 s to
  10 min while the server can't be reached. Past 20 MB the oldest batch is
  dropped. A batch from an offline run is sent on a later launch (its session
  is started then, with a fresh ticket); one older than its 24 h token is
  dropped.
- **Quit.** At `_exit_tree` (the last thing any node hears at quit) the last
  batch and `/session/end` are written down and, if the server was answering,
  sent at once over a blocking connection with one 1.5 s deadline for all of
  it. What doesn't make it goes on the next launch. A close request the game
  calls off ("Quit?") only writes the batch.
- **Crashes.** `start()` writes `running.json` and keeps the last 500 events in
  `ring.jsonl` (flushed once a frame); a clean quit removes `running.json`.
  Finding it at the next `start()` means that run never quit: its ring, the
  last 64 KB of the log it left (Godot renames `godot.log` to `godot<date>.log`
  at each start, so it is that one), the signal the log names (`SIGSEGV`, or
  `unclean exit` when the log says nothing) and where it was (`quit_point`) go to
  `/crash` under the new session's token, and the new session's
  `previous_crash` names it. The player's home folder is scrubbed from the log.
- **Off** in the editor, in debug builds and in tests unless
  `FOURGAMES_DATA_DEV=1`; `FOURGAMES_DATA_URL` (e.g.
  `http://127.0.0.1:8103/v1`) points it at another server.

Files in `user://fourgames_data/`: `queue/`, `sessions.json` (the sessions
still owed), `ring.jsonl`, `running.json` and `prefs.cfg` (the player's own
opt-out, the server's last answer, the launch count and last version, for
`boot_kind`).

## Testing

The project this addon lives in (`godot/fourgames_data` in the website repo)
holds its tests: `tests/tools/run_tests.tscn` runs every suite headless with a
fake transport and a fake Steam, and `tests/tools/live_check.sh` runs it over
a real network against `tests/tools/fake_server.py`.
