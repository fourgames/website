extends "res://tests/tools/suite.gd"

## The replay viewer's reading and timing: a data download (zip, unzipped
## folder, or a JSON of sessions) into sessions, and a session into where the
## player was when, their paths, deaths, ticks and the event list.

const ExportReader := preload("res://game/replay/export_reader.gd")
const Timeline := preload("res://game/replay/timeline.gd")
const Fixture := preload("res://tests/tools/replay_fixture.gd")


func _sessions() -> Array:
	var result := ExportReader.parse(Fixture.files())
	assert_true(result.ok, str(result.error))
	return result.sessions


func _a() -> Dictionary:
	return _sessions()[0]


#region Reading
func test_a_download_becomes_sessions_newest_first() -> void:
	var sessions := _sessions()
	assert_eq(sessions.size(), 2)
	var a: Dictionary = sessions[0]
	var b: Dictionary = sessions[1]
	assert_eq(a.session_id, Fixture.A)
	assert_eq(a.app_id, 5207970)
	assert_eq(a.test, true)
	assert_eq(b.test, false, "an older download has no test field: not a test")
	assert_eq(a.events.size(), Fixture.batch_0().size() + Fixture.batch_1().size())
	assert_eq(a.hardware.gpu, "Apple M2")
	assert_eq(a.settings, {"volume": 0.8, "show_fps": false, "window_mode": "windowed"})
	assert_eq(b.hardware, {})
	assert_eq(a.duration, 40.0, "what the game said it played")
	assert_eq(b.duration, 12.5, "no end: the last event")
	assert_eq(b.crashes.size(), 1)
	assert_eq(b.crashes[0].signal, "SIGSEGV")
	assert_true(str(b.crashes[0].log_tail).contains("signal 11"))
	assert_eq(a.reported.crashed_session_id, Fixture.B)


func test_events_come_in_batch_order_then_by_time_ties_kept() -> void:
	var events: Array = _a().events
	var times: Array = events.map(func(e: Dictionary) -> float: return e.t)
	var sorted := times.duplicate()
	sorted.sort()
	assert_eq(times, sorted)
	# Three events at t = 1.0, in the order the game made them.
	assert_eq([events[2].type, events[3].type, events[4].type], ["load", "position", "progress"])
	# The respawn and its position share t = 6.7 across the batch boundary.
	assert_eq([events[10].name, events[11].type], ["respawn", "position"])


func test_the_zip_itself_opens() -> void:
	var path := scratch.path_join("fourgames-data.zip")
	var zip := ZIPPacker.new()
	assert_eq(zip.open(path), OK)
	var files := Fixture.files()
	files["README.txt"] = "Your Four Games game data"
	for name: String in files:
		zip.start_file(name)
		zip.write_file(str(files[name]).to_utf8_buffer())
		zip.close_file()
	zip.close()
	var result := ExportReader.open(path)
	assert_true(result.ok, str(result.error))
	assert_eq(result.sessions.size(), 2)
	assert_eq(result.sessions[0].events.size(), _a().events.size())


func test_an_unzipped_download_opens_from_its_sessions_json() -> void:
	var folder := scratch.path_join("fourgames-data")
	var files := Fixture.files()
	for name: String in files:
		var at := folder.path_join(name)
		DirAccess.make_dir_recursive_absolute(at.get_base_dir())
		var file := FileAccess.open(at, FileAccess.WRITE)
		file.store_string(str(files[name]))
		file.close()
	var result := ExportReader.open(folder.path_join("sessions.json"))
	assert_true(result.ok, str(result.error))
	assert_eq(result.sessions[0].events.size(), _a().events.size())
	assert_eq(result.sessions[1].crashes.size(), 1)


func test_a_json_of_sessions_with_their_events_opens() -> void:
	var path := scratch.path_join("sessions_with_events.json")
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify({"sessions": [{"session_id": "x", "app_id": 1, "events": [
			{"t": 2.0, "type": "action", "name": "b"}, {"t": 1.0, "type": "action", "name": "a"}]}]}))
	file.close()
	var result := ExportReader.open(path)
	assert_true(result.ok, str(result.error))
	assert_eq(result.sessions[0].events.map(func(e: Dictionary) -> String: return e.name), ["a", "b"])


func test_a_pasted_session_opens() -> void:
	# The dashboard's "Copy for replay": one session from GET /v1/admin/sessions/<id>.
	var rows: Array = JSON.parse_string(FileAccess.get_file_as_string("res://tests/fixtures/summary_sessions.json"))
	var a: Dictionary = rows[0]
	for text: String in [JSON.stringify(a), JSON.stringify({"ok": true, "session": a}),
			JSON.stringify({"sessions": [a]}), "  " + JSON.stringify([a]) + "\n"]:
		var result := ExportReader.parse_json(text)
		assert_true(result.ok, str(result.error))
		assert_eq(result.sessions.size(), 1)
		var session: Dictionary = result.sessions[0]
		assert_eq(session.session_id, Fixture.A)
		assert_eq(session.events.size(), Fixture.batch_0().size() + Fixture.batch_1().size())
		assert_eq(session.duration, 40.0)
		assert_eq(session.hardware.gpu, "Apple M2")
		assert_eq(session.settings.volume, 0.8)
		assert_eq(session.reported.crashed_session_id, Fixture.B, "the crash it reported comes along")
	# (The file as written, not stringified again here: Godot writes a vertical tab as \v,
	# which its own parser then refuses.)
	var both := ExportReader.parse_json(FileAccess.get_file_as_string("res://tests/fixtures/summary_sessions.json"))
	assert_true(both.ok, str(both.error))
	assert_eq(both.sessions.size(), 4)
	var b: Array = both.sessions.filter(func(row: Dictionary) -> bool: return row.session_id == Fixture.B)
	assert_eq(b.size(), 1)
	assert_eq(b[0].crashes[0].log_tail if not b.is_empty() else null, "starting\nloading world\nProgram crashed with signal 11")
	# The same session read from a download and pasted: the same events.
	var from_download: Dictionary = _a()
	var pasted: Dictionary = ExportReader.parse_json(JSON.stringify(a)).sessions[0]
	assert_eq(pasted.events, from_download.events)


func test_what_is_not_a_pasted_session_says_so() -> void:
	for text: String in ["", "hello", "{}", "[1, 2]", JSON.stringify({"ok": false, "error": "not_admin"})]:
		var result := ExportReader.parse_json(text)
		assert_false(result.ok, text)
		assert_true(str(result.error).contains("Copy for replay"), str(result.error))
	# A download's sessions.json on its own: no events to replay.
	var rows: Array = JSON.parse_string(Fixture.files()["sessions.json"])
	var result := ExportReader.parse_json(JSON.stringify(rows))
	assert_false(result.ok)
	assert_true(str(result.error).contains("Open download"), str(result.error))


func test_the_viewer_pastes_a_session() -> void:
	var viewer: Node = load("res://game/replay/viewer.tscn").instantiate()
	(Engine.get_main_loop() as SceneTree).root.add_child(viewer)
	var rows: Array = JSON.parse_string(FileAccess.get_file_as_string("res://tests/fixtures/summary_sessions.json"))
	assert_true(viewer.paste_session(JSON.stringify({"ok": true, "session": rows[1]})))
	assert_eq(viewer.sessions.size(), 1)
	assert_eq(viewer.timeline.session.session_id, Fixture.B)
	assert_false(viewer._copy.disabled, "Copy for Claude works on it too")
	assert_false(viewer.paste_session("not a session"))
	assert_true(viewer._status.text.contains("Copy for replay"), viewer._status.text)
	assert_eq(viewer.sessions.size(), 1, "what was open stays open")
	viewer.free()


func test_what_is_not_a_download_says_so() -> void:
	assert_false(ExportReader.open(scratch.path_join("missing.zip")).ok)
	var text := scratch.path_join("notes.txt")
	var file := FileAccess.open(text, FileAccess.WRITE)
	file.store_string("hello")
	file.close()
	var result := ExportReader.open(text)
	assert_false(result.ok)
	assert_true(str(result.error).contains("fourgames-data.zip"))
	result = ExportReader.parse({"player.json": "{}"})
	assert_false(result.ok)
	assert_true(str(result.error).contains("sessions.json"))
	assert_false(ExportReader.parse({"sessions.json": "{nope"}).ok)
#endregion


#region Timing
func test_the_marker_moves_only_when_the_player_did() -> void:
	var line := Timeline.new(_a())
	assert_eq(line.step, 0.5, "the usual gap between samples")
	assert_false(line.position_at(0.5).ok, "nothing before the first sample")
	assert_eq(line.position_at(1.0).p, Vector2(80, 336))
	assert_eq(line.position_at(1.25).p, Vector2(90, 336))
	# 2.0 -> 5.0: they stood still, then walked for the last half second.
	assert_eq(line.position_at(3.0).p, Vector2(120, 336))
	assert_eq(line.position_at(4.75).p, Vector2(160, 336))
	# Died at 6.0 where the death says; stays there until the respawn.
	assert_eq(line.position_at(6.3).p, Vector2(400, 208))
	assert_eq(line.position_at(6.7).p, Vector2(80, 336), "no slide back to the start")
	assert_eq(line.position_at(32.0).scene, Fixture.L2)
	assert_true(line.position_at(32.0).ok)


func test_scenes_paths_and_deaths() -> void:
	var line := Timeline.new(_a())
	assert_eq(line.scenes(), PackedStringArray([Fixture.L1, Fixture.L2]))
	assert_eq(line.scene_at(0.0), Fixture.L1)
	assert_eq(line.scene_at(30.9), Fixture.L1)
	assert_eq(line.scene_at(31.0), Fixture.L2)
	var paths := line.paths(Fixture.L1)
	assert_eq(paths.size(), 2, "cut at the death")
	assert_eq(paths[0], PackedVector2Array([Vector2(80, 336), Vector2(100, 336), Vector2(120, 336),
			Vector2(200, 336), Vector2(400, 208)]))
	assert_eq(paths[1], PackedVector2Array([Vector2(80, 336), Vector2(100, 336)]))
	var so_far := line.paths(Fixture.L1, 1.25)
	assert_eq(so_far.size(), 1)
	assert_eq(so_far[0], PackedVector2Array([Vector2(80, 336), Vector2(90, 336)]), "up to the marker")
	assert_eq(line.paths(Fixture.L2).size(), 1)
	assert_eq(line.deaths_in(Fixture.L1).size(), 1)
	assert_eq(line.deaths_in(Fixture.L1)[0].cause, "spikes")
	assert_eq(line.deaths_in(Fixture.L2).size(), 0)
	var heat := line.heat(Fixture.L1, 32.0)
	assert_eq(heat[Vector2i(2, 10)], 2, "x 80, y 336: at the start, and again after the respawn")


func test_ticks_and_the_event_list() -> void:
	var line := Timeline.new(_a())
	assert_eq(line.ticks.map(func(tick: Dictionary) -> String: return tick.kind),
			["coin", "death", "respawn", "setting_changed", "level_complete", "error"])
	assert_eq(line.listed.size(), 13, "everything but the positions")
	assert_eq(line.list_index_at(-1.0), -1)
	assert_eq(line.list_index_at(0.0), 0)
	assert_eq(line.events[line.listed[line.list_index_at(1.0)]].type, "progress")
	assert_eq(line.events[line.listed[line.list_index_at(99.0)]].type, "error")
	assert_eq(line.coins_taken(Fixture.L1, 5.0), {})
	assert_eq(line.coins_taken(Fixture.L1, 5.2), {0: true})
	assert_eq(line.coins_taken(Fixture.L2, 99.0), {})
	assert_eq(line.duration, 40.0)


func test_another_game_in_3d_is_drawn_top_down() -> void:
	var line := Timeline.new(_sessions()[1])
	assert_eq(line.scene_at(5.0), Fixture.WORLD)
	assert_eq(line.position_at(1.0).p, Vector2(0, 0))
	assert_eq(line.position_at(4.0).p, Vector2(10, 5), "x and z")
	assert_eq(line.deaths_in(Fixture.WORLD)[0].p, Vector2(12, 6))
	assert_eq(line.bounds(Fixture.WORLD), Rect2(0, 0, 12, 6))
	assert_eq(line.ticks.map(func(tick: Dictionary) -> String: return tick.kind), ["death", "action"])
	assert_eq(Timeline.new({"events": []}).bounds(""), Rect2(0, 0, 100, 100))


func test_the_event_list_reads() -> void:
	# (The fixture's JSON.stringify sorted the keys; the server's keep the game's order.)
	var events: Array = _a().events
	assert_eq(Timeline.describe(events[8]), "0:05.2  coin  coin=0 coins=1 level=level_1 level_coins=1")
	assert_eq(Timeline.describe(events[9]), "0:06.0  death: spikes at (400, 208)")
	assert_eq(Timeline.describe(events[13]), "0:10.0  setting volume: 0.8 -> 0.5")
	assert_eq(Timeline.describe(events[1]), "0:00.5  screen: gameplay")
	assert_eq(Timeline.describe(events[2]), "0:01.0  load level_1.tscn (12.5 ms)")
	assert_true(Timeline.describe(events[-1]).contains("error: boom (level.gd:3)"))
	assert_eq(Timeline.clock(83.4, true), "1:23.4")
	assert_eq(Timeline.clock(3725.0), "62:05")
#endregion
