extends RefCounted

## The last `size` events of this run, on disk as they happen, for the crash
## report the next launch sends. A crash takes the process with it, so nothing
## can be written at the end: each event is appended as a line when it happens
## and the file is flushed once a frame (GameData.advance()). Whenever the file
## reaches twice `size` lines it is cut back to the last `size`, so it stays a
## few hundred KB however long the session runs.

var path := ""
var size := 500

## The last `size` lines, in memory, which is what a cut writes back.
var _lines: PackedStringArray = []
var _file: FileAccess = null
var _on_disk := 0
var _dirty := false


func _init(at: String, keep := 500) -> void:
	path = at
	size = keep


## A new ring for this run: the last run's lines are gone.
func open() -> void:
	close()
	_lines.clear()
	_on_disk = 0
	_file = FileAccess.open(path, FileAccess.WRITE)


func add(line: String) -> void:
	_lines.append(line)
	if _lines.size() > size:
		_lines.remove_at(0)
	if _file == null:
		return
	_file.store_line(line)
	_on_disk += 1
	_dirty = true
	if _on_disk >= size * 2:
		_cut()


func flush() -> void:
	if _file != null and _dirty:
		_file.flush()
		_dirty = false


func close() -> void:
	if _file != null:
		_file.close()
		_file = null
	_dirty = false


func remove() -> void:
	close()
	_lines.clear()
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)


func is_open() -> bool:
	return _file != null


func lines() -> PackedStringArray:
	return _lines.duplicate()


## Back to the last `size` lines, through a .tmp so a crash mid-cut costs at most
## the ring, never the game.
func _cut() -> void:
	_file.close()
	_file = null
	var tmp := path + ".tmp"
	var out := FileAccess.open(tmp, FileAccess.WRITE)
	if out != null:
		for line in _lines:
			out.store_line(line)
		out.close()
		DirAccess.remove_absolute(path)
		DirAccess.rename_absolute(tmp, path)
		_on_disk = _lines.size()
	_file = FileAccess.open(path, FileAccess.READ_WRITE)
	if _file != null:
		_file.seek_end()
	_dirty = false


## The last `n` whole events of a ring a run left behind, oldest first, each the
## JSON text it was written as. A line the crash tore, or anything else that is
## not a JSON object, is skipped.
static func read_last(at: String, n: int) -> PackedStringArray:
	var out: PackedStringArray = []
	if not FileAccess.file_exists(at):
		return out
	var json := JSON.new()
	for line in FileAccess.get_file_as_string(at).split("\n", false):
		if json.parse(line) == OK and json.data is Dictionary:
			out.append(line)
	if out.size() > n:
		out = out.slice(out.size() - n)
	return out
