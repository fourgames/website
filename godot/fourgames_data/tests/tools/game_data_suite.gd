extends "res://tests/tools/suite.gd"

## What the GameData suites share: a GameData as a launch makes it, on the test's
## scratch folder, with a fake transport answering as the server in SPEC.md
## would and a fake Steam handing out tickets, and the helpers that drive it.

const GameDataScript := preload("res://addons/fourgames_data/game_data.gd")
const Hardware := preload("res://addons/fourgames_data/hardware.gd")
const Queue := preload("res://addons/fourgames_data/queue.gd")
const FakeSteam := preload("res://tests/tools/fake_steam.gd")
const FakeTransport := preload("res://tests/tools/fake_transport.gd")

const APP_ID := 5207970

## The wall clock every instance in a test reads; a test moves it to play a later launch.
var now := 0.0
var _made: Array[Node] = []
var _staged: Array[Node] = []


func setup() -> void:
	now = Time.get_unix_time_from_system()
	FakeTransport.reset()


func teardown() -> void:
	for node in _made:
		node._release_catcher()
		node.free()
	_made.clear()
	for node in _staged:
		if is_instance_valid(node):
			node.free()
	_staged.clear()


## `node` in the running tree, as a game's player would be; freed after the test.
func _stage(node: Node) -> Node:
	(Engine.get_main_loop() as SceneTree).root.add_child(node)
	_staged.append(node)
	return node


#region Helpers
## A GameData as a launch makes it, on this test's scratch folder, its fakes
## fresh. Call it again on the same folder to play the next launch.
func _launch(share := true) -> Node:
	var gd: Node = GameDataScript.new()
	gd.root_dir = scratch.path_join("fourgames_data")
	gd.force_enabled = true
	gd.catch_errors = false
	gd.share_hardware = share
	gd.base_url = "https://test.invalid/v1"
	gd.log_path = scratch.path_join("logs/godot.log")
	gd.steam = FakeSteam.new()
	gd.transport = FakeTransport.new()
	gd.unix_now = func() -> float: return now
	gd.ticks_msec = func() -> int: return gd.transport.ticks
	_made.append(gd)
	return gd


## Started, its ticket answered, and live on the server.
func _live(gd: Node, settings := {"volume": 0.5}) -> Node:
	gd.start(APP_ID, settings)
	gd.advance(0.0)
	gd.steam.answer()
	return gd


## Enough frames for every queued item to go, one request each.
func _drain(gd: Node, frames := 12) -> void:
	for i in frames:
		gd.advance(0.0)


func _events_sent(gd: Node) -> Array:
	var out := []
	for request in gd.transport.to("/events"):
		out.append_array(request.json.events)
	return out


## The events of one type sent so far, in order.
func _sent_of(gd: Node, type: String) -> Array:
	return _events_sent(gd).filter(func(event: Dictionary) -> bool: return event.type == type)


func _file(name: String) -> String:
	return scratch.path_join("fourgames_data").path_join(name)


func _queue_files() -> PackedStringArray:
	return DirAccess.get_files_at(_file("queue"))
#endregion
