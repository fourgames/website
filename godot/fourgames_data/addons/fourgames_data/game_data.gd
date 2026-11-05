extends Node

## Four Games' player game data, the Godot side: what a session did, the
## machine it ran on and how it ended, sent to api.fourgames.se so the games get
## better and their bugs get fixed. Autoload `GameData`. The contract is
## server/gamedata/SPEC.md in the website repo, "The Godot plugin".
##
## A game calls a handful of things and nothing else knows the plugin is there:
##
##   GameData.start(app_id, settings)   once, after Steam is up
##   GameData.action(name, data)        the player did something
##   GameData.progress(data)            how far they are: day, coins, level
##   GameData.snapshot(data)            a small state summary, every ~30 s
##   GameData.set_setting(key, value)   a setting changed
##
## and, when the game knows them, GameData.screen(name) (the menu or screen now
## up), GameData.ui(event, data) (tutorial_skipped, help_opened),
## GameData.track_player(node) (whose position the heatmaps follow),
## GameData.death(cause, data), GameData.achievement(api_name),
## GameData.mark_playing() (the player can play: the end of the boot) and
## GameData.loaded(what, ms) (a load the game timed itself); and, for a game that
## wants them, opted_out()/set_opt_out() and PRIVACY_URL. The Steam ticket, the
## session, batching, the disk queue, retries, the quit and crashes all happen
## in here, and so do the standard events no game has to call for:
##
##   perf            every PERF_EVERY_S and at each scene change: fps (average
##                   and 1% low, frame_stats.gd), the longest frame, frames over
##                   50 ms, static and video memory
##   load            "scene" at each scene change, with the frame it took; "boot"
##                   once: boot_kind, engine start to the first frame (boot_ms)
##                   and to mark_playing() (to_play_ms)
##   input           at start and whenever the player switches between keyboard
##                   and mouse, a controller (which one) and touch
##   idle            the window lost focus, or no input for IDLE_AFTER_S, and back
##   setting_changed set_setting() with its old and new value
##   screen          screen(name)
##   ui              "screen": how long a screen was up, as the next one comes
##   position        every position_every_s while playing and not idle, when the
##                   tracked player has moved: scene, x, y (z), its turn
##   death           death(): the scene and where the player stood
##   overlay         the Steam overlay opened or closed
##   steam           once: Steam's language, Family Sharing, Remote Play, Big
##                   Picture (and again when a Remote Play session comes or goes)
##   achievement     an unlock Steam stored, or achievement(): name, scene, playtime
##   error           script and engine errors (ErrorCatcher)
##
## and /session/end's summary says where the session stopped (last scene and
## screen), how long it was active and idle, and whether it was the first on
## this install.
##
## It never breaks the game. Every failure is quiet (a line in the log at most);
## requests run on a thread; the disk work is a few small files; and the one wait
## it ever makes is at quit, never longer than QUIT_BUDGET_MS. Nothing is
## collected in the editor, a debug build or a test unless FOURGAMES_DATA_DEV=1,
## and FOURGAMES_DATA_URL points it at another server (a local one) for testing.
##
## A session, in order:
##   1. start() asks Steam for a Web API ticket for the identity
##      "fourgames-gamedata" and sends it to /session/start with the versions,
##      the platform and -- with consent.hardware -- the machine (hardware.gd)
##      and the game's settings.
##   2. The answer says whether the player opted out (on fourgames.se/privacy, or
##      with /privacy in the Discord bot). Then nothing more is kept or sent until
##      the next launch, and what was kept is deleted.
##   3. Events are buffered from the first call, so nothing waits on the server.
##      Every upload_every_s the buffer is cut into a batch, gzipped and written
##      to user://fourgames_data/queue/ (queue.gd), and the queue goes out oldest
##      first, one request at a time, backing off while the server can't be
##      reached. Offline play keeps its batches, and a later launch sends them.
##   4. At quit the last batch and /session/end are written down and, when the
##      server has been answering, sent at once; what doesn't make it in time
##      goes on the next launch.
##
## Crashes: start() writes running.json and keeps the last RING_SIZE events in a
## ring file (ring.gd), and a clean quit removes running.json. Finding it at the
## next start() means that run never quit: its ring, the tail of its Godot log
## and the signal the log names go to /crash under the new session's token.
## Script and engine errors along the way go as "error" events (ErrorCatcher).
##
## Seams for tests and local testing: `transport`, `steam`, `root_dir`,
## `base_url`, `unix_now`, `ticks_msec`, `force_enabled`, advance(delta), which
## _process forwards to, and note_input()/frame()/watch_scene()/scene_changed(),
## which the window's input, each frame and the scene tree feed.

const Queue := preload("queue.gd")
const Ring := preload("ring.gd")
const Transport := preload("http_transport.gd")
const Hardware := preload("hardware.gd")
const FrameStats := preload("frame_stats.gd")

## Where the policy and the opt-out are, for a game's "Privacy" link.
const PRIVACY_URL := "https://fourgames.se/privacy"
const DEFAULT_URL := "https://api.fourgames.se/gamedata/v1"
const IDENTITY := "fourgames-gamedata"
const DEV_ENV := "FOURGAMES_DATA_DEV"
const URL_ENV := "FOURGAMES_DATA_URL"
const ROOT := "user://fourgames_data"
const STEAM := &"Steam"
## Steam's k_EResultOK.
const STEAM_OK := 1

## What the server says until its session/start reply says otherwise.
const UPLOAD_EVERY_S := 60.0
const MAX_BATCH_KB := 256
const MAX_BATCH_EVENTS := 2000
## A busy minute is cut early at this much raw JSON, so no batch nears the cap.
const RAW_BATCH_BYTES := 1024 * 1024
const QUEUE_CAP_BYTES := 20 * 1024 * 1024
const RING_SIZE := 500
const LOG_TAIL_BYTES := 64 * 1024
## The crash report's events, newest kept, so it stays one modest request.
const CRASH_EVENTS_BYTES := 192 * 1024
## The longest the quit waits on the network, all requests together.
const QUIT_BUDGET_MS := 1500
const TICKET_TIMEOUT_S := 15.0
const BACKOFF_FIRST_S := 5.0
const BACKOFF_MAX_S := 600.0
## The server's tokens last 24 h; past this a batch is only a refusal waiting.
const TOKEN_LIFE_S := 23 * 3600
## Sessions an earlier run never got started (offline), started late, a launch.
const LATE_STARTS := 3
## Such a session, this old, is given up on.
const STALE_S := 14 * 24 * 3600
const NAME_CHARS := 64
const EVENT_BYTES := 4096
## Different errors sent a session; repeats are only counted.
const ERRORS := 50
## Fresh sessions a run may open after the server turned its token down.
const RESTARTS := 2
## Statuses that will never succeed for this body: it is dropped.
const REFUSED: Array[int] = [400, 404, 405, 413, 415, 422]
## Kill signals by number, for the crash report.
const SIGNALS := {4: "SIGILL", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 10: "SIGBUS", 11: "SIGSEGV"}
## The ticket a set_opt_out(true) asks for, to tell the server.
const CONSENT := "consent"
const PERF_EVERY_S := 30.0
## No input for this long and the player is idle, as they are out of focus.
const IDLE_AFTER_S := 60.0
const MB := 1024.0 * 1024.0
## What an "input" event says the player is playing with.
const KEYBOARD_MOUSE := "keyboard_mouse"
const CONTROLLER := "controller"
const TOUCH := "touch"
## A stick has to be pushed this far to count as the player playing.
const STICK_DEADZONE := 0.5
## The Deck's own screen; on anything else a Deck is docked.
const DECK_SCREENS: Array[Vector2i] = [Vector2i(1280, 800), Vector2i(800, 1280)]
## GodotSteam's InputType, by value.
const STEAM_INPUT_TYPES: Array[String] = ["unknown", "steam_controller", "xbox360", "xboxone",
		"generic_xinput", "ps4", "apple_mfi", "android", "switch_joycon_pair", "switch_joycon_single",
		"switch_pro", "mobile_touch", "ps3", "ps5", "steam_deck", "steam_os_handheld", "switch2_pro",
		"steam_controller2", "steam_frame_controller_pair"]
## The most DLC a session lists.
const DLC_MAX := 200
## How far the tracked player must have moved for a new "position": a pixel in
## 2D, five centimetres in 3D.
const MOVED_2D := 1.0
const MOVED_3D := 0.05

enum State { OFF, STARTING, LIVE, OPTED_OUT }

#region Seams
## The plugin's folder. A test points it at a scratch one.
var root_dir := ROOT
## The server; FOURGAMES_DATA_URL, else DEFAULT_URL, when left empty.
var base_url := ""
var queue_cap := QUEUE_CAP_BYTES
## Sends requests: http_transport.gd, made at start(), or a test's stand-in.
var transport: Object = null
## The GodotSteam singleton, or a test's stand-in.
var steam: Object = null
## On whatever the build, as FOURGAMES_DATA_DEV=1 is. For tests.
var force_enabled := false
## Hear the engine's errors (ErrorCatcher). A test turns it off.
var catch_errors := true
var unix_now: Callable = Time.get_unix_time_from_system
var ticks_msec: Callable = Time.get_ticks_msec
## The Godot log a crashed run left; the project's log path when empty.
var log_path := ""
#endregion

## Whether the machine and the game's settings go with each session
## (consent.hardware). On by default like the rest; a game may turn it off
## before start().
var share_hardware := true
## The game_version sessions report: application/config/version when empty.
var game_version := ""
## How often the tracked player's position is sampled, in seconds of play.
var position_every_s := 3.0

var _state := State.OFF
var _started := false
var _app_id := 0
var _settings := {}
var _steam: Object = null
var _queue: Queue = null
var _ring: Ring = null
## opted_out (the player's own, from set_opt_out), told (the server has heard
## it), server_opted_out (what the last session/start said).
var _prefs := {}
var _local := ""
var _seq := 0
var _run_started := 0
## Seconds of unpaused play since start(): every event's "t".
var _t := 0.0
## Seconds since start(), paused or not: what retries wait on.
var _clock := 0.0
var _buffer: PackedStringArray = []
var _buffer_bytes := 0
var _since_cut := 0.0
var _upload_every := UPLOAD_EVERY_S
var _max_batch_kb := MAX_BATCH_KB
## Events are only kept in memory, never on disk, until the server says the
## player is in: the last launch heard they had opted out.
var _hold_disk := false
var _crash_members := ""
var _previous_crash: Variant = null
var _in_flight := false
var _pump_due := false
var _retry_at := 0.0
var _backoff := 0.0
var _ticket := 0
var _ticket_for := ""
var _ticket_wait := 0.0
var _late_starts := 0
var _restarts := 0
var _consent_due := false
var _catcher: ErrorCatcher = null
var _errors_seen := {}
var _counts := {}
var _last_progress := {}
var _shut := false

## Engine start to this autoload, to the first frame, to mark_playing(), in ms.
var _init_ms := 0
var _first_frame_ms := -1
var _play_ms := -1
## A boot end that came before the first frame (_boot_event()), and its time.
var _boot_due := ""
var _boot_due_ms := -1
## "first_install", "first_after_update" or "normal", and which session on this
## install this is (prefs.cfg's count, kept on this machine only).
var _boot_kind := ""
var _session_number := 0
## The "boot" load events sent, by what ended the boot.
var _boots := {}
var _frames := FrameStats.new()
var _perf_since := 0.0
var _last_frame_usec := 0
var _last_frame_ms := 0.0
var _scene := ""
var _scene_id := 0
## The longest frame since the tree last had a current scene (watch_scene()).
var _changing_ms := 0.0
var _screen := ""
## No screen named, or screen(""): the screen is the scene's (screen_of_scene()).
var _screen_follows_scene := true
var _focused := true
var _last_input_at := 0.0
var _input_kind := ""
var _input_device := -1
var _idle := false
var _idle_since := 0.0
var _active_s := 0.0
var _idle_s := 0.0
## The node track_player() named, held weakly so a freed player is no trouble,
## and the last position it was seen at ({} before any).
var _player: WeakRef = null
var _position_since := 0.0
var _last_position := {}
var _screen_since := 0.0
## Achievements recorded this session, by name, so Steam's callback and the
## game's own call make one event between them.
var _achieved := {}
## Steam's side of the session (_steam_context()), asked once.
var _steam_info := {}


#region Lifecycle
func _init() -> void:
	_init_ms = Time.get_ticks_msec()


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS


## Per frame, and cheap: one clock read and one bucket for the frame's time, and
## a look at whether the scene is still the same node.
func _process(delta: float) -> void:
	if _first_frame_ms < 0 and get_tree().current_scene != null:
		_first_frame_ms = int(ticks_msec.call())
		if not _boot_due.is_empty() and is_recording():
			_send_boot(_boot_due, _boot_due_ms)
	if is_recording():
		var now := Time.get_ticks_usec()
		if _last_frame_usec > 0:
			frame((now - _last_frame_usec) / 1000.0)
		_last_frame_usec = now
		watch_scene(get_tree().current_scene)
	advance(delta)


## The scene tree's current scene, this frame. A change_scene_to_file() leaves
## the tree without one for a frame, between the old scene going and the new one
## coming: that frame is part of the change, not a scene of its own, so the
## "load" goes from the old scene to the new one, with the longest frame of the
## change (the load is in one of them).
func watch_scene(scene: Node) -> void:
	if scene == null:
		_changing_ms = maxf(_changing_ms, _last_frame_ms)
		return
	var id := scene.get_instance_id()
	if id == _scene_id:
		_changing_ms = 0.0
		return
	_scene_id = id
	scene_changed(scene.scene_file_path, maxf(_last_frame_ms, _changing_ms))
	_changing_ms = 0.0


func _notification(what: int) -> void:
	match what:
		NOTIFICATION_WM_CLOSE_REQUEST:
			# A game may still call the close off ("Quit?"), so the session ends
			# at _exit_tree; what it has so far is written down now.
			if is_recording():
				_cut_batch()
		NOTIFICATION_CRASH:
			if _ring != null:
				_ring.flush()
		NOTIFICATION_APPLICATION_FOCUS_IN:
			set_focused(true)
		NOTIFICATION_APPLICATION_FOCUS_OUT:
			set_focused(false)


## At quit, the last any node hears, however the game quits.
func _exit_tree() -> void:
	shutdown()


## Time passing: the clock events are stamped with, the minute's cut, errors
## caught, the ring flushed, and the next request when one is due.
func advance(delta: float) -> void:
	_clock += delta
	if _ticket_wait > 0.0:
		_ticket_wait -= delta
		if _ticket_wait <= 0.0:
			_ticket_for = ""
			_cancel_ticket()
			_back_off()
	if is_recording():
		if not (is_inside_tree() and get_tree().paused):
			_t += delta
		_drain_errors()
		_since_cut += delta
		if _since_cut >= _upload_every:
			_cut_batch()
		_perf_since += delta
		if _perf_since >= PERF_EVERY_S:
			_perf("interval")
		_watch_idle(delta)
		_position_since += delta
		if _position_since >= position_every_s:
			_position_since = 0.0
			if not _idle and not (is_inside_tree() and get_tree().paused):
				_sample_position()
		_ring.flush()
	if _pump_due and _clock >= _retry_at:
		_pump()


## Whether this run collects at all: never in the editor, a debug build or a
## test -- a test runs on the editor's binary, which is a debug build -- unless
## FOURGAMES_DATA_DEV=1. A release build always does, whichever scene calls
## start().
func is_enabled() -> bool:
	if force_enabled or OS.get_environment(DEV_ENV) == "1":
		return true
	return not (OS.is_debug_build() or OS.has_feature("editor"))


func is_recording() -> bool:
	return _state == State.STARTING or _state == State.LIVE


## "off", "starting", "live" or "opted out", for a debug overlay.
func status() -> String:
	return ["off", "starting", "live", "opted out"][_state]
#endregion


#region The game's calls
## Starts the session, once a run: call it after Steam is up, with the game's
## settings as flat key -> scalar. Every later call is ignored.
func start(app_id: int, settings := {}) -> void:
	if _started:
		return
	_started = true
	_app_id = app_id
	for key: Variant in settings:
		_settings[str(key)] = _scalar(settings[key])
	if not is_enabled():
		_say("off in the editor, debug builds and tests (%s=1 turns it on)" % DEV_ENV)
		return
	_steam = steam if steam != null else (Engine.get_singleton(STEAM) if Engine.has_singleton(STEAM) else null)
	if _steam == null or not _steam.has_method(&"getAuthTicketForWebApi") \
			or not _steam.has_signal(&"get_ticket_for_web_api"):
		_say("off: Steam is not here")
		return
	if base_url.is_empty():
		base_url = OS.get_environment(URL_ENV) if not OS.get_environment(URL_ENV).is_empty() else DEFAULT_URL
	base_url = base_url.trim_suffix("/")
	if log_path.is_empty():
		log_path = str(ProjectSettings.get_setting("debug/file_logging/log_path", "user://logs/godot.log"))
	_load_prefs()
	_disk()
	_ring = Ring.new(root_dir.path_join("ring.jsonl"), RING_SIZE)
	if transport == null:
		var made := Transport.new()
		made.name = "Transport"
		add_child(made)
		transport = made
	if not _steam.is_connected(&"get_ticket_for_web_api", _on_ticket):
		_steam.connect(&"get_ticket_for_web_api", _on_ticket)
	_run_started = int(unix_now.call())
	if bool(_prefs.opted_out):
		_forget_everything()
		_state = State.OPTED_OUT
		_consent_due = not bool(_prefs.told)
		_pump_due = _consent_due
		return
	_hold_disk = bool(_prefs.server_opted_out)
	_count_the_launch()
	if not _hold_disk:
		_read_crash()
		_ring.open()
	_queue.prune(unix_now.call(), "", STALE_S, TOKEN_LIFE_S)
	_queue.hold_writes = _hold_disk
	_watch_the_player()
	_open_session()
	_record("input", "", _input_info(true))
	_record("steam", "", _steam_context())
	_hear_steam()
	if _play_ms >= 0:
		_boot_event("mark_playing")
	if catch_errors:
		_catcher = ErrorCatcher.new()
		OS.add_logger(_catcher)
	_say("recording, for %s" % base_url)


## Something the player did, named by the game: "plant_seed", {"x": 3, "crop": "carrot"}.
func action(action_name: String, data := {}) -> void:
	_record("action", action_name, data)


## How far the player is: {"day": 4, "coins": 120}. The last one also goes in
## the session's summary.
func progress(data: Dictionary) -> void:
	if is_recording():
		_last_progress = _plain(data)
	_record("progress", "", data)


## A small summary of the game's state, every ~30 s, so a session can be followed.
func snapshot(data: Dictionary) -> void:
	_record("snapshot", "", data)


## A seed the game rolled from, so a session's dice can be replayed.
func rng(rng_name: String, seed_value: int) -> void:
	_record("rng", rng_name, {"seed": seed_value})


## Anything else the game wants kept, named by it.
func custom(custom_name: String, data := {}) -> void:
	_record("custom", custom_name, data)


## A setting, as it is now. Before start() it only fills in the settings the
## session starts with; after, a change is a "setting_changed" event with the
## old value and the new. Neither is kept without consent.hardware.
func set_setting(key: String, value: Variant) -> void:
	var plain: Variant = _scalar(value)
	var old: Variant = _settings.get(key)
	if _settings.has(key) and typeof(old) == typeof(plain) and old == plain:
		return
	_settings[key] = plain
	if share_hardware:
		_record("setting_changed", "", {"key": key, "old": old, "new": plain})


## The menu or screen now up ("main_menu", "options", "map"), when the game
## names them: a "screen" event, a "ui" "screen" event with the seconds the one
## before was up, and where /session/end says the player left. screen("") is
## plain gameplay, named after the scene's file ("res://level_1.tscn" is
## "level_1"); so is every scene the game names no screen for, and while it
## does, the screen follows the scene from one to the next.
func screen(screen_name: String) -> void:
	_screen_follows_scene = screen_name.is_empty()
	_switch_screen(screen_name if not screen_name.is_empty() else _scene_screen())


## A screen name for the scene at `path`: its file's name, "" for none.
static func screen_of_scene(path: String) -> String:
	return path.get_file().get_basename()


## The screen for the scene up now: the tree's current scene when there is one
## (a scene's _ready() comes before this autoload sees the change), else the last
## scene seen.
func _scene_screen() -> String:
	if is_inside_tree() and get_tree().current_scene != null:
		var scene := get_tree().current_scene
		if not scene.scene_file_path.is_empty():
			return screen_of_scene(scene.scene_file_path)
	return screen_of_scene(_scene)


func _switch_screen(screen_name: String) -> void:
	if screen_name == _screen:
		return
	var from := _screen
	_leave_screen()
	_screen = screen_name
	_screen_since = _clock
	_record("screen", "", {"name": screen_name, "from": from})


## Something the player did with the interface rather than the game: a "ui"
## event, named by the game in snake_case ("tutorial_skipped", "help_opened",
## "hint_shown"), with the screen it happened on.
func ui(event_name: String, data := {}) -> void:
	var with_screen := data.duplicate()
	if not with_screen.has("screen"):
		with_screen["screen"] = _screen
	_record("ui", event_name, with_screen)


## The node the player is, a Node2D or a Node3D, for the heatmaps. Call it
## again after a respawn or a scene change; null stops the tracking.
func track_player(node: Node) -> void:
	_player = weakref(node) if node is Node2D or node is Node3D else null
	_position_since = 0.0
	_last_position = {}
	_sample_position()


## The player died: a "death" event with the scene and where they stood, the
## cause and anything else the game adds.
func death(cause := "", data := {}) -> void:
	var event: Dictionary = _plain(data)
	event["cause"] = cause
	event["scene"] = _scene
	var at := _player_at()
	for key: String in at:
		if key != "scene":
			event[key] = at[key]
	_record("death", "", event)


## An achievement unlocked, for a game that would rather say so than wait for
## Steam's callback; once per name per session either way.
func achievement(api_name: String) -> void:
	if _achieved.has(api_name) or not is_recording():
		return
	_achieved[api_name] = true
	_record("achievement", "", {"name": api_name, "scene": _scene, "playtime_s": int(_t)})


## The player can play now: the end of the boot, once a run. Without it the
## first scene change after the main scene stands in.
func mark_playing() -> void:
	if _play_ms >= 0:
		return
	_play_ms = int(ticks_msec.call())
	_boot_event("mark_playing")


## A load the game timed itself (a threaded one, which no frame shows): a
## "load" event named "game".
func loaded(what: String, ms: float) -> void:
	_record("load", "game", {"what": what, "ms": snappedf(ms, 0.1)})


## Whether nothing is being collected because the player said no: here, or on
## the website or the Discord bot as the server last said.
func opted_out() -> bool:
	if _state == State.OPTED_OUT:
		return true
	if _prefs.is_empty():
		_load_prefs()
	return bool(_prefs.opted_out)


## The player's own switch, kept on this machine and told to the server at once
## (a session/start with consent.gameplay false). Turning it on deletes what is
## still unsent; turning it off starts a session again when one was started.
func set_opt_out(on: bool) -> void:
	if _prefs.is_empty():
		_load_prefs()
	if bool(_prefs.opted_out) == on:
		return
	_prefs.opted_out = on
	_prefs.told = false
	_save_prefs()
	if on:
		_forget_everything()
		if _started and _steam != null:
			_state = State.OPTED_OUT
			_consent_due = true
			_pump_due = true
		return
	_consent_due = false
	if _started and _state == State.OPTED_OUT:
		_state = State.OFF
		_started = false
		start(_app_id, _settings)
#endregion


#region Recording
func _record(type: String, event_name: String, data: Variant) -> void:
	if not is_recording():
		return
	var event := {"t": snappedf(_t, 0.001), "type": type}
	if not event_name.is_empty():
		event["name"] = event_name.left(NAME_CHARS)
	event["data"] = _plain(data) if data is Dictionary else {"value": _plain(data)}
	var line := JSON.stringify(event, "", false)
	if line.length() > EVENT_BYTES:
		event["data"] = {"truncated": line.length()}
		line = JSON.stringify(event, "", false)
	_buffer.append(line)
	_buffer_bytes += line.length() + 1
	_counts[type] = int(_counts.get(type, 0)) + 1
	if not _hold_disk:
		_ring.add(line)
	if _buffer.size() >= MAX_BATCH_EVENTS or _buffer_bytes >= RAW_BATCH_BYTES:
		_cut_batch()


## The buffer, as batches in the queue: as many as the server's caps need.
func _cut_batch() -> void:
	_since_cut = 0.0
	if _buffer.is_empty():
		return
	if _hold_disk:
		# Nothing goes to disk before the server says the player is in; a long
		# wait for that answer keeps the newest events.
		if _buffer.size() >= MAX_BATCH_EVENTS:
			_buffer = _buffer.slice(_buffer.size() - (MAX_BATCH_EVENTS >> 1))
			_buffer_bytes = 0
			for line in _buffer:
				_buffer_bytes += line.length() + 1
		return
	_write_events(_buffer)
	_buffer = PackedStringArray()
	_buffer_bytes = 0
	var record := _queue.session(_local)
	if not record.is_empty():
		record["seq"] = _seq
		_queue.put_session(_local, record)
	_pump_due = true


## One batch, or halves of it until each fits the server's max_batch_kb gzipped.
func _write_events(lines: PackedStringArray) -> void:
	var members := "\"seq\":%d,\"events\":[%s]" % [_seq, ",".join(lines)]
	var gz := members.to_utf8_buffer().compress(FileAccess.COMPRESSION_GZIP)
	# A KB spare for the session id the upload splices in.
	if gz.size() > (_max_batch_kb - 1) * 1024 and lines.size() > 1:
		@warning_ignore("integer_division")
		var half := lines.size() / 2
		_write_events(lines.slice(0, half))
		_write_events(lines.slice(half))
		return
	_queue.add("events", _local, _seq, gz)
	_seq += 1


## The end of the run: the last batch and /session/end written down, the crash
## marker taken away, and -- while the server has been answering -- what this
## session still owes sent at once, all of it under QUIT_BUDGET_MS. Called from
## _exit_tree, the last thing any node hears at quit; safe to call twice.
func shutdown() -> void:
	if _shut:
		return
	_shut = true
	if is_recording():
		_drain_errors()
	_release_catcher()
	if not is_recording():
		return
	if _hold_disk:
		_state = State.OFF
		return
	_perf("quit")
	_leave_screen()
	if not _boot_due.is_empty():
		_send_boot(_boot_due, _boot_due_ms)
	elif _boots.is_empty():
		_boot_event("quit")
	var here := _player_at()
	if not here.is_empty():
		_last_position = here
	_cut_batch()
	# Whole seconds that never add up to more than the playtime.
	var active := mini(int(_active_s), int(_t))
	var summary := {
		"events": _counts.values().reduce(func(sum: int, n: int) -> int: return sum + n, 0),
		"actions": int(_counts.get("action", 0)),
		"errors": _errors_seen.values().reduce(func(sum: int, n: int) -> int: return sum + n, 0),
		"progress": _last_progress,
		"last_scene": _scene,
		"last_screen": _screen,
		"last_position": _last_position if not _last_position.is_empty() else null,
		"playtime_s": int(_t),
		"active_s": active,
		"idle_s": mini(int(_idle_s), int(_t) - active),
		"first_session": _session_number == 1,
		"session_number": _session_number,
		"boot_kind": _boot_kind,
	}
	var members := "\"seq\":%d,\"playtime_s\":%d,\"summary\":%s" % [_seq, int(_t), JSON.stringify(summary, "", false)]
	_queue.add("end", _local, _seq, members.to_utf8_buffer().compress(FileAccess.COMPRESSION_GZIP))
	_ring.close()
	_remove_running()
	_state = State.OFF
	if _backoff <= 0.0 and not str(_queue.session(_local).get("sid", "")).is_empty():
		_send_before_quit()


## This session's queue, oldest first, until the budget runs out or the server
## stops answering; the rest goes on the next launch. A batch the threaded
## request was still sending goes again: the quit stops that request, and the
## server keeps a repeated seq once.
func _send_before_quit() -> void:
	var deadline := int(ticks_msec.call()) + QUIT_BUDGET_MS
	var record := _queue.session(_local)
	for item_name in _queue.items():
		var item := Queue.parse(item_name)
		if item.is_empty() or item.local != _local:
			continue
		if int(ticks_msec.call()) >= deadline:
			return
		var request := _request_for(item_name, item, record)
		if request.is_empty():
			continue
		var code: int = transport.send_now(base_url + request.path, request.headers, request.body, deadline)
		if (code >= 200 and code < 300) or code == 409 or code in REFUSED:
			_queue.remove(item_name)
		else:
			return
#endregion


#region Session
func _open_session() -> void:
	_local = _new_id()
	_seq = 0
	_queue.put_session(_local, {"start": _start_members(true), "sid": "", "token": "",
			"token_at": 0, "seq": 0, "created": int(unix_now.call())})
	_previous_crash = null
	if not _crash_members.is_empty():
		_queue.add("crash", _local, 0, _crash_members.to_utf8_buffer().compress(FileAccess.COMPRESSION_GZIP))
		_crash_members = ""
	if not _hold_disk:
		_write_running()
	_state = State.STARTING
	_pump_due = true


## session/start's members, without the ticket and the braces.
func _start_members(gameplay: bool) -> String:
	var share := share_hardware and gameplay
	var body := {
		"app_id": _app_id,
		"game_version": _version(),
		"build_id": _build_id(),
		"godot_version": _godot_version(),
		"platform": Hardware.platform(),
		"locale": TranslationServer.get_locale(),
		"consent": {"gameplay": gameplay, "hardware": share},
		"hardware": Hardware.collect(_steam) if share else null,
		"settings": _settings.duplicate() if share else null,
		"previous_crash": _previous_crash if gameplay else null,
		"boot_kind": _boot_kind if gameplay else null,
		"first_session": _session_number == 1 if gameplay else null,
		"input": _input_info(true) if share else null,
		"dlc": _dlc() if gameplay else null,
		"steam": _steam_context() if gameplay else null,
	}
	var text := JSON.stringify(body, "", false)
	return text.substr(1, text.length() - 2)


## One step of the queue a call: the run's own session started first, then a
## session an earlier run never started, then the oldest item that can go.
func _pump() -> void:
	_pump_due = false
	if _in_flight or _ticket != 0 or _ticket_for != "":
		return
	if _state == State.OPTED_OUT:
		if _consent_due:
			_request_ticket(CONSENT)
		return
	if not is_recording():
		return
	if str(_queue.session(_local).get("sid", "")).is_empty():
		_request_ticket(_local)
		return
	for item_name in _queue.items():
		var item := Queue.parse(item_name)
		var record := _queue.session(item.get("local", ""))
		if item.is_empty() or record.is_empty():
			_queue.remove(item_name)
			continue
		if str(record.get("sid", "")).is_empty():
			if _late_starts < LATE_STARTS:
				_late_starts += 1
				_request_ticket(item.local)
				return
			continue
		if float(unix_now.call()) - float(record.get("token_at", 0)) > TOKEN_LIFE_S:
			_queue.drop_session(item.local)
			continue
		var request := _request_for(item_name, item, record)
		if request.is_empty():
			_queue.remove(item_name)
			continue
		_post(request.path, request.body, request.headers, _on_sent.bind(item_name, item.local))
		return


## {path, headers, body} for a queued item, the session id spliced in; {} when
## its body is gone or the kind is unknown.
func _request_for(item_name: String, item: Dictionary, record: Dictionary) -> Dictionary:
	var members := _queue.read(item_name)
	if members.is_empty():
		return {}
	var sid := JSON.stringify(str(record.get("sid", "")))
	var headers := PackedStringArray(["Content-Type: application/json",
			"Authorization: Bearer " + str(record.get("token", ""))])
	match item.kind:
		"events":
			headers.append("Content-Encoding: gzip")
			var text := "{\"session_id\":%s,%s}" % [sid, members]
			return {"path": "/events", "headers": headers,
					"body": text.to_utf8_buffer().compress(FileAccess.COMPRESSION_GZIP)}
		"end":
			return {"path": "/session/end", "headers": headers,
					"body": ("{\"session_id\":%s,%s}" % [sid, members]).to_utf8_buffer()}
		"crash":
			return {"path": "/crash", "headers": headers, "body": ("{%s}" % members).to_utf8_buffer()}
	return {}


func _post(path: String, body: PackedByteArray, headers: PackedStringArray, done: Callable) -> void:
	_in_flight = true
	transport.send(base_url + path, headers, body, done)


func _on_sent(code: int, _reply: PackedByteArray, item_name: String, local: String) -> void:
	_in_flight = false
	if (code >= 200 and code < 300) or code == 409:
		_queue.remove(item_name)
		_clear_backoff()
	elif code == 401 or code == 403:
		# The token is no good any more, and nothing can make it good.
		_queue.drop_session(local)
		if local == _local and is_recording():
			_reopen()
	elif code in REFUSED:
		_queue.remove(item_name)
	else:
		_back_off()
		return
	_pump_due = true


## A new session for the rest of the run, after the server refused the token.
func _reopen() -> void:
	if _restarts >= RESTARTS:
		_go_off("the server keeps refusing the session's token")
		return
	_restarts += 1
	_open_session()
#endregion


#region Steam's ticket and session/start
func _request_ticket(for_what: String) -> void:
	var handle := int(_steam.call(&"getAuthTicketForWebApi", IDENTITY))
	if handle <= 0:
		_back_off()
		return
	_ticket = handle
	_ticket_for = for_what
	_ticket_wait = TICKET_TIMEOUT_S


## GodotSteam's get_ticket_for_web_api.
func _on_ticket(handle: int, result: int, ticket_size: int, buffer: PackedByteArray) -> void:
	if handle != _ticket or _ticket_for.is_empty():
		return
	var for_what := _ticket_for
	_ticket_for = ""
	_ticket_wait = 0.0
	if result != STEAM_OK or ticket_size <= 0 or buffer.is_empty():
		_cancel_ticket()
		_back_off()
		return
	var hex := buffer.slice(0, mini(ticket_size, buffer.size())).hex_encode()
	var members := _start_members(false) if for_what == CONSENT else str(_queue.session(for_what).get("start", ""))
	if members.is_empty():
		_cancel_ticket()
		_pump_due = true
		return
	var text := "{\"ticket\":%s,%s}" % [JSON.stringify(hex), members]
	_post("/session/start", text.to_utf8_buffer(), PackedStringArray(["Content-Type: application/json"]),
			_on_started.bind(for_what))


func _on_started(code: int, body: PackedByteArray, for_what: String) -> void:
	_in_flight = false
	_cancel_ticket()
	if code == 0 or code == 408 or code == 429 or code >= 500:
		_back_off()
		return
	_clear_backoff()
	_pump_due = true
	var reply := _parse(body)
	if for_what == CONSENT:
		_consent_due = false
		if code >= 200 and code < 300:
			_prefs.told = true
			_save_prefs()
		return
	var sid := str(reply.get("session_id", ""))
	var token := str(reply.get("token", ""))
	var opted := bool(reply.get("opted_out", false))
	if code < 200 or code >= 300 or not bool(reply.get("ok", false)) or (not opted and (sid.is_empty() or token.is_empty())):
		_queue.drop_session(for_what)
		if for_what == _local:
			_go_off("the server turned the session down (%d %s)" % [code, reply.get("error", "")])
		return
	if opted:
		_queue.drop_session(for_what)
		if for_what == _local:
			_forget_everything()
			_state = State.OPTED_OUT
			_prefs.server_opted_out = true
			_save_prefs()
			_say("the player opted out: nothing is kept")
		return
	var record := _queue.session(for_what)
	record["sid"] = sid
	record["token"] = token
	record["token_at"] = int(unix_now.call())
	_queue.put_session(for_what, record)
	if for_what != _local:
		return
	_state = State.LIVE
	_upload_every = clampf(float(reply.get("upload_every_s", UPLOAD_EVERY_S)), 10.0, 3600.0)
	_max_batch_kb = clampi(int(reply.get("max_batch_kb", MAX_BATCH_KB)), 16, MAX_BATCH_KB)
	if bool(_prefs.server_opted_out):
		_prefs.server_opted_out = false
		_save_prefs()
	if _hold_disk:
		# In after all: what was held goes to disk like everything after it.
		_hold_disk = false
		_queue.release()
		_ring.open()
		for line in _buffer:
			_ring.add(line)
	_write_running()


func _cancel_ticket() -> void:
	if _ticket > 0 and _steam != null and _steam.has_method(&"cancelAuthTicket"):
		_steam.call(&"cancelAuthTicket", _ticket)
	_ticket = 0


func _back_off() -> void:
	_backoff = BACKOFF_FIRST_S if _backoff <= 0.0 else minf(_backoff * 2.0, BACKOFF_MAX_S)
	_retry_at = _clock + _backoff * randf_range(0.8, 1.2)
	_pump_due = true


func _clear_backoff() -> void:
	_backoff = 0.0
	_retry_at = 0.0


## Stops for the rest of the run and lets this run's data go.
func _go_off(why: String) -> void:
	_say("off: " + why)
	_state = State.OFF
	_buffer.clear()
	_buffer_bytes = 0
	_queue.drop_session(_local)
	_ring.remove()
	_remove_running()
	_release_catcher()


## Everything this machine holds for the player: the queue, the sessions, the
## ring and the crash marker.
func _forget_everything() -> void:
	_buffer.clear()
	_buffer_bytes = 0
	_crash_members = ""
	_disk().clear()
	if _ring != null:
		_ring.remove()
	elif FileAccess.file_exists(root_dir.path_join("ring.jsonl")):
		DirAccess.remove_absolute(root_dir.path_join("ring.jsonl"))
	_remove_running()
	_release_catcher()
#endregion


#region Crashes
func _running_path() -> String:
	return root_dir.path_join("running.json")


func _write_running() -> void:
	var file := FileAccess.open(_running_path(), FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify({
		"local": _local,
		"session_id": str(_queue.session(_local).get("sid", "")),
		"game_version": _version(),
		"os": Hardware.os_name() if share_hardware else "",
		"started": _run_started,
		"last_scene": _scene,
		"last_screen": _screen,
		"playtime_s": int(_t),
		"first_session": _session_number == 1,
	}, "", false))
	file.close()


func _remove_running() -> void:
	if FileAccess.file_exists(_running_path()):
		DirAccess.remove_absolute(_running_path())


## The last run never quit: its marker, ring and log become a crash report,
## queued under the session this run is about to open.
func _read_crash() -> void:
	if not FileAccess.file_exists(_running_path()):
		return
	var info := _parse(FileAccess.get_file_as_bytes(_running_path()))
	var events := Ring.read_last(_ring.path, RING_SIZE)
	var kept := 0
	var first := events.size()
	while first > 0 and kept + events[first - 1].length() + 1 <= CRASH_EVENTS_BYTES:
		first -= 1
		kept += events[first].length() + 1
	events = events.slice(first)
	var tail := scrub(_log_tail(int(info.get("started", 0))))
	var signal_name := crash_signal(tail)
	var sid := str(info.get("session_id", ""))
	var sid_json := JSON.stringify(sid) if not sid.is_empty() else "null"
	# Where the crashed run was, as its marker last heard: types made whole
	# again, since the marker was read back as JSON.
	var quit_point := {
		"last_scene": str(info.get("last_scene", "")),
		"last_screen": str(info.get("last_screen", "")),
		"playtime_s": int(info.get("playtime_s", 0)),
		"first_session": bool(info.get("first_session", false)),
		"last_position": _last_position_in(events),
	}
	_crash_members = "\"crashed_session_id\":%s,\"game_version\":%s,\"log_tail\":%s,\"last_events\":[%s],\"signal\":%s,\"os\":%s,\"quit_point\":%s" % [
		sid_json, JSON.stringify(str(info.get("game_version", _version()))), JSON.stringify(tail),
		",".join(events), JSON.stringify(signal_name), JSON.stringify(str(info.get("os", ""))),
		JSON.stringify(quit_point, "", false)]
	_previous_crash = {"crashed_session_id": sid if not sid.is_empty() else null, "signal": signal_name}
	_remove_running()


## The end of the log the crashed run wrote, at most LOG_TAIL_BYTES, from its
## first whole line.
func _log_tail(since: int) -> String:
	var path := crashed_log(log_path, since)
	var file := FileAccess.open(path, FileAccess.READ) if not path.is_empty() else null
	if file == null:
		return ""
	var length := file.get_length()
	var from := maxi(length - LOG_TAIL_BYTES, 0)
	file.seek(from)
	var bytes := file.get_buffer(length - from)
	if from > 0:
		var newline := bytes.find(10)
		if newline >= 0:
			bytes = bytes.slice(newline + 1)
	return bytes.get_string_from_utf8()


## Which log the run that began at `since` (unix seconds) left. Godot renames
## the last run's godot.log to godot<date>.log as a new run starts, so it is the
## oldest of those written to since that run began; any later ones are runs that
## never started a session. "" when logging kept none.
static func crashed_log(current_log: String, since: int) -> String:
	var folder := current_log.get_base_dir()
	if not DirAccess.dir_exists_absolute(folder):
		return ""
	var current := current_log.get_file()
	var stem := current.get_basename()
	var best := ""
	var best_time := 0
	for file in DirAccess.get_files_at(folder):
		if file == current or not file.begins_with(stem) or file.get_extension() != current.get_extension():
			continue
		var at := folder.path_join(file)
		var time := int(FileAccess.get_modified_time(at))
		if since > 0:
			if time + 1 < since:
				continue
			if best.is_empty() or time < best_time:
				best = at
				best_time = time
		elif best.is_empty() or time > best_time:
			best = at
			best_time = time
	return best


## What killed the run, as far as its log says: the crash handler names the
## signal ("Program crashed with signal 11"), Windows only says it crashed, and a
## run killed from outside says nothing at all.
static func crash_signal(tail: String) -> String:
	var found := RegEx.create_from_string("crashed with signal (\\d+)").search(tail)
	if found != null:
		return SIGNALS.get(int(found.get_string(1)), "signal " + found.get_string(1))
	if tail.contains("Program crashed"):
		return "crash"
	return "unclean exit"


## The player's home folder out of a log line or an error, which would name them.
static func scrub(text: String) -> String:
	for key in ["HOME", "USERPROFILE"]:
		var home := OS.get_environment(key)
		if home.length() >= 3:
			text = text.replace(home, "~").replace(home.replace("\\", "/"), "~")
	return text
#endregion


#region What the plugin watches for itself
## Which launch on this install this is: the first ever, the first since the
## game_version changed, or another. Kept in prefs.cfg, on this machine only.
func _count_the_launch() -> void:
	if not _boot_kind.is_empty():
		return
	var count := int(_prefs.get("sessions", 0))
	if count == 0:
		_boot_kind = "first_install"
	elif str(_prefs.get("last_version", "")) != _version():
		_boot_kind = "first_after_update"
	else:
		_boot_kind = "normal"
	_session_number = count + 1
	_prefs.sessions = _session_number
	_prefs.last_version = _version()
	_save_prefs()


## The window's input, its focus and the scene it shows, from start() on.
func _watch_the_player() -> void:
	_last_input_at = _clock
	_idle_since = _clock
	_input_kind = _guess_input()
	if is_inside_tree():
		if DisplayServer.get_name() != "headless":
			_focused = DisplayServer.window_is_focused()
		if not get_tree().root.window_input.is_connected(_on_window_input):
			get_tree().root.window_input.connect(_on_window_input)
		var scene := get_tree().current_scene
		if scene != null:
			_scene_id = scene.get_instance_id()
			_scene = scene.scene_file_path
	_follow_scene()


func _on_window_input(event: InputEvent) -> void:
	if event is InputEventKey or (event is InputEventMouse and event.device != InputEvent.DEVICE_ID_EMULATION):
		note_input(KEYBOARD_MOUSE, event.device)
	elif event is InputEventJoypadButton \
			or (event is InputEventJoypadMotion and absf((event as InputEventJoypadMotion).axis_value) > STICK_DEADZONE):
		note_input(CONTROLLER, event.device)
	elif event is InputEventScreenTouch or event is InputEventScreenDrag:
		note_input(TOUCH, event.device)


## The player touched something: they are here, and maybe on a new device.
func note_input(kind: String, device := 0) -> void:
	_last_input_at = _clock
	if kind == _input_kind and (kind != CONTROLLER or device == _input_device):
		return
	_input_kind = kind
	_input_device = device
	_record("input", "", _input_info())


func set_focused(on: bool) -> void:
	_focused = on
	if on:
		_last_input_at = _clock


## One frame's time, in ms: into the perf stats while the window has focus (a
## game in the background is throttled, and its frames say nothing).
func frame(ms: float) -> void:
	_last_frame_ms = ms
	if _focused:
		_frames.add(ms)


## The scene tree's current scene is another: the last one's perf, then a
## "load" with the frame the change took (a scene loaded with
## change_scene_to_file() loads inside that frame), and the end of the boot if
## the game never marks it.
func scene_changed(path: String, load_ms: float) -> void:
	if path == _scene:
		return
	var from := _scene
	_scene = path
	if not is_recording() or from.is_empty():
		_follow_scene()
		return
	_perf("scene_change", from)
	_record("load", "scene", {"scene": path, "from": from, "ms": snappedf(load_ms, 0.1)})
	_follow_scene()
	if _boots.is_empty():
		_boot_event("scene_change")
	if not _hold_disk:
		_write_running()


## The frames since the last perf event, the memory, and the marker's quit point.
func _perf(why: String, scene := _scene) -> void:
	var data := _frames.report()
	data["why"] = why
	data["scene"] = scene
	data["screen"] = _screen
	data["focused"] = _focused
	data["idle"] = _idle
	var used := Performance.get_monitor(Performance.MEMORY_STATIC)
	var video := Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED)
	# Static memory is only counted in debug builds; a release reports none.
	data["static_mb"] = snappedf(used / MB, 0.1) if used > 0.0 else null
	data["video_mb"] = snappedf(video / MB, 0.1) if video > 0.0 else null
	_record("perf", "", data)
	_frames.reset()
	_perf_since = 0.0
	if why == "interval" and is_recording() and not _hold_disk:
		_write_running()


## Out of focus, or no input for IDLE_AFTER_S. The switch is put where it
## happened -- the last input, the focus going or coming -- not where it was
## seen, and the seconds between are moved to the side they belonged to. Only
## the playtime counts: a paused tree is neither (it isn't in playtime_s
## either), so active_s and idle_s add up to the playtime.
func _watch_idle(delta: float) -> void:
	if is_inside_tree() and get_tree().paused:
		delta = 0.0
	var idle_now := not _focused or _clock - _last_input_at > IDLE_AFTER_S
	if idle_now == _idle:
		if _idle:
			_idle_s += delta
		else:
			_active_s += delta
		return
	# Between the last frame and this one.
	var at := _clock - delta
	var since := at
	var data := {"idle": idle_now}
	if idle_now and _focused:
		since = maxf(_last_input_at, _idle_since)
		data["why"] = "no_input"
		var moved := minf(at - since, _active_s)
		_active_s -= moved
		_idle_s += moved
	elif idle_now:
		data["why"] = "unfocused"
	else:
		since = clampf(_last_input_at, _idle_since, at)
		var moved := minf(at - since, _idle_s)
		_idle_s -= moved
		_active_s += moved
	data["after_s"] = snappedf(since - _idle_since, 0.1)
	_idle_since = since
	_idle = idle_now
	_record("idle", "", data)
	if _idle:
		_idle_s += delta
	else:
		_active_s += delta


## The boot's "load" event, once the first frame's time is known: a
## mark_playing() from the main scene's _ready() comes before the first frame,
## so it waits for that frame (_process()). Nothing is playable before the
## first frame, so to_play_ms is never less than boot_ms. At quit it goes with
## what is known.
func _boot_event(by: String) -> void:
	if _boots.has(by) or not is_recording():
		return
	if _first_frame_ms < 0 and by != "quit" and is_inside_tree() and not _shut:
		if _boot_due.is_empty():
			_boot_due = by
			_boot_due_ms = int(ticks_msec.call()) if by == "scene_change" else _play_ms
		return
	_send_boot(by, _play_ms if by == "mark_playing" else int(ticks_msec.call()) if by == "scene_change" else -1)


func _send_boot(by: String, play_ms: int) -> void:
	_boots[by] = true
	_boot_due = ""
	var boot: Variant = _first_frame_ms if _first_frame_ms >= 0 else null
	var to_play: Variant = null
	if play_ms >= 0:
		to_play = maxi(play_ms, _first_frame_ms)
	_record("load", "boot", {"boot_kind": _boot_kind, "boot_ms": boot,
			"to_play_ms": to_play, "by": by, "init_ms": _init_ms})


## What the player is playing with. The controller's name, its Steam Input
## type and whether a Deck is docked are hardware, so they need consent.hardware.
func _input_info(guess := false) -> Dictionary:
	var info := {"type": _input_kind}
	if guess:
		info["guess"] = true
	if share_hardware:
		var controller := _input_kind == CONTROLLER
		info["controller"] = Input.get_joy_name(_input_device) if controller and _input_device >= 0 else ""
		info["steam_input"] = _steam_input_type() if controller else ""
		info["deck_mode"] = _deck_mode()
	return info


## Before the first input: a controller if one is plugged in or this is a Deck,
## touch on a phone, else keyboard and mouse.
func _guess_input() -> String:
	var pads := Input.get_connected_joypads()
	if not pads.is_empty():
		_input_device = pads[0]
		return CONTROLLER
	if Hardware.is_steam_deck(_steam):
		_input_device = 0
		return CONTROLLER
	if OS.has_feature("mobile") and DisplayServer.is_touchscreen_available():
		return TOUCH
	return KEYBOARD_MOUSE


## Steam Input's name for the first controller it knows, when the game turned
## Steam Input on (inputInit); "" when it did not.
func _steam_input_type() -> String:
	if _steam == null or not _steam.has_method(&"getConnectedControllers"):
		return ""
	var handles: Variant = _steam.call(&"getConnectedControllers")
	if not handles is Array or handles.is_empty():
		return ""
	var type := int(_steam.call(&"getInputTypeForHandle", handles[0]))
	return STEAM_INPUT_TYPES[type] if type >= 0 and type < STEAM_INPUT_TYPES.size() else "type %d" % type


## "handheld" or "docked" on a Deck, by whether the screen is the Deck's own;
## "" anywhere else.
func _deck_mode() -> String:
	if not Hardware.is_steam_deck(_steam):
		return ""
	var size := DisplayServer.screen_get_size(DisplayServer.window_get_current_screen())
	return "handheld" if size in DECK_SCREENS else "docked"


## Where the tracked player stands: {scene, x, y, rot} in 2D, {scene, x, y,
## z, yaw} in 3D; {} when nothing is tracked or it has left the tree.
func _player_at() -> Dictionary:
	var node: Node = _player.get_ref() if _player != null else null
	if node == null or not node.is_inside_tree():
		return {}
	if node is Node2D:
		var flat := node as Node2D
		var at := flat.global_position
		return {"scene": _scene, "x": snappedf(at.x, 0.1), "y": snappedf(at.y, 0.1),
				"rot": snappedf(flat.global_rotation, 0.01)}
	var deep := node as Node3D
	var where := deep.global_position
	return {"scene": _scene, "x": snappedf(where.x, 0.01), "y": snappedf(where.y, 0.01),
			"z": snappedf(where.z, 0.01), "yaw": snappedf(deep.global_rotation.y, 0.01)}


## A "position" when the player has moved since the last one, or is in
## another scene; standing still sends nothing.
func _sample_position() -> void:
	if not is_recording():
		return
	var at := _player_at()
	if at.is_empty():
		return
	if not _last_position.is_empty() and at.scene == _last_position.scene:
		var dz := float(at.get("z", 0.0)) - float(_last_position.get("z", 0.0))
		var moved := Vector3(at.x - _last_position.x, at.y - _last_position.y, dz).length()
		if moved <= (MOVED_3D if at.has("z") else MOVED_2D):
			return
	_last_position = at
	_record("position", "", at)


## The last position a crashed run's ring holds, for its quit point; null for none.
static func _last_position_in(events: PackedStringArray) -> Variant:
	var json := JSON.new()
	for i in range(events.size() - 1, -1, -1):
		if events[i].contains("\"position\"") and json.parse(events[i]) == OK \
				and json.data is Dictionary and json.data.get("type") == "position":
			return json.data.get("data")
	return null


## The screen up until now, and for how long: a "ui" "screen" event.
## A screen named after the scene, while the game names none of its own.
func _follow_scene() -> void:
	if _screen_follows_scene:
		_switch_screen(screen_of_scene(_scene))


func _leave_screen() -> void:
	if _screen.is_empty() or not is_recording():
		return
	_record("ui", "screen", {"screen": _screen, "seconds": snappedf(_clock - _screen_since, 0.1)})


## Steam's side of the session: its language against the game's, whether the
## game is borrowed through Family Sharing (a yes or no: never whose it is),
## Remote Play and Big Picture.
func _steam_context() -> Dictionary:
	if not _steam_info.is_empty():
		return _steam_info
	var shared := bool(_ask_steam(&"isSubscribedFromFamilySharing", false))
	if not shared and _steam != null and _steam.has_method(&"getAppOwner") and _steam.has_method(&"getSteamID"):
		var owner := int(_steam.call(&"getAppOwner"))
		shared = owner != 0 and owner != int(_steam.call(&"getSteamID"))
	_steam_info = {
		"ui_language": str(_ask_steam(&"getSteamUILanguage", "")),
		"game_language": str(_ask_steam(&"getCurrentGameLanguage", "")),
		"locale": TranslationServer.get_locale(),
		"family_shared": shared,
		"remote_play": int(_ask_steam(&"getSessionCount", 0)) > 0,
		"big_picture": bool(_ask_steam(&"isSteamInBigPictureMode", false)),
	}
	return _steam_info


func _ask_steam(method: StringName, fallback: Variant) -> Variant:
	return _steam.call(method) if _steam != null and _steam.has_method(method) else fallback


## Steam's own news: the overlay, achievements stored, Remote Play sessions.
func _hear_steam() -> void:
	var hooks := {
		&"overlay_toggled": _on_overlay_toggled,
		&"user_achievement_stored": _on_achievement_stored,
		&"remote_play_session_connected": _on_remote_play,
		&"remote_play_session_disconnected": _on_remote_play,
	}
	for hook: StringName in hooks:
		if _steam.has_signal(hook) and not _steam.is_connected(hook, hooks[hook]):
			_steam.connect(hook, hooks[hook])


## Only that it opened or closed, and where the player was.
func _on_overlay_toggled(active: bool, _user_initiated: bool, _app_id: int) -> void:
	_record("overlay", "", {"open": active, "scene": _scene, "screen": _screen})


## Steam stores progress the same way; an unlock is the one with no progress.
func _on_achievement_stored(_game_id: int, _group: bool, api_name: String, _progress: int, out_of: int) -> void:
	if out_of == 0:
		achievement(api_name)


func _on_remote_play(_session_id: int) -> void:
	_steam_info = {}
	_record("steam", "", {"remote_play": int(_ask_steam(&"getSessionCount", 0)) > 0})


## The game's DLC and whether the player owns each, for session/start.
func _dlc() -> Array:
	var out := []
	if _steam == null or not _steam.has_method(&"getDLCCount") or not _steam.has_method(&"getDLCDataByIndex"):
		return out
	for i in mini(int(_steam.call(&"getDLCCount")), DLC_MAX):
		var data: Variant = _steam.call(&"getDLCDataByIndex", i)
		var id := int((data as Dictionary).get("id", 0)) if data is Dictionary else 0
		if id <= 0:
			continue
		var owned := false
		if _steam.has_method(&"isSubscribedApp"):
			owned = bool(_steam.call(&"isSubscribedApp", id))
		elif _steam.has_method(&"isDLCInstalled"):
			owned = bool(_steam.call(&"isDLCInstalled", id))
		out.append({"app_id": id, "owned": owned})
	return out
#endregion


#region Errors
## The engine's errors and the game's script errors, from whichever thread they
## happen on, held under a lock until the next frame takes them. Warnings are
## left alone. Nothing in here may print, or it would hear itself.
class ErrorCatcher extends Logger:
	const HELD := 100
	## How many are waiting: read without the lock, once a frame, so a frame
	## with no error costs one comparison and allocates nothing.
	var pending := 0
	var _lock := Mutex.new()
	var _caught: Array[Dictionary] = []

	func _log_error(function: String, file: String, line: int, code: String, rationale: String,
			_editor_notify: bool, error_type: int, _script_backtraces: Array) -> void:
		if error_type == ERROR_TYPE_WARNING:
			return
		_lock.lock()
		if _caught.size() < HELD:
			_caught.append({"message": rationale if not rationale.is_empty() else code, "file": file,
					"line": line, "function": function, "script": error_type == ERROR_TYPE_SCRIPT})
			pending = _caught.size()
		_lock.unlock()

	func take() -> Array[Dictionary]:
		_lock.lock()
		var out := _caught
		_caught = []
		pending = 0
		_lock.unlock()
		return out


## Each error once a session, as an "error" event; its repeats are counted for
## the summary. At most ERRORS different ones.
func _drain_errors() -> void:
	if _catcher == null or _catcher.pending == 0:
		return
	for caught in _catcher.take():
		var key := "%s:%d:%s" % [caught.file, caught.line, str(caught.message).left(80)]
		if _errors_seen.has(key):
			_errors_seen[key] += 1
			continue
		if _errors_seen.size() >= ERRORS:
			continue
		_errors_seen[key] = 1
		_record("error", "script_error" if caught.script else "engine_error", {
			"message": scrub(str(caught.message)).left(500),
			"file": scrub(str(caught.file)),
			"line": caught.line,
			"function": caught.function,
		})


func _release_catcher() -> void:
	if _catcher != null:
		OS.remove_logger(_catcher)
		_catcher = null
#endregion


#region Helpers
func _disk() -> Queue:
	if _queue == null:
		_queue = Queue.new(root_dir, queue_cap)
	return _queue


func _prefs_path() -> String:
	return root_dir.path_join("prefs.cfg")


func _load_prefs() -> void:
	var cfg := ConfigFile.new()
	cfg.load(_prefs_path())
	_prefs = {
		"opted_out": bool(cfg.get_value("data", "opted_out", false)),
		"told": bool(cfg.get_value("data", "told", true)),
		"server_opted_out": bool(cfg.get_value("data", "server_opted_out", false)),
		"sessions": int(cfg.get_value("data", "sessions", 0)),
		"last_version": str(cfg.get_value("data", "last_version", "")),
	}


func _save_prefs() -> void:
	DirAccess.make_dir_recursive_absolute(root_dir)
	var cfg := ConfigFile.new()
	for key: String in _prefs:
		cfg.set_value("data", key, _prefs[key])
	cfg.save(_prefs_path())


func _version() -> String:
	if not game_version.is_empty():
		return game_version
	var set_in_project := str(ProjectSettings.get_setting("application/config/version", ""))
	return set_in_project if not set_in_project.is_empty() else "unknown"


func _build_id() -> String:
	if _steam != null and _steam.has_method(&"getAppBuildId"):
		return str(int(_steam.call(&"getAppBuildId")))
	return ""


static func _godot_version() -> String:
	var v := Engine.get_version_info()
	return "%d.%d.%d" % [v.major, v.minor, v.patch]


static func _new_id() -> String:
	var b := Crypto.new().generate_random_bytes(16)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	var h := b.hex_encode()
	return "%s-%s-%s-%s-%s" % [h.substr(0, 8), h.substr(8, 4), h.substr(12, 4), h.substr(16, 4), h.substr(20, 12)]


static func _parse(bytes: PackedByteArray) -> Dictionary:
	var json := JSON.new()
	if json.parse(bytes.get_string_from_utf8()) != OK or not json.data is Dictionary:
		return {}
	return json.data


## A value JSON can carry as the game meant it: cells and vectors as arrays,
## names as strings, objects as nothing, and no more than a few levels deep.
static func _plain(value: Variant, depth := 0) -> Variant:
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT:
			return value
		TYPE_FLOAT:
			return value if is_finite(value) else null
		TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(value).left(256)
		TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I:
			return _vector(value)
		TYPE_COLOR:
			return (value as Color).to_html()
		TYPE_DICTIONARY:
			if depth >= 4:
				return null
			var out := {}
			for key: Variant in value:
				if out.size() >= 64:
					break
				out[str(key)] = _plain(value[key], depth + 1)
			return out
		TYPE_OBJECT, TYPE_CALLABLE, TYPE_SIGNAL, TYPE_RID:
			return null
	if value is Array or typeof(value) >= TYPE_PACKED_BYTE_ARRAY:
		if depth >= 4:
			return null
		var list := []
		for item: Variant in value:
			if list.size() >= 64:
				break
			list.append(_plain(item, depth + 1))
		return list
	return str(value).left(256)


static func _vector(value: Variant) -> Array:
	var out := []
	var n := 3 if (value is Vector3 or value is Vector3i) else 2
	for i in n:
		var part: Variant = value[i]
		out.append(snappedf(part, 0.01) if part is float else part)
	return out


## A setting's value: a bool, number or string as it is, anything else as text.
static func _scalar(value: Variant) -> Variant:
	match typeof(value):
		TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return value
		TYPE_FLOAT:
			return value if is_finite(value) else null
		TYPE_STRING_NAME:
			return str(value)
	return str(value).left(256)


func _say(message: String) -> void:
	print("GameData: ", message)
#endregion
