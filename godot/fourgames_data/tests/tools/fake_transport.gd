extends RefCounted

## Stands in for http_transport.gd: every request is written down, decoded, and
## answered at once from `replies`, the way the server in SPEC.md would answer.
##
## `replies` maps a path ("/events") to a status code, or to [code, reply]. With
## no entry, /session/start says ok with a fresh session id ("S1", "S2", ...)
## and token ("T1", ...), and everything else says 200 {"ok": true}. A code of 0
## is no answer at all, as a dead network gives.

var replies := {}
## Every request, in order: {url, path, headers, raw (the bytes), text, json, deadline}.
var requests: Array[Dictionary] = []
## Of those, the ones sent with send_now() as the game quit.
var quit_requests: Array[Dictionary] = []
## The quit's clock: what GameData.ticks_msec reads, and how long each send_now() takes on it.
var ticks := 0
var quit_cost_ms := 0
## Counted across every stand-in in a test, so each launch's session is new: S1, then S2.
static var _sessions := 0


## A test's sessions count from S1 again.
static func reset() -> void:
	_sessions = 0


func busy() -> bool:
	return false


func send(url: String, headers: PackedStringArray, body: PackedByteArray, done: Callable) -> void:
	var request := _note(url, headers, body, -1)
	var answer := _answer(request.path)
	done.call(answer[0], JSON.stringify(answer[1]).to_utf8_buffer())


func send_now(url: String, headers: PackedStringArray, body: PackedByteArray, deadline_ms: int) -> int:
	var request := _note(url, headers, body, deadline_ms)
	quit_requests.append(request)
	ticks += quit_cost_ms
	if ticks > deadline_ms:
		return 0
	return int(_answer(request.path)[0])


## The requests to `path`, in order.
func to(path: String) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for request in requests:
		if request.path == path:
			out.append(request)
	return out


func paths() -> PackedStringArray:
	var out: PackedStringArray = []
	for request in requests:
		out.append(request.path)
	return out


func _note(url: String, headers: PackedStringArray, body: PackedByteArray, deadline_ms: int) -> Dictionary:
	var raw := body
	if "Content-Encoding: gzip" in headers:
		raw = body.decompress_dynamic(-1, FileAccess.COMPRESSION_GZIP)
	var text := raw.get_string_from_utf8()
	var json := JSON.new()
	var request := {"url": url, "path": url.substr(url.find("/v1") + 3), "headers": headers,
			"raw": body, "text": text, "json": json.data if json.parse(text) == OK else null,
			"deadline": deadline_ms}
	requests.append(request)
	return request


func _answer(path: String) -> Array:
	var given: Variant = replies.get(path)
	if given is int:
		return [given, {"ok": given >= 200 and given < 300}]
	if given is Array:
		return given
	if path == "/session/start":
		_sessions += 1
		return [200, {"ok": true, "session_id": "S%d" % _sessions, "token": "T%d" % _sessions,
				"opted_out": false, "upload_every_s": 60, "max_batch_kb": 256,
				"privacy_url": "https://fourgames.se/privacy"}]
	return [200, {"ok": true}]
