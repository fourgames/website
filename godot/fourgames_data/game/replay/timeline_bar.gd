extends Control

## The replay's timeline: the session's length, a tick per event worth seeing
## (coins, deaths, level completes, respawns, setting changes, errors, other
## actions), the part played so far, and the playhead. Click or drag to scrub.

signal scrubbed(t: float)

const COLOURS := {
	"coin": Color("f2c94c"), "death": Color("ff5a5a"), "level_complete": Color("3fbf6f"),
	"respawn": Color(1, 1, 1, 0.35), "setting_changed": Color("b98cff"), "error": Color("ff3df2"),
	"action": Color(1, 1, 1, 0.2),
}
## Taller ticks for the ones that matter most.
const TALL := ["death", "level_complete", "setting_changed", "error"]

var duration := 1.0
var time := 0.0
var ticks: Array = []


func _ready() -> void:
	custom_minimum_size = Vector2(200, 34)
	mouse_filter = Control.MOUSE_FILTER_STOP


func set_ticks(new_ticks: Array, length: float) -> void:
	ticks = new_ticks
	duration = maxf(length, 0.001)
	queue_redraw()


func show_time(t: float) -> void:
	time = t
	queue_redraw()


func _draw() -> void:
	var bar := Rect2(0, 8, size.x, size.y - 16)
	draw_rect(bar, Color(1, 1, 1, 0.07))
	draw_rect(Rect2(bar.position, Vector2(bar.size.x * clampf(time / duration, 0.0, 1.0), bar.size.y)),
			Color(0.55, 0.78, 1.0, 0.18))
	for tick: Dictionary in ticks:
		var x := size.x * float(tick.t) / duration
		var tall: bool = tick.kind in TALL
		var top := 2.0 if tall else bar.position.y + 4.0
		var bottom := size.y - 2.0 if tall else bar.end.y - 4.0
		draw_line(Vector2(x, top), Vector2(x, bottom), COLOURS.get(tick.kind, Color.WHITE), 2.0 if tall else 1.0)
	var head := size.x * clampf(time / duration, 0.0, 1.0)
	draw_line(Vector2(head, 0), Vector2(head, size.y), Color.WHITE, 2.0)


func _gui_input(event: InputEvent) -> void:
	var press := event is InputEventMouseButton and (event as InputEventMouseButton).pressed \
			and (event as InputEventMouseButton).button_index == MOUSE_BUTTON_LEFT
	var drag := event is InputEventMouseMotion and ((event as InputEventMouseMotion).button_mask & MOUSE_BUTTON_MASK_LEFT) != 0
	if press or drag:
		var x: float = (event as InputEventMouse).position.x
		scrubbed.emit(clampf(x / maxf(size.x, 1.0), 0.0, 1.0) * duration)
		accept_event()
