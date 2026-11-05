extends RefCounted

## Reads a player's data download from fourgames.se/privacy (fourgames-data.zip,
## built by server/gamedata/export.py) into sessions a replay can play:
##
##   open(path)   the .zip itself (read with ZIPReader); or sessions.json from an
##                unzipped one, with the rest of the files read from beside it; or
##                a JSON file of sessions that carry their own "events"
##   parse(files) the same from {name in the zip: its text}, for the tests
##   parse_json(text)  sessions that carry their own events, as text: what the
##                feedback dashboard's "Copy for replay" copies (one session from
##                GET /v1/admin/sessions/<id>, in this same shape), the endpoint's
##                whole answer, or a JSON file of sessions as above
##
## Each gives {ok, error, sessions}. Each session is its sessions.json row
## (session_id, app_id, started, ended, game_version, ..., summary, test) plus:
##
##   events    every batch's events, by seq, then sorted by t (ties kept in order)
##   hardware  its hardware.json row, or {}
##   settings  the settings it started with (settings.json's data), or {}
##   crashes   the crash reports about this session: [{signal, log_tail, ...}]
##   reported  the crash report this session sent about an earlier one, or {}
##   duration  seconds: the playtime it reported, or its last event's t

const EVENTS_DIR := "events/"
const NEEDS := "Open fourgames-data.zip from fourgames.se/privacy, or the sessions.json inside it."
const PASTE_NEEDS := "No session on the clipboard. In the feedback dashboard: Game data, pick a session, " \
		+ "Copy for replay; then Paste session here."


static func open(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		return _fail("There is no file at %s." % path)
	match path.get_extension().to_lower():
		"zip":
			return _open_zip(path)
		"json":
			return _open_json(path)
	return _fail(NEEDS)


static func _open_zip(path: String) -> Dictionary:
	var zip := ZIPReader.new()
	if zip.open(path) != OK:
		return _fail("That zip could not be opened.")
	var files := {}
	for name in zip.get_files():
		if name.ends_with(".json"):
			files[name] = zip.read_file(name).get_string_from_utf8()
	zip.close()
	return parse(files)


static func _open_json(path: String) -> Dictionary:
	var text := FileAccess.get_file_as_string(path)
	var data: Variant = _json(text)
	if data == null:
		return _fail("%s is not JSON." % path.get_file())
	var rows: Variant = data.sessions if data is Dictionary and data.get("sessions") is Array else data
	if not rows is Array:
		# One session from the admin endpoint, saved to a file.
		rows = _rows_of(data)
		if rows.is_empty():
			return _fail(NEEDS)
	if _embedded(rows):
		return _from_rows(rows, {})
	# An unzipped download: the other files are next to sessions.json.
	var base := path.get_base_dir()
	var files := {"sessions.json": text}
	_read_folder(base, "", files, 0)
	return parse(files)


## Sessions with their own events, from text (the clipboard): see the top.
static func parse_json(text: String) -> Dictionary:
	var rows := _rows_of(_json(text.strip_edges()))
	if rows.is_empty():
		return _fail(PASTE_NEEDS)
	if not _embedded(rows):
		return _fail("Those sessions have no events with them (a download's sessions.json): open the whole "
				+ "download with Open download… instead.")
	return _from_rows(rows, {})


## The session rows in what JSON gave: a list of them, {"sessions": [...]},
## the admin endpoint's {"ok": true, "session": {...}}, or one session.
static func _rows_of(data: Variant) -> Array:
	if data is Dictionary and data.get("sessions") is Array:
		data = data.sessions
	elif data is Dictionary and data.get("session") is Dictionary:
		data = [data.session]
	elif data is Dictionary and data.has("session_id"):
		data = [data]
	if not data is Array:
		return []
	return (data as Array).filter(func(row: Variant) -> bool: return row is Dictionary and row.has("session_id"))


static func _embedded(rows: Array) -> bool:
	for row: Variant in rows:
		if row is Dictionary and row.get("events") is Array:
			return true
	return false


## Every .json under `folder`, by its path inside it, a few levels down.
static func _read_folder(folder: String, inside: String, files: Dictionary, depth: int) -> void:
	if depth > 4:
		return
	var here := folder.path_join(inside) if not inside.is_empty() else folder
	for file in DirAccess.get_files_at(here):
		var name := inside.path_join(file) if not inside.is_empty() else file
		if file.ends_with(".json") and not files.has(name):
			files[name] = FileAccess.get_file_as_string(here.path_join(file))
	for sub in DirAccess.get_directories_at(here):
		_read_folder(folder, inside.path_join(sub) if not inside.is_empty() else sub, files, depth + 1)


## {name: text} of a download's JSON files -> {ok, error, sessions}.
static func parse(files: Dictionary) -> Dictionary:
	if not files.has("sessions.json"):
		return _fail("There is no sessions.json in it. " + NEEDS)
	var rows: Variant = _json(str(files["sessions.json"]))
	if not rows is Array:
		return _fail("sessions.json is not a list of sessions.")
	var extra := {"hardware": {}, "settings": {}, "batches": {}, "crashes": {}, "reported": {}}
	for row: Variant in _list(files.get("hardware.json")):
		extra.hardware[str(row.get("session_id", ""))] = row
	for row: Variant in _list(files.get("settings.json")):
		var data: Variant = row.get("data")
		extra.settings[str(row.get("session_id", ""))] = data if data is Dictionary else {}
	for name: String in files:
		if not name.begins_with(EVENTS_DIR):
			continue
		var batch: Variant = _json(str(files[name]))
		if not batch is Dictionary or not batch.get("events") is Array:
			continue
		var parts := name.split("/")
		var sid := str(batch.get("session_id", parts[2] if parts.size() > 2 else ""))
		var seq := int(batch.get("seq", parts[-1].get_basename().to_int()))
		if not extra.batches.has(sid):
			extra.batches[sid] = []
		extra.batches[sid].append([seq, batch.events])
	for row: Variant in _list(files.get("crashes.json")):
		var report: Dictionary = (row as Dictionary).duplicate()
		var log_file := str(row.get("log_file", ""))
		var log: Variant = _json(str(files.get(log_file, ""))) if files.has(log_file) else null
		if log is Dictionary:
			report["log_tail"] = log.get("log_tail")
			report["last_events"] = log.get("last_events", [])
		var crashed := str(row.get("crashed_session_id", ""))
		if not crashed.is_empty() and crashed != "<null>":
			if not extra.crashes.has(crashed):
				extra.crashes[crashed] = []
			extra.crashes[crashed].append(report)
		extra.reported[str(row.get("session_id", ""))] = report
	return _from_rows(rows, extra)


static func _from_rows(rows: Array, extra: Dictionary) -> Dictionary:
	var sessions: Array = []
	for row: Variant in rows:
		if not row is Dictionary:
			continue
		var session: Dictionary = (row as Dictionary).duplicate()
		var sid := str(session.get("session_id", ""))
		session["session_id"] = sid
		session["app_id"] = int(session.get("app_id", 0)) if session.get("app_id") != null else 0
		session["test"] = session.get("test") == true
		var events: Array = session.get("events", []) if session.get("events") is Array else []
		if extra.has("batches"):
			var batches: Array = extra.batches.get(sid, [])
			batches.sort_custom(func(a: Array, b: Array) -> bool: return a[0] < b[0])
			for batch: Array in batches:
				events.append_array(batch[1])
		session["events"] = sort_events(events)
		session["hardware"] = extra.get("hardware", {}).get(sid, session.get("hardware", {}))
		if not session.hardware is Dictionary:
			session.hardware = {}
		session["settings"] = extra.get("settings", {}).get(sid, session.get("settings", {}))
		if not session.settings is Dictionary:
			session.settings = {}
		session["crashes"] = extra.get("crashes", {}).get(sid, session.get("crashes", []))
		session["reported"] = extra.get("reported", {}).get(sid, session.get("reported", {}))
		if not session.reported is Dictionary:
			session.reported = {}
		session["duration"] = duration_of(session)
		sessions.append(session)
	# Newest first; the times are ISO strings, which sort as they read.
	sessions.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		return str(a.get("started", "")) > str(b.get("started", "")))
	return {"ok": true, "error": "", "sessions": sessions}


## A session list's line: "2026-11-05 14:03  3:12  app 5207970  TEST  412 events".
static func label(session: Dictionary) -> String:
	var started := str(session.get("started", "")).replace("T", " ").left(16)
	var seconds := floori(float(session.get("duration", 0.0)))
	return "%s  %d:%02d  app %d%s  %d events" % [started, seconds / 60, seconds % 60, int(session.get("app_id", 0)),
			"  TEST" if session.get("test") == true else "", session.get("events", []).size()]


## Events by t, those with the same t in the order they came: the plugin stamps
## a frame's events with one time, and their order still says what came first.
static func sort_events(events: Array) -> Array:
	var keyed: Array = []
	for i in events.size():
		var event: Variant = events[i]
		if event is Dictionary and (event.get("t") is float or event.get("t") is int):
			keyed.append([float(event.t), i, event])
	keyed.sort_custom(func(a: Array, b: Array) -> bool: return a[0] < b[0] or (a[0] == b[0] and a[1] < b[1]))
	var out: Array = []
	for item: Array in keyed:
		out.append(item[2])
	return out


## How long the session was: what the game reported at its end, else (no end,
## a crash) the last event's time.
static func duration_of(session: Dictionary) -> float:
	var events: Array = session.get("events", [])
	var last := float(events[-1].t) if not events.is_empty() else 0.0
	var played: Variant = session.get("playtime_s")
	if played == null and session.get("summary") is Dictionary:
		played = session.summary.get("playtime_s")
	return maxf(last, float(played) if played is float or played is int else 0.0)


static func _list(text: Variant) -> Array:
	if text == null:
		return []
	var data: Variant = _json(str(text))
	var out: Array = []
	if data is Array:
		for row: Variant in data:
			if row is Dictionary:
				out.append(row)
	return out


## The value in `text`, or null when it is not JSON (quietly: a damaged file in
## a download is skipped, not an engine error).
static func _json(text: String) -> Variant:
	var json := JSON.new()
	return json.data if json.parse(text) == OK else null


static func _fail(why: String) -> Dictionary:
	return {"ok": false, "error": why, "sessions": []}
