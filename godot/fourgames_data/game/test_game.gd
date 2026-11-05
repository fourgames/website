extends Node

## The test game's autoload, `TestGame`: what a real game's Steam manager and
## settings code would do, so the game in res://game/ sends a real session
## through Steam to the game-data API.
##
##   - Steam up (GodotSteam, through Engine.get_singleton only, so the project
##     still parses and its tests still run without it), then
##     GameData.start(APP_ID, settings) -- once, from the first scene in
##     res://game/; the tests, the demo and the tools never start it.
##   - The settings (volume, show_fps, window_mode): kept in user://, applied,
##     and every change told to GameData.set_setting().
##   - The run's coins and deaths, across the two levels.
##   - An overlay: the FPS counter and the data panel (F1), which says what the
##     plugin is doing.
##
## Whether the plugin records in the editor and debug builds is the project
## setting fourgames_data_test/collect_in_debug (on here) or FOURGAMES_DATA_DEV=1;
## fourgames_data_test/base_url, or FOURGAMES_DATA_URL, points it at another
## server than https://api.fourgames.se/gamedata/v1. After "--" on the command
## line: --fake-steam (the tests' stand-in Steam, for a local server),
## --no-steam, and --steam (a headless run leaves the real Steam alone unless
## told this).

const Levels := preload("res://game/levels.gd")
const RecordingTransport := preload("res://game/debug/recording_transport.gd")

## Pomo Valley's app id: the owner's own app, which his account owns. The server
## takes it from the test accounts only, as test sessions (GAMEDATA_TEST_APP_IDS).
const APP_ID := 5207970
const COLLECT_SETTING := "fourgames_data_test/collect_in_debug"
const URL_SETTING := "fourgames_data_test/base_url"
const SETTINGS_PATH := "user://fourgames_data_test/settings.cfg"
const DEFAULTS := {"volume": 0.8, "show_fps": false, "window_mode": "windowed"}
const WINDOW_MODES: Array[String] = ["windowed", "fullscreen"]
const TITLE_SCENE := "res://game/title.tscn"
const VIEWER_SCENE := "res://game/replay/viewer.tscn"
## steamInitEx()'s status for "it worked".
const STEAM_OK := 0

signal settings_changed

var settings := {}
## Where they are kept. A check that plays the game points it elsewhere and
## calls load_settings(), so the player's own stay as they were.
var settings_path := SETTINGS_PATH
## This run's coins and deaths, from Play on the title to the last level.
var total_coins := 0
var deaths := 0
## What the last finished run got, for the title: {} before one.
var last_run := {}
## "on", "fake", or why not.
var steam_state := "not started"

var _started := false
var _steam: Object = null
var _real_steam := false
var _transport: Node = null
var _overlay: CanvasLayer = null
var _panel: PanelContainer = null
var _panel_text: Label = null
var _fps: Label = null
var _panel_every := 0.0


func _init() -> void:
	# A run from the editor isn't launched by Steam, so nothing else says which
	# app this is (steam_appid.txt next to project.godot says it too).
	OS.set_environment("SteamAppID", str(APP_ID))
	OS.set_environment("SteamGameID", str(APP_ID))
	_add_actions()
	load_settings()


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	await get_tree().process_frame
	var scene := get_tree().current_scene
	if scene != null and scene.scene_file_path.begins_with("res://game/"):
		begin()


func _process(delta: float) -> void:
	if _real_steam:
		_steam.run_callbacks()
	if _fps != null and _fps.visible:
		_fps.text = "%d FPS" % Engine.get_frames_per_second()
	if _panel != null and _panel.visible:
		_panel_every -= delta
		if _panel_every <= 0.0:
			_panel_every = 0.25
			_panel_text.text = panel_text()


func _input(event: InputEvent) -> void:
	if _panel != null and event.is_action_pressed(&"data_panel"):
		_panel.visible = not _panel.visible
		_panel_every = 0.0
		get_viewport().set_input_as_handled()


## Steam, the settings, the overlay and the session: once a run.
func begin() -> void:
	if _started:
		return
	_started = true
	_apply_settings()
	_make_overlay()
	_start_steam()
	_start_game_data()


func new_run() -> void:
	total_coins = 0
	deaths = 0


func finish_run() -> void:
	last_run = {"coins": total_coins, "deaths": deaths}


#region Steam and the session
func _start_steam() -> void:
	var args := OS.get_cmdline_user_args()
	if "--fake-steam" in args:
		var fake: Object = load("res://tests/tools/fake_steam.gd").new()
		fake.set("auto_answer", true)
		_steam = fake
		steam_state = "fake"
		return
	if "--no-steam" in args or (DisplayServer.get_name() == "headless" and not "--steam" in args):
		steam_state = "off (this run leaves Steam alone)"
		return
	if not Engine.has_singleton(&"Steam"):
		steam_state = "off: GodotSteam is not loaded"
		return
	var steam := Engine.get_singleton(&"Steam")
	var answer: Dictionary = steam.call(&"steamInitEx", APP_ID, false)
	if int(answer.get("status", -1)) != STEAM_OK:
		steam_state = "off: %s" % answer.get("verbal", "Steam did not start")
		print("TestGame: Steam is not available: ", answer.get("verbal", "no reason given"))
		return
	_steam = steam
	_real_steam = true
	steam_state = "on"


func _start_game_data() -> void:
	# Every half second while the player moves: enough to replay the path.
	GameData.position_every_s = 0.5
	if bool(ProjectSettings.get_setting(COLLECT_SETTING, false)):
		GameData.force_enabled = true
	var url := str(ProjectSettings.get_setting(URL_SETTING, "")).strip_edges()
	if OS.get_environment("FOURGAMES_DATA_URL").is_empty() and not url.is_empty():
		GameData.base_url = url
	if _steam == null:
		# GameData would look the Steam singleton up itself, and it is not up.
		print("TestGame: not recording, Steam is ", steam_state)
		return
	GameData.steam = _steam
	_transport = RecordingTransport.new()
	_transport.name = "Transport"
	GameData.add_child(_transport)
	GameData.transport = _transport
	GameData.start(APP_ID, settings)
#endregion


#region Settings
func set_setting(key: String, value: Variant) -> void:
	if settings.get(key) == value and typeof(settings.get(key)) == typeof(value):
		return
	settings[key] = value
	_apply_settings()
	_save_settings()
	GameData.set_setting(key, value)
	settings_changed.emit()


## The volume now, without telling anyone: while a slider is being dragged.
func preview_volume(value: float) -> void:
	AudioServer.set_bus_volume_db(0, linear_to_db(maxf(value, 0.0001)))


func load_settings() -> void:
	settings = DEFAULTS.duplicate()
	var cfg := ConfigFile.new()
	if cfg.load(settings_path) != OK:
		return
	settings.volume = clampf(float(cfg.get_value("settings", "volume", DEFAULTS.volume)), 0.0, 1.0)
	settings.show_fps = bool(cfg.get_value("settings", "show_fps", DEFAULTS.show_fps))
	var mode := str(cfg.get_value("settings", "window_mode", DEFAULTS.window_mode))
	settings.window_mode = mode if mode in WINDOW_MODES else DEFAULTS.window_mode


func _save_settings() -> void:
	DirAccess.make_dir_recursive_absolute(settings_path.get_base_dir())
	var cfg := ConfigFile.new()
	for key: String in settings:
		cfg.set_value("settings", key, settings[key])
	cfg.save(settings_path)


func _apply_settings() -> void:
	preview_volume(float(settings.volume))
	if _fps != null:
		_fps.visible = bool(settings.show_fps)
	if DisplayServer.get_name() == "headless":
		return
	var want := DisplayServer.WINDOW_MODE_FULLSCREEN if settings.window_mode == "fullscreen" \
			else DisplayServer.WINDOW_MODE_WINDOWED
	if DisplayServer.window_get_mode() != want:
		DisplayServer.window_set_mode(want)
#endregion


#region Input
## WASD, the arrows, a stick or the d-pad to move; Esc, P or Start to pause; F1
## for the data panel. Made here rather than in project.godot so the project's
## own tests and demo stay as they were.
func _add_actions() -> void:
	var keys := {
		&"move_left": [KEY_A, KEY_LEFT], &"move_right": [KEY_D, KEY_RIGHT],
		&"move_up": [KEY_W, KEY_UP], &"move_down": [KEY_S, KEY_DOWN],
		&"pause": [KEY_ESCAPE, KEY_P], &"data_panel": [KEY_F1],
	}
	var pads := {
		&"move_left": [JOY_BUTTON_DPAD_LEFT], &"move_right": [JOY_BUTTON_DPAD_RIGHT],
		&"move_up": [JOY_BUTTON_DPAD_UP], &"move_down": [JOY_BUTTON_DPAD_DOWN],
		&"pause": [JOY_BUTTON_START],
	}
	var sticks := {&"move_left": [JOY_AXIS_LEFT_X, -1.0], &"move_right": [JOY_AXIS_LEFT_X, 1.0],
			&"move_up": [JOY_AXIS_LEFT_Y, -1.0], &"move_down": [JOY_AXIS_LEFT_Y, 1.0]}
	for action: StringName in keys:
		if InputMap.has_action(action):
			continue
		InputMap.add_action(action, 0.3)
		for key: int in keys[action]:
			var press := InputEventKey.new()
			press.physical_keycode = key as Key
			InputMap.action_add_event(action, press)
		for button: int in pads.get(action, []):
			var pad := InputEventJoypadButton.new()
			pad.button_index = button as JoyButton
			InputMap.action_add_event(action, pad)
		if sticks.has(action):
			var stick := InputEventJoypadMotion.new()
			stick.axis = int(sticks[action][0]) as JoyAxis
			stick.axis_value = sticks[action][1]
			InputMap.action_add_event(action, stick)
#endregion


#region Overlay
func _make_overlay() -> void:
	_overlay = CanvasLayer.new()
	_overlay.layer = 100
	add_child(_overlay)
	_fps = Label.new()
	_fps.set_anchors_and_offsets_preset(Control.PRESET_TOP_RIGHT)
	_fps.position = Vector2(-110, 6)
	_fps.size = Vector2(100, 24)
	_fps.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_fps.visible = bool(settings.show_fps)
	_overlay.add_child(_fps)
	_panel = PanelContainer.new()
	_panel.position = Vector2(8, 40)
	_panel.visible = false
	_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_overlay.add_child(_panel)
	_panel_text = Label.new()
	_panel_text.add_theme_font_size_override("font_size", 13)
	_panel.add_child(_panel_text)


## What the plugin is doing, for the data panel. It reads a few of GameData's
## own fields: a debugging aid in the addon's own test project, not an API.
func panel_text() -> String:
	var lines: PackedStringArray = ["Four Games data (F1 hides this)"]
	lines.append("Steam: %s   GameData: %s" % [steam_state, GameData.status()])
	var queue: Object = GameData.get("_queue")
	var local := str(GameData.get("_local"))
	var sid := ""
	if queue != null and not local.is_empty():
		sid = str(queue.call("session", local).get("sid", ""))
	lines.append("Session: %s   app %d" % [sid.left(8) if not sid.is_empty() else "(none yet)", APP_ID])
	var url := GameData.base_url if not GameData.base_url.is_empty() else "(not started)"
	lines.append("Server: " + url)
	var buffered: Variant = GameData.get("_buffer")
	var in_memory: int = (buffered as PackedStringArray).size() if buffered is PackedStringArray else 0
	var batches := 0
	var bytes := 0
	if queue != null:
		batches = (queue.call("items") as PackedStringArray).size()
		bytes = int(queue.call("bytes"))
	lines.append("Queued: %d events in memory, %d requests on disk (%.1f KB)" % [in_memory, batches, bytes / 1024.0])
	if _transport != null and not _transport.last.is_empty():
		var last: Dictionary = _transport.last
		var ago := (Time.get_ticks_msec() - int(last.at)) / 1000.0
		lines.append("Last upload: %s -> %s, %.0f s ago   (%d ok, %d not)" % [last.path,
				str(last.code) if int(last.code) > 0 else "no answer", ago, _transport.sent, _transport.failed])
	else:
		lines.append("Last upload: none yet")
	lines.append("Opted out: %s" % ("yes" if GameData.opted_out() else "no"))
	return "\n".join(lines)
#endregion
