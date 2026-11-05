extends RefCounted

## The test game's two levels, as data: the game builds them from it, and the
## replay viewer draws a session's path on them. Everything is in tiles of TILE
## pixels on a COLS x ROWS board, so a level is a few short lists:
##
##   walls    Rect2i, solid
##   coins    Vector2i, the tile a coin sits in the middle of
##   spikes   Rect2i, kill on touch
##   saws     [from, to, seconds for one way], a saw going back and forth
##   start    Vector2i, where the player starts and respawns
##   goal     Rect2i, ends the level

const TILE := 32
const COLS := 36
const ROWS := 20
const SIZE := Vector2(COLS * TILE, ROWS * TILE)
const SAW_RADIUS := 12.0

const ORDER: Array[String] = ["level_1", "level_2"]

## Scene path -> level id: how the viewer knows which level a position is in.
const SCENES := {
	"res://game/level_1.tscn": "level_1",
	"res://game/level_2.tscn": "level_2",
}

const LEVELS := {
	"level_1": {
		"name": "First steps",
		"start": Vector2i(2, 10),
		"goal": Rect2i(33, 9, 2, 3),
		"walls": [
			Rect2i(10, 1, 1, 7), Rect2i(10, 12, 1, 7),
			Rect2i(18, 5, 1, 10),
			Rect2i(26, 1, 1, 6), Rect2i(26, 10, 1, 9),
			Rect2i(14, 9, 2, 2), Rect2i(22, 3, 2, 1), Rect2i(22, 16, 2, 1),
		],
		"coins": [
			Vector2i(6, 4), Vector2i(6, 15), Vector2i(14, 3), Vector2i(14, 16),
			Vector2i(22, 10), Vector2i(30, 3), Vector2i(30, 16), Vector2i(23, 7),
		],
		"spikes": [
			Rect2i(12, 6, 2, 1), Rect2i(12, 13, 2, 1), Rect2i(20, 9, 1, 2),
			Rect2i(28, 8, 1, 4),
		],
		"saws": [],
	},
	"level_2": {
		"name": "Saw mill",
		"start": Vector2i(2, 17),
		"goal": Rect2i(32, 1, 3, 2),
		"walls": [
			Rect2i(1, 14, 12, 1), Rect2i(16, 14, 19, 1),
			Rect2i(6, 8, 1, 6), Rect2i(1, 8, 2, 1), Rect2i(10, 8, 18, 1),
			Rect2i(31, 4, 1, 10), Rect2i(6, 4, 22, 1), Rect2i(6, 1, 1, 3),
			Rect2i(20, 15, 1, 2),
		],
		"coins": [
			Vector2i(9, 17), Vector2i(17, 17), Vector2i(26, 18), Vector2i(33, 11),
			Vector2i(24, 11), Vector2i(12, 11), Vector2i(3, 11), Vector2i(3, 2),
			Vector2i(17, 2), Vector2i(29, 6),
		],
		"spikes": [
			Rect2i(13, 16, 1, 3), Rect2i(27, 15, 1, 2), Rect2i(18, 9, 1, 3),
			Rect2i(8, 5, 1, 3), Rect2i(24, 1, 1, 2),
		],
		"saws": [
			[Vector2i(23, 15), Vector2i(23, 18), 1.2],
			[Vector2i(8, 9), Vector2i(29, 9), 3.0],
			[Vector2i(28, 13), Vector2i(28, 9), 1.0],
			[Vector2i(10, 2), Vector2i(28, 2), 2.6],
		],
	},
}


static func has(level_id: String) -> bool:
	return LEVELS.has(level_id)


static func level(level_id: String) -> Dictionary:
	return LEVELS.get(level_id, {})


## The level a scene path is, "" for a scene that is none of them.
static func for_scene(scene: String) -> String:
	return SCENES.get(scene, "")


static func scene_of(level_id: String) -> String:
	for scene: String in SCENES:
		if SCENES[scene] == level_id:
			return scene
	return ""


static func next(level_id: String) -> String:
	var at := ORDER.find(level_id)
	return ORDER[at + 1] if at >= 0 and at + 1 < ORDER.size() else ""


## A tile rect in pixels.
static func rect(r: Rect2i) -> Rect2:
	return Rect2(r.position * TILE, r.size * TILE)


## The middle of a tile, in pixels.
static func center(tile: Vector2i) -> Vector2:
	return Vector2(tile) * TILE + Vector2.ONE * (TILE * 0.5)


## Where a saw is at `t` seconds: back and forth between its two tiles.
static func saw_at(saw: Array, t: float) -> Vector2:
	var from := center(saw[0])
	var to := center(saw[1])
	var leg := maxf(float(saw[2]), 0.01)
	var phase := fmod(t, leg * 2.0) / leg
	var k := phase if phase <= 1.0 else 2.0 - phase
	return from.lerp(to, k)


## The board's outer walls, then the level's own.
static func solid(level_id: String) -> Array[Rect2]:
	var out: Array[Rect2] = [
		Rect2(0, 0, SIZE.x, TILE), Rect2(0, SIZE.y - TILE, SIZE.x, TILE),
		Rect2(0, 0, TILE, SIZE.y), Rect2(SIZE.x - TILE, 0, TILE, SIZE.y),
	]
	for wall: Rect2i in level(level_id).get("walls", []):
		out.append(rect(wall))
	return out


#region Drawing
const FLOOR := Color("23262e")
const GRID := Color(1, 1, 1, 0.04)
const WALL := Color("5b6170")
const SPIKE := Color("d64545")
const SAW := Color("f08a24")
const COIN := Color("f2c94c")
const GOAL := Color("3fbf6f")


## The level on `canvas`, in level pixels (a caller that scales sets the
## canvas's transform first): floor, walls, goal, spikes, the coins not in
## `collected` (coin index -> true), and the saws where they are at `saw_t`
## seconds -- or, with saw_t < 0, the tracks they run on, as the replay viewer
## has no saw clock.
static func draw(canvas: CanvasItem, level_id: String, saw_t: float, collected := {}) -> void:
	var data := level(level_id)
	canvas.draw_rect(Rect2(Vector2.ZERO, SIZE), FLOOR)
	for x in range(1, COLS):
		canvas.draw_line(Vector2(x * TILE, 0), Vector2(x * TILE, SIZE.y), GRID)
	for y in range(1, ROWS):
		canvas.draw_line(Vector2(0, y * TILE), Vector2(SIZE.x, y * TILE), GRID)
	for wall in solid(level_id):
		canvas.draw_rect(wall, WALL)
	if data.is_empty():
		return
	canvas.draw_rect(rect(data.goal), GOAL)
	for spike: Rect2i in data.spikes:
		var r := rect(spike)
		canvas.draw_rect(r, SPIKE.darkened(0.35))
		canvas.draw_rect(r.grow(-5), SPIKE)
	for i in data.coins.size():
		if not collected.has(i):
			canvas.draw_circle(center(data.coins[i]), 7.0, COIN)
	for saw: Array in data.saws:
		if saw_t < 0.0:
			canvas.draw_line(center(saw[0]), center(saw[1]), Color(SAW, 0.35), 4.0)
			canvas.draw_circle(center(saw[0]), SAW_RADIUS * 0.6, Color(SAW, 0.6))
		else:
			canvas.draw_circle(saw_at(saw, saw_t), SAW_RADIUS, SAW)
			canvas.draw_circle(saw_at(saw, saw_t), SAW_RADIUS * 0.4, SAW.darkened(0.4))
#endregion
