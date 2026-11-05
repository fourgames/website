extends Control

## The replay's map: the scene up at `time` -- the test game's level when it is
## one of them, else a plain grid sized to where the player went -- with the
## player's whole path in it (faint), the part walked so far (bright), deaths as
## crosses, the player as a dot, and with `heatmap` on, where they spent time.

const Levels := preload("res://game/levels.gd")

const PATH := Color(0.55, 0.78, 1.0, 0.25)
const WALKED := Color(0.55, 0.78, 1.0, 0.9)
const MARKER := Color("4aa3ff")
const DEATH := Color("ff5a5a")
const HEAT := Color(1.0, 0.45, 0.1)
const BACK := Color("181a20")
const GRID_LINE := Color(1, 1, 1, 0.08)

var timeline: RefCounted = null
var time := 0.0
var heatmap := false


func show_time(t: float) -> void:
	time = t
	queue_redraw()


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), BACK)
	if timeline == null:
		_say("Open a download (the .zip from fourgames.se/privacy), then pick a session.")
		return
	var scene: String = timeline.scene_at(time)
	var level := Levels.for_scene(scene)
	var world := Rect2(Vector2.ZERO, Levels.SIZE) if not level.is_empty() else _padded(timeline.bounds(scene))
	var scale := minf((size.x - 16.0) / world.size.x, (size.y - 32.0) / world.size.y)
	var offset := Vector2(8, 24) + ((size - Vector2(16, 32)) - world.size * scale) * 0.5 - world.position * scale
	draw_set_transform(offset, 0.0, Vector2.ONE * scale)
	var px := 1.0 / scale
	if not level.is_empty():
		Levels.draw(self, level, -1.0, timeline.coins_taken(scene, time))
	else:
		_grid(world, px)
	var cell := float(Levels.TILE) if not level.is_empty() else _nice(world.size.length() / 40.0)
	if heatmap:
		_heat(scene, cell)
	for line: PackedVector2Array in timeline.paths(scene):
		if line.size() > 1:
			draw_polyline(line, PATH, 2.0 * px)
	for line: PackedVector2Array in timeline.paths(scene, time):
		if line.size() > 1:
			draw_polyline(line, WALKED, 3.0 * px)
	for death: Dictionary in timeline.deaths_in(scene):
		var faded := 1.0 if float(death.t) <= time else 0.35
		var p: Vector2 = death.p
		var arm := 7.0 * px
		draw_line(p - Vector2(arm, arm), p + Vector2(arm, arm), Color(DEATH, faded), 3.0 * px)
		draw_line(p - Vector2(arm, -arm), p + Vector2(arm, -arm), Color(DEATH, faded), 3.0 * px)
	var now: Dictionary = timeline.position_at(time)
	if now.ok:
		draw_circle(now.p, 9.0 * px, Color.WHITE)
		draw_circle(now.p, 6.5 * px, MARKER)
	draw_set_transform(Vector2.ZERO)
	var name := scene if not scene.is_empty() else "(no scene)"
	if not level.is_empty():
		name = "%s \"%s\"" % [level, Levels.level(level).name]
	_say(name)


func _say(text: String) -> void:
	draw_string(get_theme_default_font(), Vector2(10, 17), text, HORIZONTAL_ALIGNMENT_LEFT, size.x - 20.0, 14,
			Color(1, 1, 1, 0.8))


func _padded(box: Rect2) -> Rect2:
	var grow := maxf(box.size.length() * 0.08, 40.0)
	return box.grow(grow)


## A grid of round-numbered lines for a scene the viewer has no map of.
func _grid(world: Rect2, px: float) -> void:
	var step := _nice(maxf(world.size.x, world.size.y) / 12.0)
	var x := floorf(world.position.x / step) * step
	while x <= world.end.x:
		draw_line(Vector2(x, world.position.y), Vector2(x, world.end.y), GRID_LINE, px)
		x += step
	var y := floorf(world.position.y / step) * step
	while y <= world.end.y:
		draw_line(Vector2(world.position.x, y), Vector2(world.end.x, y), GRID_LINE, px)
		y += step


func _heat(scene: String, cell: float) -> void:
	var counts: Dictionary = timeline.heat(scene, cell)
	var most := 1
	for at: Vector2i in counts:
		most = maxi(most, counts[at])
	for at: Vector2i in counts:
		var k := sqrt(float(counts[at]) / most)
		draw_rect(Rect2(Vector2(at) * cell, Vector2.ONE * cell), Color(HEAT, 0.15 + 0.6 * k))


## 1, 2 or 5 times a power of ten, at or above `value`.
static func _nice(value: float) -> float:
	var power := pow(10.0, floorf(log(maxf(value, 0.001)) / log(10.0)))
	for k in [1.0, 2.0, 5.0, 10.0]:
		if power * k >= value:
			return power * k
	return power * 10.0
