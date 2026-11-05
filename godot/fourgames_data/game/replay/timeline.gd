extends RefCounted

## One session, ready to replay: where the player was at any time, the path they
## took through each scene, where they died, the ticks for the timeline bar and
## the events for the side list. Built from a session export_reader.gd made.
##
## Positions come from the plugin's "position" events (every position_every_s
## while the player moves, none while they stand still) and the places in
## "death" events, where a line ends. 3D games' positions are drawn top-down (x, z). Between two
## samples the marker moves only over the last `step` seconds before the second
## (the usual gap between samples), so a player who stood still stays put rather
## than drifting. A path is cut where the player could not have walked: a death,
## a respawn, a scene change.

const Levels := preload("res://game/levels.gd")

## The kinds the timeline bar marks, by what the event was.
const TICK_KINDS := ["coin", "death", "level_complete", "respawn", "setting_changed", "error", "action"]

var session: Dictionary
## Sorted by t (export_reader.gd did).
var events: Array = []
var duration := 0.0
## [{t, scene, p: Vector2, cut: bool (no path from the one before)}]
var positions: Array = []
## [{t, scene, p (Vector2 or null), cause}]
var deaths: Array = []
## [{t, kind, index}] for the timeline bar.
var ticks: Array = []
## The events the side list shows (all but "position"), as indexes into events.
var listed: Array[int] = []
## The usual seconds between two position samples.
var step := 0.5
## [{t, scene}]: which scene was up from when.
var _scenes: Array = []


func _init(from: Dictionary) -> void:
	session = from
	events = from.get("events", [])
	duration = float(from.get("duration", 0.0))
	var cut := true
	var scene := ""
	var gaps: Array[float] = []
	for i in events.size():
		var event: Dictionary = events[i]
		var t := float(event.get("t", 0.0))
		var type := str(event.get("type", ""))
		var name := str(event.get("name", ""))
		var data: Dictionary = event.data if event.get("data") is Dictionary else {}
		duration = maxf(duration, t)
		if type != "position":
			listed.append(i)
		var said_scene := str(data.get("scene", "")) if data.get("scene") is String else ""
		if not said_scene.is_empty() and said_scene != scene and type in ["position", "death", "load"]:
			scene = said_scene
			_scenes.append({"t": t, "scene": scene})
			cut = true
		match type:
			"position":
				var p: Variant = point_of(data)
				if p != null:
					if not cut and not positions.is_empty():
						gaps.append(t - float(positions[-1].t))
					positions.append({"t": t, "scene": scene, "p": p, "cut": cut})
					cut = false
			"death":
				var p: Variant = point_of(data)
				deaths.append({"t": t, "scene": scene, "p": p, "cause": str(data.get("cause", ""))})
				if p != null:
					# Where they fell is the end of the line they walked.
					positions.append({"t": t, "scene": scene, "p": p, "cut": cut})
				cut = true
			"action":
				if name == "respawn":
					cut = true
		var kind := tick_kind(event)
		if not kind.is_empty():
			ticks.append({"t": t, "kind": kind, "index": i})
	if not gaps.is_empty():
		gaps.sort()
		step = clampf(gaps[gaps.size() / 2], 0.1, 5.0)


## What a timeline tick shows for an event, "" for none.
static func tick_kind(event: Dictionary) -> String:
	match str(event.get("type", "")):
		"death":
			return "death"
		"setting_changed":
			return "setting_changed"
		"error":
			return "error"
		"action":
			var name := str(event.get("name", ""))
			return name if name in ["coin", "level_complete", "respawn"] else "action"
	return ""


## A position event's place on the map: (x, y), or (x, z) in 3D; null without one.
static func point_of(data: Dictionary) -> Variant:
	var x: Variant = data.get("x")
	var y: Variant = data.get("z") if data.has("z") else data.get("y")
	if (x is float or x is int) and (y is float or y is int):
		return Vector2(float(x), float(y))
	return null


#region At a time
## The scene up at `t`: the last one a position, death or load named by then
## (the first one before any).
func scene_at(t: float) -> String:
	if _scenes.is_empty():
		return ""
	var i := _last_at(_scenes, t)
	return str(_scenes[maxi(i, 0)].scene)


## Every scene the session showed, in order, once each.
func scenes() -> PackedStringArray:
	var out: PackedStringArray = []
	for entry: Dictionary in _scenes:
		if not entry.scene in out:
			out.append(entry.scene)
	return out


## Where the player was at `t`: {ok, p, scene, index}; ok false before the first
## position, or when the scene up at `t` has none yet.
func position_at(t: float) -> Dictionary:
	var i := _last_at(positions, t)
	if i < 0:
		return {"ok": false}
	var a: Dictionary = positions[i]
	var p: Vector2 = a.p
	if i + 1 < positions.size():
		var b: Dictionary = positions[i + 1]
		if not b.cut and b.scene == a.scene:
			var from := maxf(float(a.t), float(b.t) - step)
			if t > from and float(b.t) > from:
				p = (a.p as Vector2).lerp(b.p, clampf((t - from) / (float(b.t) - from), 0.0, 1.0))
	var now := scene_at(t)
	return {"ok": a.scene == now, "p": p, "scene": a.scene, "index": i}


## The index in `listed` of the last listed event at or before `t`; -1 before any.
func list_index_at(t: float) -> int:
	var lo := 0
	var hi := listed.size() - 1
	var found := -1
	while lo <= hi:
		var mid := (lo + hi) / 2
		if float(events[listed[mid]].t) <= t:
			found = mid
			lo = mid + 1
		else:
			hi = mid - 1
	return found


## The coins taken on `scene`'s level by `t`, coin index -> true (the test
## game's "coin" actions).
func coins_taken(scene: String, t: float) -> Dictionary:
	var level := Levels.for_scene(scene)
	var out := {}
	for event: Dictionary in events:
		if float(event.t) > t:
			break
		if event.get("type") == "action" and event.get("name") == "coin" and event.get("data") is Dictionary \
				and str(event.data.get("level", "")) == level:
			out[int(event.data.get("coin", -1))] = true
	return out
#endregion


#region Whole scenes
## The paths through `scene`, each a line the player walked without a cut; up
## to `until` seconds (the last point where the player was then) when given.
func paths(scene: String, until := INF) -> Array[PackedVector2Array]:
	var out: Array[PackedVector2Array] = []
	var line := PackedVector2Array()
	for entry: Dictionary in positions:
		if float(entry.t) > until:
			break
		if entry.scene != scene:
			continue
		if entry.cut and line.size() > 0:
			out.append(line)
			line = PackedVector2Array()
		line.append(entry.p)
	if until != INF:
		var now := position_at(until)
		if now.ok and now.scene == scene and line.size() > 0:
			line.append(now.p)
	if line.size() > 0:
		out.append(line)
	return out


func deaths_in(scene: String) -> Array:
	return deaths.filter(func(death: Dictionary) -> bool: return death.scene == scene and death.p != null)


## How many position samples fell in each `cell`-sized square of `scene`:
## Vector2i -> count.
func heat(scene: String, cell: float) -> Dictionary:
	var out := {}
	for entry: Dictionary in positions:
		if entry.scene == scene:
			var at := Vector2i(((entry.p as Vector2) / cell).floor())
			out[at] = int(out.get(at, 0)) + 1
	return out


## What `scene`'s positions and deaths cover; a 100 x 100 square at 0 for none.
func bounds(scene: String) -> Rect2:
	var box := Rect2()
	var any := false
	for entry: Dictionary in positions:
		if entry.scene == scene:
			box = box.expand(entry.p) if any else Rect2(entry.p, Vector2.ZERO)
			any = true
	for death: Dictionary in deaths_in(scene):
		box = box.expand(death.p) if any else Rect2(death.p, Vector2.ZERO)
		any = true
	if not any:
		return Rect2(0, 0, 100, 100)
	return box
#endregion


#region Words
## One line for the side list: "1:23.4  coin  level_1 #3".
static func describe(event: Dictionary) -> String:
	var data: Dictionary = event.data if event.get("data") is Dictionary else {}
	var what := str(event.get("type", ""))
	var name := str(event.get("name", ""))
	match what:
		"action":
			what = name
			var bits: PackedStringArray = []
			for key: String in data:
				if key in ["x", "y"]:
					continue
				bits.append("%s=%s" % [key, _short(data[key])])
			if not bits.is_empty():
				what += "  " + " ".join(bits)
		"death":
			what = "death: %s" % data.get("cause", "")
			if point_of(data) != null:
				what += " at (%d, %d)" % [int(point_of(data).x), int(point_of(data).y)]
		"setting_changed":
			what = "setting %s: %s -> %s" % [data.get("key", "?"), _short(data.get("old")), _short(data.get("new"))]
		"screen":
			what = "screen: %s" % (data.get("name", "") if str(data.get("name", "")) != "" else "gameplay")
		"progress", "snapshot":
			what = "%s  %s" % [what, _short(data)]
		"perf":
			what = "perf %s fps (1%% low %s), %s slow frames, %s" % [_short(data.get("fps_avg")),
					_short(data.get("fps_1pct_low")), _short(data.get("slow_frames")),
					data.get("screen", "") if str(data.get("screen", "")) != "" else str(data.get("scene", "")).get_file()]
		"load":
			if name == "scene":
				what = "load %s (%s ms)" % [str(data.get("scene", "")).get_file(), _short(data.get("ms"))]
			else:
				what = "load %s  %s" % [name, _short(data)]
		"error":
			what = "error: %s (%s:%s)" % [str(data.get("message", "")).left(80), str(data.get("file", "")).get_file(),
					_short(data.get("line"))]
		_:
			what = ("%s %s  %s" % [what, name, _short(data)]).strip_edges()
	return "%s  %s" % [clock(float(event.get("t", 0.0)), true), what]


## 83.4 -> "1:23" (or "1:23.4").
static func clock(seconds: float, tenths := false) -> String:
	var whole := floori(seconds)
	var text := "%d:%02d" % [whole / 60, whole % 60]
	if tenths:
		text += ".%d" % (floori(seconds * 10.0) % 10)
	return text


static func _short(value: Variant) -> String:
	if value is float:
		return str(snappedf(value, 0.01)).trim_suffix(".0")
	var text := JSON.stringify(tidy(value), "", false) if value is Dictionary or value is Array else str(value)
	return text.left(80) + ("…" if text.length() > 80 else "")
#endregion


## Whole numbers as whole numbers again (JSON reads every number back as a
## float: 3.0), which is shorter and reads as the game sent it.
static func tidy(value: Variant) -> Variant:
	if value is float and is_finite(value) and value == floorf(value) and absf(value) < 1e15:
		return int(value)
	if value is Dictionary:
		var out := {}
		for key: Variant in value:
			out[key] = tidy(value[key])
		return out
	if value is Array:
		return value.map(tidy)
	return value


## The index of the last entry of `list` (each with a "t") at or before `t`.
static func _last_at(list: Array, t: float) -> int:
	var lo := 0
	var hi := list.size() - 1
	var found := -1
	while lo <= hi:
		var mid := (lo + hi) / 2
		if float(list[mid].t) <= t:
			found = mid
			lo = mid + 1
		else:
			hi = mid - 1
	return found
