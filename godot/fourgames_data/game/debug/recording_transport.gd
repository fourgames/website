extends "res://addons/fourgames_data/http_transport.gd"

## The addon's own transport, unchanged, but remembering how its last request
## went, for the test game's data panel (F1). GameData takes it in place of the
## one it would make: set GameData.transport before GameData.start().

## {path, code, at (ticks msec), quit (sent while quitting)}; {} before any.
var last := {}
var sent := 0
var failed := 0


func send(url: String, headers: PackedStringArray, body: PackedByteArray, done: Callable) -> void:
	var path := _path_of(url)
	super.send(url, headers, body, func(code: int, reply: PackedByteArray) -> void:
		_note(path, code, false)
		done.call(code, reply))


func send_now(url: String, headers: PackedStringArray, body: PackedByteArray, deadline_ms: int) -> int:
	var code := super.send_now(url, headers, body, deadline_ms)
	_note(_path_of(url), code, true)
	return code


func _note(path: String, code: int, quitting: bool) -> void:
	last = {"path": path, "code": code, "at": Time.get_ticks_msec(), "quit": quitting}
	if code >= 200 and code < 300:
		sent += 1
	else:
		failed += 1


static func _path_of(url: String) -> String:
	var at := url.find("/v1/")
	return url.substr(at + 3) if at >= 0 else url
