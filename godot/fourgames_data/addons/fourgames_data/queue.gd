extends RefCounted

## The plugin's disk: the requests still to send and the sessions they belong
## to, under user://fourgames_data/. A game played offline keeps its batches here
## and sends them once the server answers again, and the whole queue is never
## more than `cap_bytes`: past that the oldest item goes first.
##
## Each item is one request body, gzipped, named so a plain sort is oldest first
## and the name alone says what it is:
##
##   <stamp>_<local session id>_<kind>_<seq>.gz      kind: events, end or crash
##
## A body is the JSON object's members without its braces and without the
## session id, which the server only hands out once the session has started, so
## a batch cut before that -- or offline -- is spliced when it goes rather than
## rewritten. Spliced as text, never parsed and written again: Godot's JSON reads
## every number back as a float, and a 12 would go out as 12.0.
##
## The sessions are one small JSON file, local id -> record: "start" (the
## session/start members, as text for the same reason), "sid" and "token" once
## the server has started it, "token_at" (unix seconds), "seq" (the next batch
## number) and "created" (unix seconds).

const ITEMS := "queue"
const SESSIONS := "sessions.json"
const EXT := ".gz"
const KINDS: Array[String] = ["events", "end", "crash"]

var root := ""
var cap_bytes := 20 * 1024 * 1024
## While true the session records stay in memory: a launch after the player
## opted out keeps nothing on disk until the server says they are in again.
var hold_writes := false

## Every item's name, oldest first; the folder is only listed once, at _init.
var _names: PackedStringArray = []
var _sizes := {}
var _bytes := 0
var _last_stamp := 0
var _sessions := {}


func _init(root_dir: String, cap := 20 * 1024 * 1024) -> void:
	root = root_dir
	cap_bytes = cap
	DirAccess.make_dir_recursive_absolute(_items_dir())
	_index()
	_sessions = _read_sessions()


#region Items
## Writes one body, already gzipped. The item's name, or "" when the disk said no.
func add(kind: String, local: String, seq: int, gz: PackedByteArray) -> String:
	_last_stamp = maxi(_last_stamp + 1, int(Time.get_unix_time_from_system() * 1000.0))
	var item := "%016d_%s_%s_%06d%s" % [_last_stamp, local, kind, seq, EXT]
	var file := FileAccess.open(_path(item), FileAccess.WRITE)
	if file == null:
		return ""
	file.store_buffer(gz)
	file.close()
	_names.append(item)
	_sizes[item] = gz.size()
	_bytes += gz.size()
	_trim()
	return item if _sizes.has(item) else ""


## Every item, oldest first.
func items() -> PackedStringArray:
	return _names.duplicate()


## What a name says: {kind, local, seq}, or {} for a name that is not an item.
static func parse(item: String) -> Dictionary:
	if not item.ends_with(EXT):
		return {}
	var parts := item.trim_suffix(EXT).split("_")
	if parts.size() != 4 or not parts[0].is_valid_int() or not parts[3].is_valid_int() or not parts[2] in KINDS:
		return {}
	return {"kind": parts[2], "local": parts[1], "seq": int(parts[3])}


## The body as it was added, unzipped; "" when it is gone or damaged.
func read(item: String) -> String:
	var gz := FileAccess.get_file_as_bytes(_path(item))
	if gz.is_empty():
		return ""
	return gz.decompress_dynamic(-1, FileAccess.COMPRESSION_GZIP).get_string_from_utf8()


func remove(item: String) -> void:
	var at := _names.find(item)
	if at < 0:
		return
	_names.remove_at(at)
	_bytes -= int(_sizes.get(item, 0))
	_sizes.erase(item)
	DirAccess.remove_absolute(_path(item))


func bytes() -> int:
	return _bytes


func count_for(local: String) -> int:
	var n := 0
	for item in _names:
		if parse(item).get("local", "") == local:
			n += 1
	return n


## Everything on disk gone: every item and every session.
func clear() -> void:
	for item in _names.duplicate():
		remove(item)
	_sessions = {}
	if FileAccess.file_exists(_sessions_path()):
		DirAccess.remove_absolute(_sessions_path())


## Oldest first until the queue fits its cap again.
func _trim() -> void:
	while _bytes > cap_bytes and not _names.is_empty():
		remove(_names[0])


func _index() -> void:
	_names.clear()
	_sizes.clear()
	_bytes = 0
	var found := Array(DirAccess.get_files_at(_items_dir()))
	found.sort()
	for item: String in found:
		if parse(item).is_empty():
			continue
		var file := FileAccess.open(_path(item), FileAccess.READ)
		if file == null:
			continue
		_names.append(item)
		_sizes[item] = file.get_length()
		_bytes += file.get_length()
		_last_stamp = maxi(_last_stamp, int(item.get_slice("_", 0)))
#endregion


#region Sessions
## The record for `local`, a copy; {} when there is none.
func session(local: String) -> Dictionary:
	var record: Variant = _sessions.get(local)
	return (record as Dictionary).duplicate() if record is Dictionary else {}


func put_session(local: String, record: Dictionary) -> void:
	_sessions[local] = record.duplicate()
	_write_sessions()


## The session and everything queued for it.
func drop_session(local: String) -> void:
	for item in _names.duplicate():
		if parse(item).get("local", "") == local:
			remove(item)
	if _sessions.erase(local):
		_write_sessions()


func sessions() -> PackedStringArray:
	return PackedStringArray(_sessions.keys())


## Lets go of what can never be sent: an item whose session is gone, a session
## with nothing left to send (but `keep`, the run's own), one that never reached
## the server and is older than `stale_s`, and one whose token is older than
## `token_s`, which the server would only refuse.
func prune(now: float, keep: String, stale_s: float, token_s: float) -> void:
	for item in _names.duplicate():
		if not _sessions.has(parse(item).get("local", "")):
			remove(item)
	for local in sessions():
		if local == keep:
			continue
		var record := session(local)
		var started := not str(record.get("sid", "")).is_empty()
		if count_for(local) == 0 \
				or (not started and now - float(record.get("created", 0)) > stale_s) \
				or (started and now - float(record.get("token_at", 0)) > token_s):
			drop_session(local)


func _read_sessions() -> Dictionary:
	var json := JSON.new()
	if json.parse(FileAccess.get_file_as_string(_sessions_path())) != OK or not json.data is Dictionary:
		return {}
	var out := {}
	for local: Variant in json.data:
		if json.data[local] is Dictionary:
			out[str(local)] = json.data[local]
	return out


## Writes what hold_writes kept back, and lets everything after it through.
func release() -> void:
	if hold_writes:
		hold_writes = false
		_write_sessions()


## Through a .tmp, so a quit mid-write leaves the last good file.
func _write_sessions() -> void:
	if hold_writes:
		return
	var tmp := _sessions_path() + ".tmp"
	var file := FileAccess.open(tmp, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(_sessions, "", false))
	file.close()
	if FileAccess.file_exists(_sessions_path()):
		DirAccess.remove_absolute(_sessions_path())
	DirAccess.rename_absolute(tmp, _sessions_path())
#endregion


#region Paths
func _items_dir() -> String:
	return root.path_join(ITEMS)


func _path(item: String) -> String:
	return _items_dir().path_join(item)


func _sessions_path() -> String:
	return root.path_join(SESSIONS)
#endregion
