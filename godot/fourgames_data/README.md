# fourgames_data, the test project

A small Godot 4.7 project around the `addons/fourgames_data` addon (see its
README for what it does and how to add it to a game). The games copy
`addons/fourgames_data/` and nothing else.

- `game/`, the main scene: a tiny top-down test game that uses the addon the
  way a real game does, through real Steam to the live game-data API, and a
  replay viewer for the data you get back (below).
- `demo/demo.tscn`: a stand-in that shows where each call goes. It doesn't bring
  Steam up, so the plugin stays off there.
- `addons/godotsteam/`: GodotSteam 4.22.1 (GDExtension), macOS, Windows and
  Linux 64-bit only. Its ~30 MB of binaries aren't in git: after a fresh clone run
  `sh godot/fourgames_data/tools/get_godotsteam.sh` (copies them from
  ../Pomo-Valley). Everything else in the project still parses and its tests pass
  without them.
- `tests/`: the suites (`test_*.gd`) on a tiny harness of their own
  (`tests/tools/suite.gd`), with a fake transport and a fake Steam.

## Playing a test session

1. Steam running and signed in to the account that owns Pomo Valley (the test
   game sends as app 5207970; `steam_appid.txt` says so).
2. The server must take it as a test session: `GAMEDATA_TEST_APP_IDS=5207970`
   and your SteamID64 in `GAMEDATA_TEST_STEAMIDS` (server/gamedata/README.md,
   "Test mode"). Anyone else's session start is refused as an unknown app.
3. Open `project.godot` in Godot 4.7 and press Play (F5). The title comes up:
   Play, Replay viewer, Quit.
4. Two short levels: WASD, the arrows or a gamepad to move; take the yellow
   coins, keep off the red spikes and the orange saws, reach the green. Esc (or
   Start) pauses: volume, Show FPS, Windowed/Fullscreen, Quit. F1 shows the
   data panel: Steam, the plugin's state, the session id, what is queued, the
   last upload and its answer, opted out or not.
5. Quit from the title or the pause menu: the session's end goes out as the
   game closes.

What it sends: `screen()` for the title, each level (`level_1`, `level_2`), pause and viewer; the player's position
every 0.5 s while moving (`track_player`, again after each respawn); `death`
(spikes or saw); `action` `coin`, `respawn`, `level_complete`; `progress` at
each level's start and end; `snapshot` (level, place, coins, deaths) at each
level's start and every 30 s; `setting_changed` for the three settings; and what
the plugin records by itself (perf, loads, input, idle, errors).

Whether it records in an editor or debug run is the project setting
`fourgames_data_test/collect_in_debug` (on), or `FOURGAMES_DATA_DEV=1`.
`fourgames_data_test/base_url`, or `FOURGAMES_DATA_URL`, points it at another
server than `https://api.fourgames.se/gamedata/v1`. A headless run leaves Steam
alone unless given `-- --steam`; `-- --fake-steam` uses the tests' stand-in
(only for a local server); `-- --no-steam` turns Steam off.

## Getting the data back, and the replay viewer

1. On https://fourgames.se/privacy: Sign in with Steam, then Download. That
   gives `fourgames-data.zip` (every session, its events, hardware, settings and
   crashes; test sessions say `"test": true`).
2. In the game: Replay viewer, then "Open download…" and pick the zip (or the
   `sessions.json` of an unzipped one; or drop the file on the window). Or, for
   anyone's session: on the feedback dashboard (fourgames.se/fb-dash, the owner's
   Steam sign-in), Game data, pick the session, "Copy for replay"; then "Paste
   session" here.
3. Pick a session (date, length, app, TEST, events). Play/Pause, 1×/4×/16×, and
   the timeline to scrub: a tick per coin (yellow), death (red), level complete
   (green), setting change (purple), error (pink). The events on the right
   follow the replay; click one to jump to it. Heatmap shows where the player
   spent their time; deaths are red crosses. Sessions of other games (no level
   known here) are drawn as their path on a grid, 3D ones from above.
4. "Copy for Claude" puts a summary on the clipboard and shows it too: the
   session, the levels, coins, deaths (where, when), settings and their
   changes, fps per scene and screen, the machine, errors and crashes, and the
   key events as JSON (about 15 KB at most). Paste it into a chat. The dashboard's
   "Copy for Claude" gives the same text: the server builds it with a port of
   `summary.gd` (`server/gamedata/summary.py`).

Without the editor:

```sh
G="$HOME/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot"
"$G" --path godot/fourgames_data res://game/replay/viewer.tscn -- --no-steam --open ~/Downloads/fourgames-data.zip
"$G" --headless --path godot/fourgames_data --script res://tests/tools/summarise.gd -- ~/Downloads/fourgames-data.zip [<session>]
```

The second prints the "Copy for Claude" text (session 0 is the newest).

## Tests

Run them from a copy of the folder, so the editor's `.godot/` cache stays out of
the repo:

```sh
G="$HOME/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot"
cp -Rc godot/fourgames_data /tmp/fgd && cd /tmp/fgd
"$G" --headless --path . --import
"$G" --headless --path . res://tests/tools/run_tests.tscn [-- <suite> [<test>]]
G="$G" sh tests/tools/live_check.sh .
G="$G" sh tests/tools/play_check.sh .
```

`run_tests` prints `TESTS: N passed, M failed` and exits 0 or 1: the addon's
suites, the levels (every coin and goal reachable), the replay reader and
timeline (`test_replay`, with Paste session) and the summary (`test_summary`).
`test_summary` also checks that `summary.gd` still writes
`tests/fixtures/summary/<session>.txt` for each session of
`tests/fixtures/summary_sessions.json`; the server's port is tested against the
same files. After changing `summary.gd` on purpose, write them again from a copy
(`"$G" --headless --path . --script res://tests/tools/summary_golden.gd -- "$PWD/tests/fixtures/summary"`,
then copy that folder back) and port the change to `server/gamedata/summary.py`
until `python -m pytest gamedata/tests/test_admin.py` passes.
`live_check.sh` starts `tests/tools/fake_server.py`, plays a session over the
real HTTPRequest and the quit's blocking HTTPClient, checks what the server got,
and checks a quit with the server gone stays inside its 1.5 s budget.
`play_check.sh` plays the test game headless against that server with the
stand-in Steam (walking, a coin, deaths, the pause menu, both levels, the
viewer) and checks that a whole session with all of its events arrived.
