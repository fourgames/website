extends Node

## Plays the test game in res://game/ headless, the way a player would get
## through it, with the tests' stand-in Steam and a local server, and opens the
## replay viewer on a small download at the end:
##
##   FOURGAMES_DATA_URL=http://127.0.0.1:8765/v1 \
##     Godot --headless --path . res://tests/tools/play_check.tscn -- --fake-steam
##
## (play_check.sh starts tests/tools/fake_server.py and reads back what it got.)
## Title -> Play -> walk with the move actions, a coin, a death on spikes, the
## respawn, the pause menu (volume, FPS, back), the goal; level 2, a death on a
## saw, the goal; the title again; the viewer, played, scrubbed, its heatmap and
## "Copy for Claude"; then a real quit, whose session end goes out from
## GameData's _exit_tree. The plugin and the settings use scratch folders that
## are removed at the end. Prints "PLAY: ..." and exits 1 when something it can
## see went wrong.

const Levels := preload("res://game/levels.gd")
const Level := preload("res://game/level.gd")
const Fixture := preload("res://tests/tools/replay_fixture.gd")


func _ready() -> void:
	# This scene goes when the game's scenes come; the one driving them stays.
	get_tree().root.add_child.call_deferred(Driver.new())


class Driver extends Node:
	var failed := false
	var scratch := "user://_play_check_%d" % OS.get_process_id()

	func _ready() -> void:
		process_mode = Node.PROCESS_MODE_ALWAYS
		if OS.get_environment("FOURGAMES_DATA_URL").is_empty():
			# Without one, the stand-in Steam's ticket would go to the live server.
			return _fail("set FOURGAMES_DATA_URL to a local server")
		GameData.root_dir = scratch.path_join("fourgames_data")
		TestGame.settings_path = scratch.path_join("settings.cfg")
		TestGame.load_settings()
		await _play()
		if not failed:
			print("PLAY: passed")
		tree_exiting.connect(_wipe)
		get_tree().quit(1 if failed else 0)

	func _play() -> void:
		get_tree().change_scene_to_file(TestGame.TITLE_SCENE)
		await _frames(3)
		TestGame.begin()
		if not await _until(func() -> bool: return GameData.status() == "live", 10.0):
			return _fail("the session never went live (%s, Steam %s)" % [GameData.status(), TestGame.steam_state])
		print("PLAY: live, ", TestGame.panel_text().replace("\n", " | "))
		get_tree().current_scene.play_button.pressed.emit()
		var level: Node = await _level("level_1")
		if level == null:
			return
		await _level_one(level)
		if failed:
			return
		level = await _level("level_2")
		if level == null:
			return
		await _level_two(level)
		if failed:
			return
		if not await _until(func() -> bool: return _scene() == TestGame.TITLE_SCENE, 6.0):
			return _fail("the title never came back after the last level")
		_check(TestGame.last_run.get("deaths") == 2, "the run's deaths: %s" % TestGame.last_run)
		await _viewer()

	func _level_one(level: Node) -> void:
		var player: Node2D = level.player
		var start := player.position
		await _hold(&"move_right", 0.6)
		_check(player.position.x > start.x + 60.0, "the player walked right (%s -> %s)" % [start, player.position])
		await _hold(&"move_up", 3.0)
		_check(player.position.y >= Levels.TILE + Level.HALF - 0.01, "the top wall held (%s)" % player.position)
		var data := Levels.level("level_1")
		player.position = Levels.center(data.coins[0])
		await _physics(2)
		_check(level.collected.has(0), "coin 0 was taken")
		player.position = Levels.rect(data.spikes[0]).get_center()
		await _physics(2)
		_check(level.deaths_here == 1, "the spikes killed")
		await _seconds(1.0)
		_check(player.position == Levels.center(data.start), "respawned at the start (%s)" % player.position)
		# The pause menu: the volume, the FPS counter, and play again.
		Input.parse_input_event(_action(&"pause"))
		await _frames(2)
		var menu: Node = level.get_children().filter(func(n: Node) -> bool: return n.has_method(&"set_volume"))[0]
		_check(get_tree().paused and menu.visible, "Esc paused the game")
		menu.set_volume(50.0)
		menu._fps.button_pressed = true
		menu._window.select(0)
		await _frames(2)
		_check(TestGame.settings.volume == 0.5 and TestGame.settings.show_fps == true, "the settings: %s" % TestGame.settings)
		Input.parse_input_event(_action(&"pause"))
		await _frames(2)
		_check(not get_tree().paused and not menu.visible, "Esc again played on")
		await _hold(&"move_down", 0.5)
		player.position = Levels.rect(data.goal).get_center()
		await _physics(2)
		_check(level.done, "the goal ended the level")

	func _level_two(level: Node) -> void:
		var player: Node2D = level.player
		await _hold(&"move_right", 0.5)
		var data := Levels.level("level_2")
		var saw: Array = data.saws[1]
		player.position = Levels.saw_at(saw, level.time + 1.0 / Engine.physics_ticks_per_second)
		await _physics(2)
		_check(level.deaths_here == 1, "the saw killed")
		await _seconds(1.0)
		player.position = Levels.center(data.coins[0])
		await _physics(2)
		player.position = Levels.rect(data.goal).get_center()
		await _physics(2)
		_check(level.done, "the goal ended level 2")

	## The viewer on a small download: the session list, play at 16x, a scrub,
	## the heatmap and the summary.
	func _viewer() -> void:
		var zip_path := scratch.path_join("download.zip")
		var zip := ZIPPacker.new()
		zip.open(zip_path)
		var files := Fixture.files()
		for name: String in files:
			zip.start_file(name)
			zip.write_file(str(files[name]).to_utf8_buffer())
			zip.close_file()
		zip.close()
		get_tree().change_scene_to_file(TestGame.VIEWER_SCENE)
		await _frames(3)
		var viewer: Node = get_tree().current_scene
		_check(viewer.open_file(ProjectSettings.globalize_path(zip_path)), "the viewer opened the download")
		_check(viewer.sessions.size() == 2, "two sessions listed")
		viewer.set_speed(2)
		viewer.set_playing(true)
		await _seconds(1.0)
		_check(viewer.time > 10.0, "16x played on (%.1f s)" % viewer.time)
		viewer.seek(6.3)
		_check(viewer._event_list.get_selected_items() == PackedInt32Array([5]), "the death is highlighted")
		viewer._heat.button_pressed = true
		await _frames(2)
		var text: String = viewer.copy_for_claude()
		_check(text.begins_with("Here is a play session from the fourgames_data test project"), "the summary")
		viewer.select_session(1)
		viewer.seek(5.0)
		await _frames(2)
		_check(viewer._canvas.timeline.scene_at(5.0) == Fixture.WORLD, "another game's session drawn on a grid")
		print("PLAY: viewer ok, summary %d bytes" % text.to_utf8_buffer().size())

	#region Helpers
	func _level(level_id: String) -> Node:
		if not await _until(func() -> bool: return _scene() == Levels.scene_of(level_id), 6.0):
			_fail("%s never loaded (at %s)" % [level_id, _scene()])
			return null
		await _frames(3)
		return get_tree().current_scene

	func _scene() -> String:
		var scene := get_tree().current_scene
		return scene.scene_file_path if scene != null else ""

	func _hold(action: StringName, seconds: float) -> void:
		Input.action_press(action)
		await _seconds(seconds)
		Input.action_release(action)

	func _action(action: StringName) -> InputEventAction:
		var event := InputEventAction.new()
		event.action = action
		event.pressed = true
		return event

	func _frames(n: int) -> void:
		for i in n:
			await get_tree().process_frame

	func _physics(n: int) -> void:
		for i in n:
			await get_tree().physics_frame

	func _seconds(seconds: float) -> void:
		await get_tree().create_timer(seconds, true, false, true).timeout

	func _until(done: Callable, seconds: float) -> bool:
		var until := Time.get_ticks_msec() + int(seconds * 1000.0)
		while not done.call():
			if Time.get_ticks_msec() > until:
				return false
			await get_tree().process_frame
		return true

	func _check(ok: bool, what: String) -> void:
		if ok:
			print("PLAY: ok ", what)
		else:
			_fail(what)

	func _fail(why: String) -> void:
		failed = true
		print("PLAY: FAIL ", why)
		get_tree().quit(1)

	## The scratch folders go once GameData has written its last file. This node
	## leaves the tree before the autoloads do, so it has GameData quit first (a
	## second shutdown() does nothing).
	func _wipe() -> void:
		GameData.shutdown()
		_remove(scratch)

	static func _remove(path: String) -> void:
		if not DirAccess.dir_exists_absolute(path):
			return
		for folder in DirAccess.get_directories_at(path):
			_remove(path.path_join(folder))
		for file in DirAccess.get_files_at(path):
			DirAccess.remove_absolute(path.path_join(file))
		DirAccess.remove_absolute(path)
	#endregion
