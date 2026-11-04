# fourgames_data, the test project

A minimal Godot 4.7 project around the `addons/fourgames_data` addon (see its
README for what it does and how to add it to a game). The games copy
`addons/fourgames_data/` and nothing else.

- `demo/demo.tscn`, the main scene: a stand-in game that calls the API the way
  a real one would. This project has no GodotSteam, so the plugin reports "off"
  here; it shows where each call goes.
- `tests/`: the suites (`test_*.gd`) on a tiny harness of their own
  (`tests/tools/suite.gd`), with a fake transport and a fake Steam.

Run them from a copy of the folder, so the editor's `.godot/` cache stays out of
the repo:

```sh
G="$HOME/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot"
cp -Rc godot/fourgames_data /tmp/fgd && cd /tmp/fgd
"$G" --headless --path . --import
"$G" --headless --path . res://tests/tools/run_tests.tscn [-- <suite> [<test>]]
G="$G" sh tests/tools/live_check.sh .
```

`run_tests` prints `TESTS: N passed, M failed` and exits 0 or 1.
`live_check.sh` starts `tests/tools/fake_server.py`, plays a session over the
real HTTPRequest and the quit's blocking HTTPClient, checks what the server got,
and checks a quit with the server gone stays inside its 1.5 s budget.
