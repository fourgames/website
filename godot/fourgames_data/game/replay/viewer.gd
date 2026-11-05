extends Control

## The replay viewer: open a player's data download (the .zip from
## fourgames.se/privacy, or the sessions.json of an unzipped one) or paste a
## session copied in the feedback dashboard (Game data, Copy for replay), pick a
## session, and watch it again -- the level, the path, a marker moving in time
## with play/pause at 1x, 4x or 16x, a timeline to scrub with a tick per coin,
## death, level complete and setting change, and the events alongside,
## highlighted as the replay passes them. "Copy for Claude" puts a summary of
## the session on the clipboard (and shows it, to copy by hand if need be).
##
## A file can also be dropped on the window, or named on the command line:
##   Godot --path . res://game/replay/viewer.tscn -- --open ~/Downloads/fourgames-data.zip

const ExportReader := preload("res://game/replay/export_reader.gd")
const Timeline := preload("res://game/replay/timeline.gd")
const Summary := preload("res://game/replay/summary.gd")
const ReplayCanvas := preload("res://game/replay/replay_canvas.gd")
const TimelineBar := preload("res://game/replay/timeline_bar.gd")

const SPEEDS: Array[float] = [1.0, 4.0, 16.0]

var sessions: Array = []
var timeline: Timeline = null
var time := 0.0
var playing := false
var speed := 1.0

var _status: Label = null
var _session_list: ItemList = null
var _event_list: ItemList = null
var _canvas: ReplayCanvas = null
var _bar: TimelineBar = null
var _play: Button = null
var _speed: OptionButton = null
var _clock: Label = null
var _heat: CheckButton = null
var _copy: Button = null
var _dialog: FileDialog = null
var _text_popup: AcceptDialog = null
var _text: TextEdit = null
var _listed_at := -2


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_build()
	GameData.screen("replay_viewer")
	get_window().files_dropped.connect(func(files: PackedStringArray) -> void:
		if not files.is_empty():
			open_file(files[0]))
	var args := OS.get_cmdline_user_args()
	var at := args.find("--open")
	if at >= 0 and at + 1 < args.size():
		open_file(args[at + 1].replace("~", OS.get_environment("HOME")))


func _process(delta: float) -> void:
	if not playing or timeline == null:
		return
	seek(time + delta * speed)
	if time >= timeline.duration:
		set_playing(false)


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed(&"ui_cancel"):
		_back()
		get_viewport().set_input_as_handled()


#region What it does
## Reads a download; the session list shows what is in it. False if it could not.
func open_file(path: String) -> bool:
	return _show(ExportReader.open(path), path.get_file())


## Opens the session on the clipboard (the dashboard's "Copy for replay"), or
## the one in `text`. False, with a word on what to copy, if there is none.
func paste_session(text := "") -> bool:
	if text.is_empty() and DisplayServer.has_feature(DisplayServer.FEATURE_CLIPBOARD):
		text = DisplayServer.clipboard_get()
	return _show(ExportReader.parse_json(text), "From the clipboard")


func _show(result: Dictionary, from: String) -> bool:
	if not result.ok:
		_status.text = result.error
		return false
	sessions = result.sessions
	_session_list.clear()
	for session: Dictionary in sessions:
		_session_list.add_item(ExportReader.label(session))
	_status.text = "%s: %d sessions" % [from, sessions.size()]
	if not sessions.is_empty():
		_session_list.select(0)
		select_session(0)
	return true


func select_session(index: int) -> void:
	if index < 0 or index >= sessions.size():
		return
	timeline = Timeline.new(sessions[index])
	_canvas.timeline = timeline
	_bar.set_ticks(timeline.ticks, timeline.duration)
	_event_list.clear()
	for i in timeline.listed:
		_event_list.add_item(Timeline.describe(timeline.events[i]))
	_copy.disabled = false
	_listed_at = -2
	set_playing(false)
	seek(0.0)


func seek(t: float) -> void:
	time = clampf(t, 0.0, timeline.duration if timeline != null else 0.0)
	_canvas.show_time(time)
	_bar.show_time(time)
	_clock.text = "%s / %s" % [Timeline.clock(time, true), Timeline.clock(timeline.duration if timeline else 0.0)]
	if timeline == null:
		return
	var at := timeline.list_index_at(time)
	if at != _listed_at:
		_listed_at = at
		if at >= 0:
			_event_list.select(at)
			_event_list.ensure_current_is_visible()
		else:
			_event_list.deselect_all()


func set_playing(on: bool) -> void:
	if on and timeline != null and time >= timeline.duration:
		seek(0.0)
	playing = on and timeline != null
	_play.text = "Pause" if playing else "Play"


func set_speed(index: int) -> void:
	speed = SPEEDS[clampi(index, 0, SPEEDS.size() - 1)]
	_speed.select(clampi(index, 0, SPEEDS.size() - 1))


## The summary on the clipboard, and in a box to copy by hand when there is no
## clipboard (or to read first).
func copy_for_claude() -> String:
	if timeline == null:
		return ""
	var text := Summary.build(timeline.session, timeline)
	var copied := DisplayServer.has_feature(DisplayServer.FEATURE_CLIPBOARD)
	if copied:
		DisplayServer.clipboard_set(text)
	_text.text = text
	_text_popup.title = "Copied to the clipboard (%.1f KB)" % (text.to_utf8_buffer().size() / 1024.0) if copied \
			else "No clipboard here: select all and copy this"
	if DisplayServer.get_name() != "headless":
		_text_popup.popup_centered(Vector2i(820, 520))
	return text
#endregion


#region Building
func _build() -> void:
	var back := ColorRect.new()
	back.color = Color("1e2027")
	back.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(back)
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 8)
	add_child(margin)
	var column := VBoxContainer.new()
	margin.add_child(column)

	var top := HBoxContainer.new()
	column.add_child(top)
	_button(top, "Open download…", _choose_file)
	_button(top, "Paste session", paste_session)
	_button(top, "Back", _back)
	_status = Label.new()
	_status.text = "Download your data on fourgames.se/privacy (sign in with Steam, Download), then open the zip here."
	_status.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_status.clip_text = true
	top.add_child(_status)
	_heat = CheckButton.new()
	_heat.text = "Heatmap"
	_heat.toggled.connect(func(on: bool) -> void:
		_canvas.heatmap = on
		_canvas.queue_redraw())
	top.add_child(_heat)
	_copy = _button(top, "Copy for Claude", copy_for_claude)
	_copy.disabled = true

	var middle := HBoxContainer.new()
	middle.size_flags_vertical = Control.SIZE_EXPAND_FILL
	column.add_child(middle)
	_session_list = ItemList.new()
	_session_list.custom_minimum_size = Vector2(250, 0)
	_session_list.add_theme_font_size_override("font_size", 12)
	_session_list.item_selected.connect(select_session)
	middle.add_child(_titled("Sessions", _session_list))

	var centre := VBoxContainer.new()
	centre.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	middle.add_child(centre)
	_canvas = ReplayCanvas.new()
	_canvas.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_canvas.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	centre.add_child(_canvas)
	var controls := HBoxContainer.new()
	centre.add_child(controls)
	_play = _button(controls, "Play", func() -> void: set_playing(not playing))
	_play.custom_minimum_size = Vector2(70, 0)
	_speed = OptionButton.new()
	for s in SPEEDS:
		_speed.add_item("%d×" % int(s))
	_speed.item_selected.connect(set_speed)
	controls.add_child(_speed)
	_clock = Label.new()
	_clock.custom_minimum_size = Vector2(120, 0)
	_clock.text = "0:00.0 / 0:00"
	controls.add_child(_clock)
	_bar = TimelineBar.new()
	_bar.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_bar.scrubbed.connect(seek)
	controls.add_child(_bar)

	_event_list = ItemList.new()
	_event_list.custom_minimum_size = Vector2(290, 0)
	_event_list.add_theme_font_size_override("font_size", 12)
	_event_list.item_clicked.connect(func(index: int, _at: Vector2, _button_index: int) -> void:
		if timeline != null and index < timeline.listed.size():
			seek(float(timeline.events[timeline.listed[index]].t)))
	middle.add_child(_titled("Events", _event_list))

	_dialog = FileDialog.new()
	_dialog.access = FileDialog.ACCESS_FILESYSTEM
	_dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILE
	_dialog.filters = PackedStringArray(["*.zip ; Data download", "*.json ; sessions.json"])
	_dialog.use_native_dialog = true
	_dialog.current_dir = OS.get_system_dir(OS.SYSTEM_DIR_DOWNLOADS)
	_dialog.file_selected.connect(open_file)
	add_child(_dialog)

	_text_popup = AcceptDialog.new()
	_text = TextEdit.new()
	_text.custom_minimum_size = Vector2(780, 440)
	_text.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_text_popup.add_child(_text)
	add_child(_text_popup)


func _titled(text: String, control: Control) -> VBoxContainer:
	var box := VBoxContainer.new()
	var label := Label.new()
	label.text = text
	box.add_child(label)
	control.size_flags_vertical = Control.SIZE_EXPAND_FILL
	box.add_child(control)
	return box


func _button(parent: Control, text: String, pressed: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(pressed)
	parent.add_child(button)
	return button


func _choose_file() -> void:
	_dialog.popup_file_dialog()


func _back() -> void:
	get_tree().change_scene_to_file(TestGame.TITLE_SCENE)
#endregion
