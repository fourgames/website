extends RefCounted

## "Copy for Claude": one session as plain text someone can paste into a chat --
## what was played and how it went, then the key events as JSON, cut to stay
## near JSON_CAP bytes. build(session) takes a session from export_reader.gd.

const Levels := preload("res://game/levels.gd")
const Timeline := preload("res://game/replay/timeline.gd")

const JSON_CAP := 15 * 1024
const JSON_MARK := "== Key events (JSON) =="
## The events the JSON keeps first, and the ones it keeps when there is room.
const KEY_TYPES := ["action", "death", "progress", "setting_changed", "error", "achievement", "custom", "rng"]
const MORE_TYPES := ["snapshot", "screen", "load", "idle", "input", "steam", "overlay", "ui"]
const LOG_LINES := 20


static func build(session: Dictionary, timeline: RefCounted = null) -> String:
	var line: Timeline = timeline if timeline != null else Timeline.new(session)
	var events: Array = session.get("events", [])
	var ours := _is_test_project(line)
	var out: PackedStringArray = []
	if ours:
		out.append("Here is a play session from the fourgames_data test project (Four Games' player-data test game); "
				+ "it was downloaded from fourgames.se/privacy and summarised by the project's replay viewer.")
	else:
		out.append("Here is a play session of Steam app %d, downloaded from fourgames.se/privacy and summarised "
				% int(session.get("app_id", 0)) + "by the fourgames_data replay viewer.")
	out.append("")
	out.append_array(_session_part(session, line))
	out.append_array(_levels_part(line, events) if ours else _scenes_part(line, events))
	out.append_array(_deaths_part(line))
	out.append_array(_settings_part(session, events))
	out.append_array(_perf_part(events))
	out.append_array(_hardware_part(session))
	out.append_array(_trouble_part(session, events))
	out.append(JSON_MARK)
	out.append(key_events_json(events))
	return "\n".join(out)


static func _is_test_project(line: Timeline) -> bool:
	for scene in line.scenes():
		if not Levels.for_scene(scene).is_empty():
			return true
	return false


static func _session_part(session: Dictionary, line: Timeline) -> PackedStringArray:
	var out: PackedStringArray = ["== Session =="]
	out.append("id %s, app %d%s" % [session.get("session_id", "?"), int(session.get("app_id", 0)),
			", a TEST session" if session.get("test") == true else ""])
	var summary: Dictionary = session.summary if session.get("summary") is Dictionary else {}
	var length := "length %s" % Timeline.clock(line.duration)
	var active: Variant = _first(session.get("active_s"), summary.get("active_s"))
	if active != null:
		# Older plugins could count paused time as active: never more than the length.
		var active_s := minf(_num(active), line.duration)
		var idle_s := minf(_num(_first(session.get("idle_s"), summary.get("idle_s"))), maxf(line.duration - active_s, 0.0))
		length += " (active %s, idle %s)" % [Timeline.clock(active_s), Timeline.clock(idle_s)]
	out.append("started %s, %s" % [session.get("started", "?"), length])
	out.append("game %s (build %s), Godot %s, %s, locale %s%s" % [_text(session.get("game_version")),
			_text(session.get("build_id")), _text(session.get("godot_version")), _text(session.get("platform")),
			_text(session.get("locale")), (", from " + str(session.country)) if session.get("country") is String else ""])
	if session.get("ended") is String:
		out.append("ended cleanly at %s on %s" % [session.ended, _text(_first(session.get("last_scene"), summary.get("last_scene")))])
	else:
		out.append("no end received (the game crashed, was killed, or is still uploading)")
	if not summary.is_empty():
		out.append("end summary: %d events, %d actions, %d errors, session %s on this install (%s)" % [
				int(_num(summary.get("events"))), int(_num(summary.get("actions"))), int(_num(summary.get("errors"))),
				_text(summary.get("session_number")), _text(summary.get("boot_kind"))])
	out.append("")
	return out


## Per level of the test game: when it was entered and finished, coins, deaths.
static func _levels_part(line: Timeline, events: Array) -> PackedStringArray:
	var out: PackedStringArray = ["== Levels =="]
	var coins := 0
	var deaths := 0
	for level_id in Levels.ORDER:
		var scene := Levels.scene_of(level_id)
		var entered := -1.0
		var finished := {}
		var level_coins := {}
		var level_deaths := 0
		for event: Dictionary in events:
			var data: Dictionary = event.data if event.get("data") is Dictionary else {}
			if entered < 0.0 and event.get("type") == "load" and data.get("scene") == scene:
				entered = float(event.t)
			if str(data.get("level", "")) != level_id:
				continue
			if entered < 0.0:
				entered = float(event.t)
			if event.get("type") == "death":
				level_deaths += 1
			elif event.get("type") == "action" and event.get("name") == "coin":
				level_coins[int(data.get("coin", -1))] = true
			elif event.get("type") == "action" and event.get("name") == "level_complete" and finished.is_empty():
				finished = {"t": float(event.t), "time_s": data.get("time_s")}
		if entered < 0.0:
			continue
		coins += level_coins.size()
		deaths += level_deaths
		var max_coins: int = Levels.level(level_id).coins.size()
		var done := "completed at %s (%s s on the level)" % [Timeline.clock(finished.t), _text(finished.time_s)] \
				if not finished.is_empty() else "not completed"
		out.append("%s \"%s\": entered %s, %s, coins %d/%d, deaths %d" % [level_id, Levels.level(level_id).name,
				Timeline.clock(entered), done, level_coins.size(), max_coins, level_deaths])
	out.append("total: %d coins, %d deaths" % [coins, deaths])
	out.append("")
	return out


## Another game's: the scenes it showed, when, for how long.
static func _scenes_part(line: Timeline, events: Array) -> PackedStringArray:
	var out: PackedStringArray = ["== Scenes =="]
	var changes: Array = []
	for event: Dictionary in events:
		if event.get("type") == "load" and event.get("name") == "scene" and event.get("data") is Dictionary:
			changes.append({"t": float(event.t), "scene": str(event.data.get("scene", ""))})
	if changes.is_empty():
		for scene in line.scenes():
			out.append(scene)
	for i in changes.size():
		var until: float = changes[i + 1].t if i + 1 < changes.size() else line.duration
		out.append("%s %s for %s" % [Timeline.clock(changes[i].t), changes[i].scene, Timeline.clock(until - changes[i].t)])
	var actions := 0
	for event: Dictionary in events:
		if event.get("type") == "action":
			actions += 1
	out.append("%d actions, %d deaths" % [actions, line.deaths.size()])
	out.append("")
	return out


static func _deaths_part(line: Timeline) -> PackedStringArray:
	var out: PackedStringArray = ["== Deaths =="]
	for death: Dictionary in line.deaths:
		var where := "(%d, %d)" % [int(death.p.x), int(death.p.y)] if death.p != null else "(no position)"
		var place := Levels.for_scene(death.scene)
		out.append("%s %s, %s at %s" % [Timeline.clock(death.t), place if not place.is_empty() else str(death.scene),
				death.cause if not str(death.cause).is_empty() else "no cause", where])
	if line.deaths.is_empty():
		out.append("none")
	out.append("")
	return out


static func _settings_part(session: Dictionary, events: Array) -> PackedStringArray:
	var out: PackedStringArray = ["== Settings =="]
	var start: Dictionary = session.get("settings", {})
	var keys := start.keys()
	keys.sort()
	var parts: PackedStringArray = []
	for key: Variant in keys:
		parts.append("%s=%s" % [key, Timeline._short(start[key])])
	out.append("at start: " + (", ".join(parts) if not parts.is_empty() else "(none sent)"))
	var changed := false
	for event: Dictionary in events:
		if event.get("type") == "setting_changed" and event.get("data") is Dictionary:
			changed = true
			out.append("%s %s: %s -> %s" % [Timeline.clock(float(event.t)), event.data.get("key", "?"),
					Timeline._short(event.data.get("old")), Timeline._short(event.data.get("new"))])
	if not changed:
		out.append("no changes")
	out.append("")
	return out


## The "perf" events, per scene and the screen over it ("level_1", "level_1,
## pause screen"): fps averaged over the frames, the lowest 1% low, the longest
## frame, frames over 50 ms. The perf a scene change sends names the scene it
## was about but often the next scene's screen (the new scene says its screen as
## it starts, a frame before the plugin sees the change), so its frames go with
## the scene's last perf before it.
static func _perf_part(events: Array) -> PackedStringArray:
	var out: PackedStringArray = ["== Performance (per scene and screen) =="]
	var by := {}
	var order: Array = []
	var last_key := {}
	for event: Dictionary in events:
		if event.get("type") == "load" and event.get("name") == "boot" and event.get("data") is Dictionary:
			out.append("boot: %s to the first frame, %s to playable (%s)" % [_ms(event.data.get("boot_ms")),
					_ms(event.data.get("to_play_ms")), _text(event.data.get("boot_kind"))])
		if event.get("type") != "perf" or not event.get("data") is Dictionary:
			continue
		var data: Dictionary = event.data
		var frames := int(_num(data.get("frames")))
		if frames <= 0 or not (data.get("fps_avg") is float or data.get("fps_avg") is int):
			continue
		var scene := str(data.get("scene", "")).get_file().get_basename()
		var screen := str(data.get("screen", ""))
		var key := scene if not scene.is_empty() else "(no scene)"
		if data.get("why") == "scene_change":
			key = last_key.get(scene, key)
		elif not screen.is_empty():
			key += ", %s screen" % screen
		last_key[scene] = key
		if not by.has(key):
			by[key] = {"frames": 0, "time_ms": 0.0, "low": INF, "worst": 0.0, "slow": 0}
			order.append(key)
		var entry: Dictionary = by[key]
		entry.frames += frames
		entry.time_ms += frames * 1000.0 / maxf(float(data.fps_avg), 0.001)
		if data.get("fps_1pct_low") is float or data.get("fps_1pct_low") is int:
			entry.low = minf(entry.low, float(data.fps_1pct_low))
		entry.worst = maxf(entry.worst, _num(data.get("frame_ms_max")))
		entry.slow += int(_num(data.get("slow_frames")))
	for key: String in order:
		var entry: Dictionary = by[key]
		out.append("%s: %.1f fps avg, min (1%% low) %s, worst frame %.1f ms, %d stutters (frames over 50 ms), %d frames" % [
				key, entry.frames * 1000.0 / maxf(entry.time_ms, 0.001),
				("%.1f" % entry.low) if entry.low != INF else "?", entry.worst, entry.slow, entry.frames])
	if order.is_empty():
		out.append("no perf events")
	out.append("")
	return out


static func _hardware_part(session: Dictionary) -> PackedStringArray:
	var hw: Dictionary = session.get("hardware", {})
	if hw.is_empty():
		return PackedStringArray(["== Hardware ==", "not sent (no hardware consent, or none in the download)", ""])
	var screen := ""
	if hw.get("screen_w") != null:
		screen = "%dx%d" % [int(_num(hw.screen_w)), int(_num(hw.get("screen_h")))]
	elif hw.get("screen") is Array and hw.screen.size() == 2:
		screen = "%dx%d" % [int(_num(hw.screen[0])), int(_num(hw.screen[1]))]
	var gpu := str(hw.get("gpu", "")) if hw.get("gpu") is String and not str(hw.gpu).is_empty() else "GPU unknown"
	if hw.get("gpu_driver") is String and not str(hw.gpu_driver).is_empty():
		gpu += ", driver " + str(hw.gpu_driver)
	var parts: PackedStringArray = [_text(hw.get("os")), "%s (%s cores)" % [_text(hw.get("cpu")), _text(hw.get("cpu_cores"))],
			"%.0f GB RAM" % (_num(hw.get("ram_mb")) / 1024.0), gpu, _text(hw.get("renderer"))]
	if not screen.is_empty() and screen != "0x0":
		parts.append("%s @ %s Hz" % [screen, _text(hw.get("refresh_hz"))])
	if hw.get("steam_deck") == true:
		parts.append("Steam Deck")
	return PackedStringArray(["== Hardware ==", " | ".join(parts), ""])


static func _trouble_part(session: Dictionary, events: Array) -> PackedStringArray:
	var out: PackedStringArray = ["== Errors and crashes =="]
	for event: Dictionary in events:
		if event.get("type") == "error" and event.get("data") is Dictionary:
			out.append("%s %s: %s (%s:%s in %s)" % [Timeline.clock(float(event.t)), event.get("name", "error"),
					str(event.data.get("message", "")).left(300), _text(event.data.get("file")),
					_text(event.data.get("line")), _text(event.data.get("function"))])
	for crash: Variant in session.get("crashes", []):
		if not crash is Dictionary:
			continue
		out.append("this session crashed: %s, reported %s by session %s" % [_text(crash.get("signal")),
				_text(crash.get("received")), _text(crash.get("session_id"))])
		var tail := str(crash.get("log_tail", "")) if crash.get("log_tail") is String else ""
		if not tail.is_empty():
			var lines := tail.strip_edges().split("\n")
			out.append("log tail (last %d lines):" % mini(lines.size(), LOG_LINES))
			for text in lines.slice(maxi(lines.size() - LOG_LINES, 0)):
				out.append("  " + text.left(300))
	var reported: Dictionary = session.get("reported", {})
	if not reported.is_empty():
		out.append("this launch reported a crash of session %s (%s)" % [_text(reported.get("crashed_session_id")),
				_text(reported.get("signal"))])
	if out.size() == 1:
		out.append("none")
	out.append("")
	return out


## The key events as one JSON array, at most about JSON_CAP bytes: the game's
## own events first; then, if they all fit, the plugin's screens, loads, idles
## and snapshots too. Positions and perf are left out (the sections above have
## them). What did not fit is counted in a last {"left_out": n} entry.
static func key_events_json(events: Array) -> String:
	var both := _fit(events, KEY_TYPES + MORE_TYPES)
	if both.left_out == 0:
		return both.text
	return _fit(events, KEY_TYPES).text


static func _fit(events: Array, types: Array) -> Dictionary:
	var parts: PackedStringArray = []
	var size := 2
	var left_out := 0
	for event: Dictionary in events:
		if not str(event.get("type", "")) in types:
			continue
		var text := JSON.stringify(Timeline.tidy(event), "", false)
		var bytes := text.to_utf8_buffer().size() + 2
		if left_out > 0 or size + bytes > JSON_CAP - 40:
			left_out += 1
			continue
		parts.append(text)
		size += bytes
	if left_out > 0:
		parts.append(JSON.stringify({"left_out": left_out}))
	return {"text": "[" + ",\n".join(parts) + "]", "left_out": left_out}


static func _first(value: Variant, otherwise: Variant) -> Variant:
	return value if value != null else otherwise


static func _num(value: Variant) -> float:
	return float(value) if value is float or value is int else 0.0


## "812 ms", or "not measured" for a time the plugin couldn't take.
static func _ms(value: Variant) -> String:
	return "%s ms" % _text(value) if value != null else "not measured"


static func _text(value: Variant) -> String:
	if value == null:
		return "?"
	if value is float and value == floorf(value):
		return str(int(value))
	return str(value)
