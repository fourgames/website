extends Node2D

## One level of the test game (level_1.tscn and level_2.tscn set `level_id`):
## built from levels.gd, played top-down, and told to GameData the way a real
## game would:
##
##   progress({level, coins, deaths})  as the level starts and when it is done
##   track_player(player)              at the start and after every respawn
##   action("coin", ...)               a coin picked up
##   death(cause, ...)                 a spike or a saw (GameData adds where)
##   action("respawn", ...)            back at the start
##   action("level_complete", ...)     the goal reached
##   snapshot({...})                   at the start and every SNAPSHOT_S of play
##   screen(level_id)                  the level is up, nothing over it
##                                     ("level_1"; the pause menu goes back to it)
##
## Movement is the level's own: a square against the walls' rectangles, one axis
## at a time, so it plays the same headless as on screen.

const Levels := preload("res://game/levels.gd")
const PauseMenu := preload("res://game/pause_menu.gd")

const SPEED := 230.0
## Half the player's square.
const HALF := 10.0
const COIN_REACH := 15.0
const SNAPSHOT_S := 30.0
const RESPAWN_S := 0.7
const NEXT_AFTER_S := 1.5

@export var level_id := "level_1"

var player: Node2D = null
## Coin index -> true, for the coins taken on this level.
var collected := {}
## Seconds of play on this level (the saws run on it).
var time := 0.0
var deaths_here := 0
var done := false

var _data := {}
var _solid: Array[Rect2] = []
var _since_snapshot := 0.0
var _dead_for := -1.0
var _hud: Label = null
var _banner: Label = null


class Player extends Node2D:
	var dead := false

	func _draw() -> void:
		var colour := Color("4aa3ff") if not dead else Color(0.6, 0.7, 0.8, 0.35)
		draw_rect(Rect2(-Vector2.ONE * HALF, Vector2.ONE * HALF * 2.0), colour)
		draw_rect(Rect2(-Vector2.ONE * HALF, Vector2.ONE * HALF * 2.0), colour.lightened(0.4), false, 2.0)


func _ready() -> void:
	_data = Levels.level(level_id)
	_solid = Levels.solid(level_id)
	player = Player.new()
	player.name = "Player"
	player.position = Levels.center(_data.start)
	add_child(player)
	_make_hud()
	var pause := PauseMenu.new()
	pause.back_to = level_id
	add_child(pause)
	# TestGame starts the session a frame after boot when this is the first
	# scene; what is said before that would be lost.
	await get_tree().process_frame
	await get_tree().process_frame
	GameData.screen(level_id)
	GameData.progress({"level": level_id, "coins": TestGame.total_coins, "deaths": TestGame.deaths})
	GameData.track_player(player)
	_snapshot()


func _physics_process(delta: float) -> void:
	if done:
		return
	time += delta
	_since_snapshot += delta
	if _since_snapshot >= SNAPSHOT_S:
		_snapshot()
	if _dead_for >= 0.0:
		_dead_for += delta
		if _dead_for >= RESPAWN_S:
			_respawn()
	else:
		move(Input.get_vector(&"move_left", &"move_right", &"move_up", &"move_down") * SPEED * delta)
		_touch()
	_update_hud()
	queue_redraw()


func _draw() -> void:
	Levels.draw(self, level_id, time, collected)


#region Play
## Moves the player by `motion`, stopped by the walls: across, then down.
func move(motion: Vector2) -> void:
	var at := player.position
	at.x += motion.x
	at = _out_of_walls(at, motion.x, true)
	at.y += motion.y
	at = _out_of_walls(at, motion.y, false)
	player.position = at


func _out_of_walls(at: Vector2, moved: float, across: bool) -> Vector2:
	if moved == 0.0:
		return at
	for wall in _solid:
		if not _box(at).intersects(wall):
			continue
		if across:
			at.x = wall.position.x - HALF if moved > 0.0 else wall.end.x + HALF
		else:
			at.y = wall.position.y - HALF if moved > 0.0 else wall.end.y + HALF
	return at


func _box(at: Vector2) -> Rect2:
	return Rect2(at - Vector2.ONE * HALF, Vector2.ONE * HALF * 2.0)


## Coins, spikes, saws and the goal under the player now.
func _touch() -> void:
	var box := _box(player.position)
	for i in _data.coins.size():
		if not collected.has(i) and player.position.distance_to(Levels.center(_data.coins[i])) < COIN_REACH:
			_collect(i)
	for spike: Rect2i in _data.spikes:
		if box.intersects(Levels.rect(spike).grow(-4.0)):
			_die("spikes")
			return
	for saw: Array in _data.saws:
		if player.position.distance_to(Levels.saw_at(saw, time)) < Levels.SAW_RADIUS + HALF - 3.0:
			_die("saw")
			return
	if box.intersects(Levels.rect(_data.goal)):
		_complete()


func _collect(index: int) -> void:
	collected[index] = true
	TestGame.total_coins += 1
	var at := Levels.center(_data.coins[index])
	GameData.action("coin", {"level": level_id, "coin": index, "x": at.x, "y": at.y,
			"level_coins": collected.size(), "coins": TestGame.total_coins})


func _die(cause: String) -> void:
	_dead_for = 0.0
	deaths_here += 1
	TestGame.deaths += 1
	player.dead = true
	player.queue_redraw()
	GameData.death(cause, {"level": level_id, "coins": TestGame.total_coins, "level_deaths": deaths_here})


func _respawn() -> void:
	_dead_for = -1.0
	player.dead = false
	player.position = Levels.center(_data.start)
	player.queue_redraw()
	GameData.action("respawn", {"level": level_id, "level_deaths": deaths_here})
	GameData.track_player(player)


func _complete() -> void:
	done = true
	var next := Levels.next(level_id)
	GameData.action("level_complete", {"level": level_id, "time_s": snappedf(time, 0.1),
			"coins": collected.size(), "coins_max": _data.coins.size(), "deaths": deaths_here})
	GameData.progress({"level": next if not next.is_empty() else "finished", "coins": TestGame.total_coins,
			"deaths": TestGame.deaths})
	_banner.text = "Level complete!" if not next.is_empty() else "All done! %d coins, %d deaths" % [
			TestGame.total_coins, TestGame.deaths]
	_banner.visible = true
	await get_tree().create_timer(NEXT_AFTER_S if not next.is_empty() else NEXT_AFTER_S * 2.0, false).timeout
	if not is_inside_tree():
		return
	if next.is_empty():
		TestGame.finish_run()
		get_tree().change_scene_to_file(TestGame.TITLE_SCENE)
	else:
		get_tree().change_scene_to_file(Levels.scene_of(next))


## The state, small: enough to put a replay where the player was.
func _snapshot() -> void:
	_since_snapshot = 0.0
	var taken: Array = collected.keys()
	taken.sort()
	GameData.snapshot({"level": level_id, "x": snappedf(player.position.x, 0.1), "y": snappedf(player.position.y, 0.1),
			"coins": TestGame.total_coins, "level_coins": collected.size(), "collected": taken,
			"deaths": TestGame.deaths, "level_deaths": deaths_here, "level_time_s": snappedf(time, 0.1),
			"dead": _dead_for >= 0.0})
#endregion


#region HUD
func _make_hud() -> void:
	var layer := CanvasLayer.new()
	add_child(layer)
	_hud = Label.new()
	_hud.position = Vector2(12, 4)
	layer.add_child(_hud)
	_banner = Label.new()
	_banner.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	_banner.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_banner.grow_vertical = Control.GROW_DIRECTION_BOTH
	_banner.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_banner.add_theme_font_size_override("font_size", 40)
	_banner.add_theme_color_override("font_outline_color", Color.BLACK)
	_banner.add_theme_constant_override("outline_size", 8)
	_banner.visible = false
	layer.add_child(_banner)
	_update_hud()


func _update_hud() -> void:
	_hud.text = "%s   coins %d/%d   deaths %d   %d:%02d   Esc pauses, F1 data panel" % [
			_data.get("name", level_id), collected.size(), _data.coins.size(), deaths_here,
			floori(time / 60.0), int(time) % 60]
#endregion
