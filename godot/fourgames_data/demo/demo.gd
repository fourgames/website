extends Control

## A stand-in game that calls the GameData API the way a real one would, to try
## the plugin by hand and to show where each call goes:
##
##   start() once Steam is up -- here a frame after boot, without bringing
##   Steam up (the test game in res://game/ does that), so it is only a guide to
##   where each call goes; action() on a press; progress() when the
##   "day" turns; snapshot() every SNAPSHOT_S; set_setting() as a setting moves;
##   and a "Privacy policy" link to PRIVACY_URL.
##
## Run it from the editor or headless: in a debug build the plugin stays off
## unless FOURGAMES_DATA_DEV=1, and FOURGAMES_DATA_URL points it at a local
## server (python3 tests/tools/fake_server.py).

## A real game passes its own Steam app id. This one is Pomo Valley's.
const APP_ID := 5207970
const SNAPSHOT_S := 30.0

var _day := 1
var _coins := 0
var _volume := 0.8
var _since_snapshot := 0.0
var _status: Label
var _opt_out: Button


func _ready() -> void:
	var column := VBoxContainer.new()
	column.position = Vector2(16, 16)
	add_child(column)
	_status = Label.new()
	column.add_child(_status)
	_button(column, "Harvest a carrot", _harvest)
	_button(column, "Next day", _next_day)
	_button(column, "Volume -10%", _quieter)
	_opt_out = _button(column, "Opt out", _toggle_opt_out)
	_button(column, "Privacy policy", func() -> void: OS.shell_open(GameData.PRIVACY_URL))
	# Where a real game calls it: on its Steam manager's "went live".
	await get_tree().process_frame
	GameData.start(APP_ID, {"volume": _volume, "fullscreen": false, "language": TranslationServer.get_locale()})
	GameData.progress({"day": _day, "coins": _coins})


func _process(delta: float) -> void:
	_since_snapshot += delta
	if _since_snapshot >= SNAPSHOT_S:
		_since_snapshot = 0.0
		GameData.snapshot({"day": _day, "coins": _coins, "scene": "demo"})
	_status.text = "GameData: %s%s" % [GameData.status(), " (opted out)" if GameData.opted_out() else ""]
	_opt_out.text = "Opt back in" if GameData.opted_out() else "Opt out"


func _harvest() -> void:
	_coins += 3
	GameData.action("harvest", {"crop": "carrot", "amount": 3, "at": Vector2i(4, 7)})


func _next_day() -> void:
	_day += 1
	GameData.progress({"day": _day, "coins": _coins})


func _quieter() -> void:
	_volume = maxf(snappedf(_volume - 0.1, 0.1), 0.0)
	GameData.set_setting("volume", _volume)


func _toggle_opt_out() -> void:
	GameData.set_opt_out(not GameData.opted_out())


func _button(parent: Control, text: String, pressed: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(pressed)
	parent.add_child(button)
	return button
