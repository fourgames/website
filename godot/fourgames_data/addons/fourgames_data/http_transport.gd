extends Node

## How the plugin reaches the server. While the game runs: one HTTPRequest at a
## time, on a thread of its own, so a slow or dead network never costs a frame.
## While it quits: a blocking HTTPClient under a deadline, since nothing polls a
## request once the main loop has stopped, and the quit must not wait longer
## than GameData.QUIT_BUDGET_MS whatever the network does.
##
## A test hands GameData a stand-in with the same three methods instead.

const TIMEOUT_S := 20.0
const USER_AGENT := "fourgames_data/1.0 (Godot)"

var _http: HTTPRequest = null
var _done := Callable()
var _sync: HTTPClient = null
var _sync_at := ""


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS


#region While the game runs
func busy() -> bool:
	return _done.is_valid()


## POSTs `body` to `url`. `done(code, body)` hears the status code -- 0 when no
## answer came at all -- and the reply's body.
func send(url: String, headers: PackedStringArray, body: PackedByteArray, done: Callable) -> void:
	if _http == null:
		_http = HTTPRequest.new()
		_http.name = "Request"
		_http.use_threads = true
		_http.timeout = TIMEOUT_S
		_http.process_mode = Node.PROCESS_MODE_ALWAYS
		_http.request_completed.connect(_on_completed)
		add_child(_http)
	_done = done
	if not _http.is_inside_tree() \
			or _http.request_raw(url, _with_agent(headers), HTTPClient.METHOD_POST, body) != OK:
		_finish(0, PackedByteArray())


func _on_completed(result: int, code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	_finish(code if result == HTTPRequest.RESULT_SUCCESS else 0, body)


func _finish(code: int, body: PackedByteArray) -> void:
	var done := _done
	_done = Callable()
	if done.is_valid():
		done.call(code, body)
#endregion


#region While it quits
## POSTs `body` to `url` and waits for the status code, but never past
## `deadline_ms` (Time.get_ticks_msec()): 0 when the time ran out first or no
## answer came. One connection is kept between calls to the same server, so a
## few requests in a row pay for one handshake; when the server has closed that
## connection meanwhile, the request is tried once more on a new one.
func send_now(url: String, headers: PackedStringArray, body: PackedByteArray, deadline_ms: int) -> int:
	var at := split_url(url)
	if at.is_empty():
		return 0
	var server := "%s://%s:%d" % [at.scheme, at.host, at.port]
	var reused := _sync != null and _sync_at == server and _sync.get_status() == HTTPClient.STATUS_CONNECTED
	var code := _attempt(at, server, headers, body, deadline_ms, reused)
	if code == 0 and reused and Time.get_ticks_msec() < deadline_ms:
		code = _attempt(at, server, headers, body, deadline_ms, false)
	return code


func _attempt(at: Dictionary, server: String, headers: PackedStringArray, body: PackedByteArray,
		deadline_ms: int, reuse: bool) -> int:
	if not reuse:
		_drop()
		_sync = HTTPClient.new()
		_sync_at = server
		var tls: TLSOptions = TLSOptions.client() if at.scheme == "https" else null
		if _sync.connect_to_host(at.host, at.port, tls) != OK:
			return _drop()
		while _sync.get_status() in [HTTPClient.STATUS_RESOLVING, HTTPClient.STATUS_CONNECTING]:
			if not _wait(deadline_ms):
				return _drop()
	if _sync.get_status() != HTTPClient.STATUS_CONNECTED:
		return _drop()
	if _sync.request_raw(HTTPClient.METHOD_POST, at.path, _with_agent(headers), body) != OK:
		return _drop()
	while _sync.get_status() == HTTPClient.STATUS_REQUESTING:
		if not _wait(deadline_ms):
			return _drop()
	if not _sync.has_response():
		return _drop()
	var code := _sync.get_response_code()
	# Read to the end, so the connection can carry the next request.
	while _sync.get_status() == HTTPClient.STATUS_BODY:
		_sync.read_response_body_chunk()
		if not _wait(deadline_ms):
			_drop()
			break
	return code


## One poll, then a millisecond's sleep. False once the deadline has passed.
func _wait(deadline_ms: int) -> bool:
	if Time.get_ticks_msec() >= deadline_ms:
		return false
	OS.delay_msec(1)
	_sync.poll()
	return true


func _drop() -> int:
	if _sync != null:
		_sync.close()
	_sync = null
	return 0
#endregion


## {scheme, host, port, path} of an http(s) URL; {} for anything else.
static func split_url(url: String) -> Dictionary:
	var scheme := ""
	if url.begins_with("https://"):
		scheme = "https"
	elif url.begins_with("http://"):
		scheme = "http"
	else:
		return {}
	var rest := url.substr(scheme.length() + 3)
	var slash := rest.find("/")
	var server := rest if slash < 0 else rest.substr(0, slash)
	var host := server
	var port := 443 if scheme == "https" else 80
	var colon := server.rfind(":")
	if colon > 0 and not server.ends_with("]") and server.substr(colon + 1).is_valid_int():
		host = server.substr(0, colon)
		port = int(server.substr(colon + 1))
	if host.is_empty():
		return {}
	return {"scheme": scheme, "host": host, "port": port, "path": "/" if slash < 0 else rest.substr(slash)}


func _with_agent(headers: PackedStringArray) -> PackedStringArray:
	var out := headers.duplicate()
	out.append("User-Agent: " + USER_AGENT)
	return out
