extends Control

## The test game's title: Play, the replay viewer, Quit. It is the project's
## main scene, so it is also where TestGame brings Steam up and starts the
## session; GameData hears screen("title") and mark_playing() (the boot is over).

const Levels := preload("res://game/levels.gd")

var play_button: Button = null


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var back := ColorRect.new()
	back.color = Levels.FLOOR
	back.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(back)
	var middle := CenterContainer.new()
	middle.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(middle)
	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 12)
	column.custom_minimum_size = Vector2(360, 0)
	middle.add_child(column)

	var title := Label.new()
	title.text = "fourgames_data test game"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", 36)
	column.add_child(title)
	var about := Label.new()
	about.text = "Collect the yellow coins, keep off the red, reach the green.\n" \
			+ "WASD, arrows or a gamepad; Esc pauses; F1 shows the data panel."
	about.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	about.add_theme_font_size_override("font_size", 13)
	column.add_child(about)
	if not TestGame.last_run.is_empty():
		var run := Label.new()
		run.text = "Last run: %d coins, %d deaths" % [TestGame.last_run.coins, TestGame.last_run.deaths]
		run.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		column.add_child(run)

	play_button = _button(column, "Play", play)
	_button(column, "Replay viewer", func() -> void: get_tree().change_scene_to_file(TestGame.VIEWER_SCENE))
	_button(column, "Quit", func() -> void: get_tree().quit())
	play_button.grab_focus()

	GameData.screen("title")
	GameData.mark_playing()


func play() -> void:
	TestGame.new_run()
	get_tree().change_scene_to_file(Levels.scene_of(Levels.ORDER[0]))


func _button(parent: Control, text: String, pressed: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(pressed)
	parent.add_child(button)
	return button
