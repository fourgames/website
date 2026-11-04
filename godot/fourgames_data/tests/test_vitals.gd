extends "res://tests/tools/game_data_suite.gd"

## The events the plugin records by itself, so no game has to call for them:
## perf, the loads and the boot, input, idle and active time, settings changed,
## screens, where a session stopped, the DLC -- fed through the seams the frame,
## the window and the scene tree use (frame(), note_input(), set_focused(),
## scene_changed()).


#region Perf and loads
func test_perf_goes_every_30_s_and_at_a_scene_change() -> void:
	var gd := _live(_launch())
	gd.scene_changed("res://menu.tscn", 0.0)
	for i in 60:
		gd.frame(16.0)
	gd.frame(80.0)
	gd.advance(30.0)
	gd.frame(20.0)
	gd.scene_changed("res://level.tscn", 420.0)
	gd.advance(60.0)
	_drain(gd)
	var perf := _sent_of(gd, "perf")
	assert_eq(perf[0].data.why, "interval")
	assert_eq(perf[0].data.scene, "res://menu.tscn")
	assert_eq(perf[0].data.frames, 61.0)
	assert_eq(perf[0].data.slow_frames, 1.0)
	assert_eq(perf[0].data.frame_ms_max, 80.0)
	for key in ["fps_avg", "fps_1pct_low", "static_mb", "video_mb", "focused", "idle", "screen"]:
		assert_true(perf[0].data.has(key), "perf has %s" % key)
	assert_eq(perf[1].data.why, "scene_change")
	assert_eq(perf[1].data.scene, "res://menu.tscn", "the scene the frames were in")
	assert_eq(perf[1].data.frames, 1.0)
	var loads := _sent_of(gd, "load")
	assert_eq(loads[0].name, "scene")
	assert_eq(loads[0].data, {"scene": "res://level.tscn", "from": "res://menu.tscn", "ms": 420.0})
	assert_eq(loads[1].name, "boot")
	assert_eq(loads[1].data.by, "scene_change", "the first change after the main scene ends the boot")


func test_frames_out_of_focus_are_not_counted() -> void:
	var gd := _live(_launch())
	gd.set_focused(false)
	for i in 10:
		gd.frame(33.0)
	gd.advance(30.0)
	_drain(gd)
	gd.advance(60.0)
	_drain(gd)
	var perf := _sent_of(gd, "perf")
	assert_eq(perf[0].data.frames, 0.0)
	assert_eq(perf[0].data.fps_avg, null)
	assert_eq(perf[0].data.focused, false)


func test_mark_playing_ends_the_boot_and_the_launch_kind_is_kept() -> void:
	var gd := _launch()
	gd._first_frame_ms = 1200
	gd.transport.ticks = 5000
	_live(gd)
	gd.mark_playing()
	gd.mark_playing()
	gd.scene_changed("res://menu.tscn", 0.0)
	gd.scene_changed("res://level.tscn", 50.0)
	gd.advance(60.0)
	_drain(gd)
	var boots := _sent_of(gd, "load").filter(func(event: Dictionary) -> bool: return event.name == "boot")
	assert_eq(boots.size(), 1, "once, and a scene change after it changes nothing")
	assert_eq(boots[0].data.boot_kind, "first_install")
	assert_eq(boots[0].data.boot_ms, 1200.0)
	assert_eq(boots[0].data.to_play_ms, 5000.0)
	assert_eq(boots[0].data.by, "mark_playing")
	assert_true(boots[0].data.has("init_ms"))
	var start: Dictionary = gd.transport.to("/session/start")[0].json
	assert_eq(start.boot_kind, "first_install")
	assert_eq(start.first_session, true)
	gd.shutdown()
	var again := _live(_launch())
	assert_eq(again.transport.to("/session/start")[0].json.boot_kind, "normal")
	assert_eq(again.transport.to("/session/start")[0].json.first_session, false)
	again.shutdown()
	var updated := _launch()
	updated.game_version = "2.0.0"
	_live(updated)
	assert_eq(updated.transport.to("/session/start")[0].json.boot_kind, "first_after_update")


func test_mark_playing_before_start_still_counts() -> void:
	var gd := _launch()
	gd.transport.ticks = 900
	gd.mark_playing()
	_live(gd)
	gd.advance(60.0)
	_drain(gd)
	var boots := _sent_of(gd, "load")
	assert_eq(boots[0].data.to_play_ms, 900.0)
	assert_eq(boots[0].data.by, "mark_playing")


func test_a_boot_never_marked_goes_at_quit() -> void:
	var gd := _live(_launch())
	gd.shutdown()
	var boot: Array = gd.transport.quit_requests[0].json.events.filter(
			func(event: Dictionary) -> bool: return event.type == "load" and event.name == "boot")
	assert_eq(boot.size(), 1)
	assert_eq(boot[0].data.by, "quit")
	assert_eq(boot[0].data.to_play_ms, null)


func test_a_load_the_game_timed_itself() -> void:
	var gd := _live(_launch())
	gd.loaded("world_streaming", 812.345)
	gd.advance(60.0)
	_drain(gd)
	assert_eq(_sent_of(gd, "load")[0], {"t": 0.0, "type": "load", "name": "game",
			"data": {"what": "world_streaming", "ms": 812.3}})
#endregion


#region Input
func test_the_session_starts_with_the_input_and_each_switch_is_an_event() -> void:
	var gd := _live(_launch())
	var start: Dictionary = gd.transport.to("/session/start")[0].json
	assert_eq(start.input.guess, true)
	assert_true(start.input.type in [GameDataScript.KEYBOARD_MOUSE, GameDataScript.CONTROLLER])
	for key in ["controller", "steam_input", "deck_mode"]:
		assert_true(start.input.has(key), "input has %s" % key)
	gd.note_input(GameDataScript.KEYBOARD_MOUSE, 0)
	gd.note_input(GameDataScript.KEYBOARD_MOUSE, 0)
	gd.note_input(GameDataScript.CONTROLLER, 0)
	gd.note_input(GameDataScript.CONTROLLER, 0)
	gd.note_input(GameDataScript.CONTROLLER, 1)
	gd.note_input(GameDataScript.TOUCH, 0)
	gd.advance(60.0)
	_drain(gd)
	var types := []
	for event in _sent_of(gd, "input"):
		types.append(event.data.type)
	var expected := [start.input.type]
	if start.input.type != GameDataScript.KEYBOARD_MOUSE:
		expected.append(GameDataScript.KEYBOARD_MOUSE)
	expected.append_array([GameDataScript.CONTROLLER, GameDataScript.CONTROLLER, GameDataScript.TOUCH])
	assert_eq(types, expected, "a new device is a switch, the same one is not")


func test_the_window_s_input_is_sorted_by_device() -> void:
	var gd := _live(_launch())
	var key := InputEventKey.new()
	var stick := InputEventJoypadMotion.new()
	stick.axis_value = 0.2
	var pushed := InputEventJoypadMotion.new()
	pushed.axis_value = -0.9
	var emulated := InputEventMouseButton.new()
	emulated.device = InputEvent.DEVICE_ID_EMULATION
	var touch := InputEventScreenTouch.new()
	gd.advance(50.0)
	gd._on_window_input(stick)
	gd.advance(20.0)
	assert_true(gd._idle, "a stick at rest is no input: idle after a minute")
	gd._on_window_input(pushed)
	assert_eq(gd._input_kind, GameDataScript.CONTROLLER)
	gd._on_window_input(emulated)
	assert_eq(gd._input_kind, GameDataScript.CONTROLLER, "a mouse made from a touch is not a mouse")
	gd._on_window_input(touch)
	assert_eq(gd._input_kind, GameDataScript.TOUCH)
	gd._on_window_input(key)
	assert_eq(gd._input_kind, GameDataScript.KEYBOARD_MOUSE)


func test_on_a_deck_the_input_says_docked_or_handheld() -> void:
	var gd := _launch()
	gd.steam.deck = true
	_live(gd)
	var input: Dictionary = gd.transport.to("/session/start")[0].json.input
	assert_eq(input.type, GameDataScript.CONTROLLER, "a Deck is played with its controls")
	assert_true(input.deck_mode in ["handheld", "docked"])
	assert_eq(gd.transport.to("/session/start")[0].json.hardware.steam_deck, true)


func test_without_hardware_consent_input_is_only_its_type() -> void:
	var gd := _live(_launch(false))
	assert_eq(gd.transport.to("/session/start")[0].json.input, null)
	gd.note_input(GameDataScript.CONTROLLER, 3)
	gd.advance(60.0)
	_drain(gd)
	assert_eq(_sent_of(gd, "input")[-1].data, {"type": GameDataScript.CONTROLLER})
#endregion


#region Idle and active
func test_idle_and_active_are_timed_where_they_happened() -> void:
	var gd := _live(_launch())
	gd.advance(30.0)
	gd.advance(31.0)
	gd.note_input(GameDataScript.KEYBOARD_MOUSE, 0)
	gd.advance(10.0)
	gd.set_focused(false)
	gd.advance(5.0)
	gd.set_focused(true)
	gd.advance(4.0)
	gd.shutdown()
	var idle: Array = []
	for request in gd.transport.requests:
		if request.path == "/events":
			idle.append_array(request.json.events.filter(func(event: Dictionary) -> bool: return event.type == "idle"))
	var said := []
	for event in idle:
		said.append([event.data.idle, event.data.get("why", ""), event.data.after_s])
	assert_eq(said, [[true, "no_input", 0.0], [false, "", 61.0], [true, "unfocused", 10.0], [false, "", 5.0]])
	var summary: Dictionary = gd.transport.to("/session/end")[0].json.summary
	assert_eq(summary.active_s, 14.0)
	assert_eq(summary.idle_s, 66.0)
#endregion


#region Settings, screens and the quit point
func test_a_setting_changed_says_what_it_was() -> void:
	var gd := _live(_launch(), {"volume": 0.5})
	gd.set_setting("volume", 0.5)
	gd.set_setting("volume", 0.3)
	gd.set_setting("vsync", true)
	gd.advance(60.0)
	_drain(gd)
	var changed := _sent_of(gd, "setting_changed")
	assert_eq(changed.size(), 2)
	assert_eq(changed[0].data, {"key": "volume", "old": 0.5, "new": 0.3})
	assert_eq(changed[1].data, {"key": "vsync", "old": null, "new": true})


func test_the_end_says_where_the_session_stopped() -> void:
	var gd := _live(_launch())
	gd.scene_changed("res://menu.tscn", 0.0)
	gd.screen("main_menu")
	gd.screen("main_menu")
	gd.screen("options")
	gd.advance(12.0)
	gd.shutdown()
	var summary: Dictionary = gd.transport.to("/session/end")[0].json.summary
	assert_eq(summary.last_scene, "res://menu.tscn")
	assert_eq(summary.last_screen, "options")
	assert_eq(summary.playtime_s, 12.0)
	assert_eq(summary.first_session, true)
	assert_eq(summary.session_number, 1.0)
	var screens := []
	for request in gd.transport.requests:
		if request.path == "/events":
			for event in request.json.events:
				if event.type == "screen":
					screens.append(event.data)
	assert_eq(screens, [{"name": "main_menu", "from": ""}, {"name": "options", "from": "main_menu"}])


func test_a_crash_report_says_where_the_run_was() -> void:
	var first := _live(_launch())
	first.scene_changed("res://menu.tscn", 0.0)
	first.scene_changed("res://level.tscn", 100.0)
	first.screen("pause")
	first.advance(30.0)
	var later := _live(_launch())
	_drain(later)
	var crash: Dictionary = later.transport.to("/crash")[0]
	assert_eq(crash.json.quit_point, {"last_scene": "res://level.tscn", "last_screen": "pause",
			"playtime_s": 30.0, "first_session": true})
	assert_true(crash.text.contains("\"playtime_s\":30"), "the playtime goes as a whole number")
	assert_false(crash.text.contains("\"playtime_s\":30.0"))
	var ringed: Array = crash.json.last_events.filter(func(event: Dictionary) -> bool: return event.type == "perf")
	assert_eq(ringed[-1].data.scene, "res://level.tscn", "the ring's perf says where, too")
#endregion


#region Steam
func test_the_dlc_owned_goes_with_the_session() -> void:
	var gd := _launch()
	gd.steam.dlc = {3001001: true, 3001002: false}
	_live(gd)
	var start: Dictionary = gd.transport.to("/session/start")[0]
	assert_eq(start.json.dlc, [{"app_id": 3001001.0, "owned": true}, {"app_id": 3001002.0, "owned": false}])
	assert_true(start.text.contains("\"app_id\":3001001,"), "a DLC's app id goes as a whole number")


func test_the_app_id_is_the_one_the_build_passes() -> void:
	# A demo build passes the demo's app id, and that is all a demo needs.
	var gd := _launch()
	gd.start(5367080, {})
	gd.advance(0.0)
	gd.steam.answer()
	assert_true(gd.transport.to("/session/start")[0].text.contains("\"app_id\":5367080,"))
#endregion
