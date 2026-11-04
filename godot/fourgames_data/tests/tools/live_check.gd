extends Node

## The plugin over a real network: the threaded HTTPRequest while the game runs
## and the blocking HTTPClient as it quits, against tests/tools/fake_server.py
## (live_check.sh starts it and reads back what it got). Steam is a stand-in that
## answers its ticket a frame later. Two ways to run it, after "--":
##
##   ok         a session, two batches, then a real quit -- the session's end goes
##              out from _exit_tree, as it would in a game
##   blackhole  live, then the server moved to an address that never answers:
##              the quit must still be over within its budget
##
## Prints "LIVE: ..." lines and exits 1 when something it can see went wrong.

const GameDataScript := preload("res://addons/fourgames_data/game_data.gd")
const FakeSteam := preload("res://tests/tools/fake_steam.gd")

## Nothing listens here, and nothing answers: connects just hang.
const BLACKHOLE := "http://10.255.255.1:9/v1"
const SLACK_MS := 400

var _gd: Node = null


func _ready() -> void:
	await get_tree().process_frame
	var args := OS.get_cmdline_user_args()
	var mode := args[0] if args.size() > 0 else "ok"
	_gd = GameDataScript.new()
	_gd.root_dir = "user://_live_check_%d" % OS.get_process_id()
	_gd.force_enabled = true
	var steam := FakeSteam.new()
	steam.auto_answer = true
	_gd.steam = steam
	add_child(_gd)
	_gd.start(5207970, {"volume": 0.5, "mode": mode})
	for i in 50:
		_gd.action("live", {"i": i, "at": Vector2i(i, -i)})
	if not await _until(func() -> bool: return _gd.status() == "live", 10.0):
		return _fail("never went live (%s)" % _gd.status())
	_gd._cut_batch()
	if not await _until(func() -> bool: return _gd._queue.items().is_empty(), 10.0):
		return _fail("the first batch never went")
	for i in 5:
		_gd.action("last", {"i": i})
	_gd._cut_batch()
	_gd.action("final", {})
	print("LIVE: live, first batch sent, mode ", mode)
	if mode == "blackhole":
		# The server is gone the moment the game quits; the quit may not wait on it.
		await _until(func() -> bool: return _gd._queue.items().is_empty(), 5.0)
		_gd.action("unsent", {})
		_gd.base_url = BLACKHOLE
		var began := Time.get_ticks_msec()
		_gd.shutdown()
		var took := Time.get_ticks_msec() - began
		print("LIVE: quit with no server took %d ms" % took)
		if took > GameDataScript.QUIT_BUDGET_MS + SLACK_MS:
			return _fail("the quit waited %d ms" % took)
		if _gd._queue.items().is_empty():
			return _fail("what could not go was not kept for the next launch")
	_wipe_later()
	get_tree().quit(0)


func _until(done: Callable, seconds: float) -> bool:
	var until := Time.get_ticks_msec() + int(seconds * 1000.0)
	while not done.call():
		if Time.get_ticks_msec() > until:
			return false
		await get_tree().process_frame
	return true


func _fail(why: String) -> void:
	print("LIVE: FAIL ", why)
	get_tree().quit(1)


## The scratch folder goes once the plugin has written its last file: children
## leave the tree before their parent, so GameData's quit is over by then.
func _wipe_later() -> void:
	tree_exiting.connect(_wipe)


func _wipe() -> void:
	var root: String = _gd.root_dir
	for folder in ["queue", ""]:
		var at := root.path_join(folder)
		for file in DirAccess.get_files_at(at):
			DirAccess.remove_absolute(at.path_join(file))
		DirAccess.remove_absolute(at)
