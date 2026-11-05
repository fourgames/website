extends "res://tests/tools/suite.gd"

## "Copy for Claude": what the summary of a session says, and that its JSON part
## parses and stays inside its cap.

const ExportReader := preload("res://game/replay/export_reader.gd")
const Summary := preload("res://game/replay/summary.gd")
const Fixture := preload("res://tests/tools/replay_fixture.gd")


func _sessions() -> Array:
	return ExportReader.parse(Fixture.files()).sessions


func _json_part(text: String) -> Variant:
	var at := text.find(Summary.JSON_MARK)
	assert_true(at >= 0, "the JSON part is marked")
	return JSON.parse_string(text.substr(at + Summary.JSON_MARK.length()))


func test_a_test_game_session() -> void:
	var text := Summary.build(_sessions()[0])
	var lines := text.split("\n")
	assert_true(lines[0].begins_with("Here is a play session from the fourgames_data test project"), lines[0])
	for expected: String in [
			"id %s, app 5207970, a TEST session" % Fixture.A,
			"started 2026-11-05T14:00:00Z, length 0:40 (active 0:38, idle 0:02)",
			"game 1.0.0 (build 26413834), Godot 4.7.0, macos, locale en, from SE",
			"ended cleanly at 2026-11-05T14:01:00Z on res://game/level_2.tscn",
			"end summary: 21 events, 3 actions, 1 errors, session 4 on this install (normal)",
			"level_1 \"First steps\": entered 0:01, completed at 0:30 (29 s on the level), coins 1/8, deaths 1",
			"level_2 \"Saw mill\": entered 0:31, not completed, coins 0/10, deaths 0",
			"total: 1 coins, 1 deaths",
			"0:06 level_1, spikes at (400, 208)",
			"at start: show_fps=false, volume=0.8, window_mode=windowed",
			"0:10 volume: 0.8 -> 0.5",
			"boot: 812 ms to the first frame, 900 ms to playable (normal)",
			"level_1: 60.0 fps avg, min (1% low) 50.0, worst frame 30.0 ms, 0 stutters (frames over 50 ms), 1200 frames",
			"level_1, pause screen: 30.0 fps avg, min (1% low) 20.0, worst frame 70.0 ms, 2 stutters (frames over 50 ms), 300 frames",
			"macOS Tahoe (26.1) | Apple M2 (8 cores) | 16 GB RAM | Apple M2 | gl_compatibility | 2560x1440 @ 120 Hz",
			"0:35 script_error: boom (res://game/level.gd:3 in _touch)",
			"this launch reported a crash of session %s (SIGSEGV)" % Fixture.B]:
		assert_true(expected in lines, "missing: " + expected)
	var events: Variant = _json_part(text)
	assert_true(events is Array, "the JSON parses")
	var types: Array = events.map(func(e: Dictionary) -> String: return e.type)
	assert_false("position" in types, "positions are left out")
	assert_false("perf" in types, "perf is summed up above instead")
	assert_true("death" in types and "action" in types and "setting_changed" in types and "load" in types)
	assert_true(text.contains("\"coin\":0,") and not text.contains("\"coin\":0.0"), "whole numbers stay whole")


func test_another_game_s_session() -> void:
	var text := Summary.build(_sessions()[1])
	var lines := text.split("\n")
	assert_true(lines[0].begins_with("Here is a play session of Steam app 999"), lines[0])
	assert_true("no end received (the game crashed, was killed, or is still uploading)" in lines)
	assert_true("1 actions, 1 deaths" in lines)
	assert_true("0:09 res://world.tscn, fell at (12, 6)" in lines)
	assert_true("not sent (no hardware consent, or none in the download)" in lines)
	assert_true("this session crashed: SIGSEGV, reported 2026-11-05T14:00:01Z by session %s" % Fixture.A in lines)
	assert_true("  Program crashed with signal 11" in lines)
	assert_true("no perf events" in lines and "no changes" in lines)


func test_the_json_stays_inside_its_cap() -> void:
	var events: Array = []
	for i in 3000:
		events.append({"t": float(i), "type": "action", "name": "step", "data": {"i": i, "note": "x".repeat(40)}})
		events.append({"t": float(i), "type": "screen", "data": {"name": "s%d" % i}})
	var text := Summary.key_events_json(events)
	assert_true(text.to_utf8_buffer().size() <= Summary.JSON_CAP, "%d bytes" % text.length())
	var parsed: Variant = JSON.parse_string(text)
	assert_true(parsed is Array)
	assert_true(int(parsed[-1].get("left_out", 0)) > 0, "what did not fit is counted")
	assert_eq(parsed[0].type, "action", "the game's own events go first when not all fit")
	assert_false(parsed.any(func(e: Dictionary) -> bool: return e.get("type") == "screen"))
	# Small enough: everything key goes in, and nothing is said to be left out.
	var small := Summary.key_events_json(events.slice(0, 10))
	assert_eq(JSON.parse_string(small).size(), 10)


func test_a_scene_change_s_perf_goes_with_its_scene() -> void:
	var perf := func(t: float, why: String, scene: String, screen: String, fps: float) -> Dictionary:
		return {"t": t, "type": "perf", "data": {"why": why, "scene": scene, "screen": screen, "frames": 100,
				"fps_avg": fps, "fps_1pct_low": fps, "frame_ms_max": 10.0, "slow_frames": 0}}
	var lines := Summary._perf_part([
		perf.call(1.0, "scene_change", "res://game/title.tscn", "title", 100.0),
		perf.call(30.0, "interval", "res://game/level_1.tscn", "", 60.0),
		# Said as the viewer came up, about the level's last frames.
		perf.call(40.0, "scene_change", "res://game/level_1.tscn", "replay_viewer", 60.0),
		perf.call(70.0, "interval", "res://game/replay/viewer.tscn", "replay_viewer", 120.0),
	])
	assert_true(lines[1].begins_with("title: 100.0 fps avg"), lines[1])
	assert_true(lines[2].begins_with("level_1: 60.0 fps avg") and lines[2].ends_with("200 frames"), lines[2])
	assert_true(lines[3].begins_with("viewer, replay_viewer screen: 120.0 fps avg"), lines[3])
	assert_eq(lines.size(), 5, "three lines and the gap after them")
