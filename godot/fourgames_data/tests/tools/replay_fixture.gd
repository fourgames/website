extends RefCounted

## A small data download as server/gamedata/export.py writes one, as
## {name in the zip: text}, for the replay viewer's tests:
##
##   A  the test game, a test session: level 1 (moves, a stand-still, a coin, a
##      death, a respawn, a setting change, perf, done), then level 2 and an
##      error. Its batches are listed out of order.
##   B  another game (app 999), older, in 3D, no end: the session A's launch
##      reported a crash of.

const A := "aaaaaaaa-0000-4000-8000-000000000001"
const B := "bbbbbbbb-0000-4000-8000-000000000002"
const L1 := "res://game/level_1.tscn"
const L2 := "res://game/level_2.tscn"
const WORLD := "res://world.tscn"


static func batch_0() -> Array:
	return [
		{"t": 0.0, "type": "load", "name": "boot", "data": {"boot_kind": "normal", "boot_ms": 812, "to_play_ms": 900, "by": "mark_playing"}},
		{"t": 0.5, "type": "screen", "data": {"name": "", "from": "title"}},
		{"t": 1.0, "type": "load", "name": "scene", "data": {"scene": L1, "from": "res://game/title.tscn", "ms": 12.5}},
		{"t": 1.0, "type": "position", "data": {"scene": L1, "x": 80.0, "y": 336.0, "rot": 0.0}},
		{"t": 1.0, "type": "progress", "data": {"level": "level_1", "coins": 0, "deaths": 0}},
		{"t": 1.5, "type": "position", "data": {"scene": L1, "x": 100.0, "y": 336.0, "rot": 0.0}},
		{"t": 2.0, "type": "position", "data": {"scene": L1, "x": 120.0, "y": 336.0, "rot": 0.0}},
		{"t": 5.0, "type": "position", "data": {"scene": L1, "x": 200.0, "y": 336.0, "rot": 0.0}},
		{"t": 5.2, "type": "action", "name": "coin", "data": {"level": "level_1", "coin": 0, "x": 208.0, "y": 144.0, "level_coins": 1, "coins": 1}},
		{"t": 6.0, "type": "death", "data": {"cause": "spikes", "level": "level_1", "coins": 1, "scene": L1, "x": 400.0, "y": 208.0, "rot": 0.0}},
	]


static func batch_1() -> Array:
	return [
		{"t": 6.7, "type": "action", "name": "respawn", "data": {"level": "level_1", "level_deaths": 1}},
		{"t": 6.7, "type": "position", "data": {"scene": L1, "x": 80.0, "y": 336.0, "rot": 0.0}},
		{"t": 7.2, "type": "position", "data": {"scene": L1, "x": 100.0, "y": 336.0, "rot": 0.0}},
		{"t": 10.0, "type": "setting_changed", "data": {"key": "volume", "old": 0.8, "new": 0.5}},
		{"t": 20.0, "type": "perf", "data": {"why": "interval", "scene": L1, "screen": "", "frames": 1200, "fps_avg": 60.0,
				"fps_1pct_low": 50.0, "frame_ms_max": 30.0, "slow_frames": 0}},
		{"t": 25.0, "type": "perf", "data": {"why": "interval", "scene": L1, "screen": "pause", "frames": 300, "fps_avg": 30.0,
				"fps_1pct_low": 20.0, "frame_ms_max": 70.0, "slow_frames": 2}},
		{"t": 30.0, "type": "action", "name": "level_complete", "data": {"level": "level_1", "time_s": 29.0, "coins": 1, "coins_max": 8, "deaths": 1}},
		{"t": 31.0, "type": "load", "name": "scene", "data": {"scene": L2, "from": L1, "ms": 8.0}},
		{"t": 31.0, "type": "position", "data": {"scene": L2, "x": 80.0, "y": 560.0, "rot": 0.0}},
		{"t": 35.0, "type": "error", "name": "script_error", "data": {"message": "boom", "file": "res://game/level.gd", "line": 3, "function": "_touch"}},
	]


static func files() -> Dictionary:
	var sessions := [
		{"session_id": B, "app_id": 999, "started": "2026-10-01T10:00:00Z", "ended": null, "game_version": "0.3",
				"platform": "windows", "playtime_s": null, "summary": null},
		{"session_id": A, "app_id": 5207970, "started": "2026-11-05T14:00:00Z", "ended": "2026-11-05T14:01:00Z",
				"game_version": "1.0.0", "build_id": "26413834", "godot_version": "4.7.0", "platform": "macos",
				"locale": "en", "country": "SE", "playtime_s": 40.0, "active_s": 38.0, "idle_s": 2.0, "test": true,
				"last_scene": L2, "summary": {"events": 21, "actions": 3, "errors": 1, "session_number": 4,
				"boot_kind": "normal", "playtime_s": 40}},
	]
	var events_b := [
		{"t": 1.0, "type": "position", "data": {"scene": WORLD, "x": 0.0, "y": 1.0, "z": 0.0, "yaw": 0.0}},
		{"t": 4.0, "type": "position", "data": {"scene": WORLD, "x": 10.0, "y": 1.0, "z": 5.0, "yaw": 0.0}},
		{"t": 9.0, "type": "death", "data": {"cause": "fell", "scene": WORLD, "x": 12.0, "y": -3.0, "z": 6.0, "yaw": 0.0}},
		{"t": 12.5, "type": "action", "name": "jump", "data": {}},
	]
	return {
		"player.json": JSON.stringify({"pid": "p", "opted_out": false}),
		"sessions.json": JSON.stringify(sessions),
		"hardware.json": JSON.stringify([{"session_id": A, "os": "macOS Tahoe (26.1)", "cpu": "Apple M2",
				"cpu_cores": 8, "ram_mb": 16384, "gpu": "Apple M2", "gpu_driver": "", "renderer": "gl_compatibility",
				"screen_w": 2560, "screen_h": 1440, "refresh_hz": 120.0, "steam_deck": false}]),
		"settings.json": JSON.stringify([{"session_id": A, "data": {"volume": 0.8, "show_fps": false, "window_mode": "windowed"}}]),
		"crashes.json": JSON.stringify([{"crash_id": "c1", "session_id": A, "crashed_session_id": B, "signal": "SIGSEGV",
				"received": "2026-11-05T14:00:01Z", "test": true, "log_file": "crashes/c1.json"}]),
		"crashes/c1.json": JSON.stringify({"log_tail": "starting\nloading world\nProgram crashed with signal 11", "last_events": []}),
		"events/5207970/%s/1.json" % A: JSON.stringify({"session_id": A, "seq": 1, "app_id": 5207970, "events": batch_1(), "test": true}),
		"events/5207970/%s/0.json" % A: JSON.stringify({"session_id": A, "seq": 0, "app_id": 5207970, "events": batch_0(), "test": true}),
		"events/999/%s/0.json" % B: JSON.stringify({"session_id": B, "seq": 0, "app_id": 999, "events": events_b}),
	}
