extends "res://tests/tools/suite.gd"

## The test game's levels can be played: from the start, every coin and the goal
## can be reached without touching a wall or a spike, nothing sits inside a wall,
## and each level's scene says which level it is.

const Levels := preload("res://game/levels.gd")


func test_every_coin_and_the_goal_can_be_reached() -> void:
	for level_id in Levels.ORDER:
		var data := Levels.level(level_id)
		var open := _open_tiles(level_id)
		var reached := _reach(open, data.start)
		for i in data.coins.size():
			assert_true(reached.has(data.coins[i]), "%s coin %d at %s" % [level_id, i, data.coins[i]])
		var goal_reached := false
		for x in range(data.goal.position.x, data.goal.end.x):
			for y in range(data.goal.position.y, data.goal.end.y):
				goal_reached = goal_reached or reached.has(Vector2i(x, y))
		assert_true(goal_reached, "%s's goal" % level_id)


func test_nothing_sits_in_a_wall() -> void:
	for level_id in Levels.ORDER:
		var data := Levels.level(level_id)
		var open := _open_tiles(level_id)
		assert_true(open.has(data.start), "%s's start" % level_id)
		for coin: Vector2i in data.coins:
			assert_true(open.has(coin), "%s coin at %s" % [level_id, coin])
		for saw: Array in data.saws:
			for end: Vector2i in [saw[0], saw[1]]:
				assert_false(_in_wall(level_id, Levels.center(end)), "%s saw end %s" % [level_id, end])


func test_the_scenes_name_their_levels() -> void:
	for level_id in Levels.ORDER:
		var scene := Levels.scene_of(level_id)
		assert_eq(Levels.for_scene(scene), level_id)
		var packed := load(scene) as PackedScene
		assert_true(packed != null, scene)
		var node := packed.instantiate()
		assert_eq(str(node.get("level_id")), level_id)
		node.free()
	assert_eq(Levels.next("level_1"), "level_2")
	assert_eq(Levels.next("level_2"), "")
	assert_eq(Levels.for_scene("res://somewhere/else.tscn"), "")


func test_a_saw_goes_back_and_forth() -> void:
	var saw := [Vector2i(1, 1), Vector2i(5, 1), 2.0]
	assert_eq(Levels.saw_at(saw, 0.0), Levels.center(Vector2i(1, 1)))
	assert_eq(Levels.saw_at(saw, 2.0), Levels.center(Vector2i(5, 1)))
	assert_eq(Levels.saw_at(saw, 1.0), Levels.center(Vector2i(3, 1)))
	assert_eq(Levels.saw_at(saw, 4.0), Levels.center(Vector2i(1, 1)))


## Tiles neither wall nor spike.
func _open_tiles(level_id: String) -> Dictionary:
	var blocked: Array[Rect2] = Levels.solid(level_id)
	for spike: Rect2i in Levels.level(level_id).spikes:
		blocked.append(Levels.rect(spike))
	var open := {}
	for x in Levels.COLS:
		for y in Levels.ROWS:
			var tile := Rect2(Vector2(x, y) * Levels.TILE, Vector2.ONE * Levels.TILE)
			var free := true
			for box in blocked:
				if box.intersects(tile):
					free = false
					break
			if free:
				open[Vector2i(x, y)] = true
	return open


func _reach(open: Dictionary, from: Vector2i) -> Dictionary:
	var seen := {from: true}
	var todo: Array[Vector2i] = [from]
	while not todo.is_empty():
		var at: Vector2i = todo.pop_back()
		for step: Vector2i in [Vector2i.LEFT, Vector2i.RIGHT, Vector2i.UP, Vector2i.DOWN]:
			var next := at + step
			if open.has(next) and not seen.has(next):
				seen[next] = true
				todo.append(next)
	return seen


func _in_wall(level_id: String, point: Vector2) -> bool:
	for wall in Levels.solid(level_id):
		if wall.has_point(point):
			return true
	return false
