extends CanvasLayer

## The pause menu: Esc, P or a pad's Start in a level. Three settings (volume,
## the FPS counter, window or fullscreen), each change told to GameData through
## TestGame.set_setting(), and the ways out. GameData hears screen("pause") while
## it is up and the level's screen (`back_to`) once play goes on.

signal closed

## The screen play goes back to: the level's, which sets it.
var back_to := ""

var _volume: HSlider = null
var _dragging := false
var _fps: CheckButton = null
var _window: OptionButton = null
var _resume: Button = null


func _ready() -> void:
	layer = 10
	process_mode = Node.PROCESS_MODE_ALWAYS
	visible = false
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.55)
	dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(dim)
	var middle := CenterContainer.new()
	middle.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(middle)
	var panel := PanelContainer.new()
	middle.add_child(panel)
	var margin := MarginContainer.new()
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 20)
	panel.add_child(margin)
	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 10)
	column.custom_minimum_size = Vector2(320, 0)
	margin.add_child(column)

	var title := Label.new()
	title.text = "Paused"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", 28)
	column.add_child(title)

	_volume = HSlider.new()
	_volume.min_value = 0
	_volume.max_value = 100
	_volume.step = 5
	_volume.custom_minimum_size = Vector2(180, 0)
	_volume.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_volume.value_changed.connect(_on_volume)
	_volume.drag_started.connect(func() -> void: _dragging = true)
	_volume.drag_ended.connect(_on_volume_dropped)
	column.add_child(_row("Volume", _volume))

	_fps = CheckButton.new()
	_fps.text = "Show FPS"
	_fps.toggled.connect(func(on: bool) -> void: TestGame.set_setting("show_fps", on))
	column.add_child(_fps)

	_window = OptionButton.new()
	_window.add_item("Windowed")
	_window.add_item("Fullscreen")
	_window.item_selected.connect(func(index: int) -> void:
		TestGame.set_setting("window_mode", TestGame.WINDOW_MODES[index]))
	column.add_child(_row("Window", _window))

	_resume = _button(column, "Resume", close)
	_button(column, "Quit to title", _to_title)
	_button(column, "Quit game", func() -> void: get_tree().quit())


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed(&"pause") or (visible and event.is_action_pressed(&"ui_cancel")):
		if visible:
			close()
		else:
			open()
		get_viewport().set_input_as_handled()


func open() -> void:
	_volume.set_value_no_signal(roundf(float(TestGame.settings.volume) * 100.0))
	_fps.set_pressed_no_signal(bool(TestGame.settings.show_fps))
	_window.select(maxi(TestGame.WINDOW_MODES.find(str(TestGame.settings.window_mode)), 0))
	visible = true
	get_tree().paused = true
	GameData.screen("pause")
	_resume.grab_focus()


func close() -> void:
	if not visible:
		return
	visible = false
	get_tree().paused = false
	GameData.screen(back_to)
	closed.emit()


func set_volume(percent: float) -> void:
	_volume.value = percent


func _on_volume(value: float) -> void:
	if _dragging:
		TestGame.preview_volume(value / 100.0)
	else:
		# Keys or a pad, a step at a time: each step is a change.
		TestGame.set_setting("volume", snappedf(value / 100.0, 0.01))


func _on_volume_dropped(_changed: bool) -> void:
	_dragging = false
	TestGame.set_setting("volume", snappedf(_volume.value / 100.0, 0.01))


func _to_title() -> void:
	visible = false
	get_tree().paused = false
	get_tree().change_scene_to_file(TestGame.TITLE_SCENE)


func _row(text: String, control: Control) -> HBoxContainer:
	var row := HBoxContainer.new()
	var label := Label.new()
	label.text = text
	label.custom_minimum_size = Vector2(90, 0)
	row.add_child(label)
	row.add_child(control)
	return row


func _button(parent: Control, text: String, pressed: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(pressed)
	parent.add_child(button)
	return button
