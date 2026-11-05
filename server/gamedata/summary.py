""""Copy for Claude": one session as plain text, the same text the fourgames_data replay viewer
builds (godot/fourgames_data/game/replay/summary.gd, with export_reader.gd's reading and
timeline.gd's scenes and deaths). A port, line for line: change summary.gd first, then here, and
the shared fixture (godot/fourgames_data/tests/fixtures/summary_*.json, tested on both sides) says
whether they still agree.

build(session) takes a session in the shape GET /v1/admin/sessions/<id> answers (export.session):
a sessions.json row with its events, hardware, settings, crashes and reported.

The text has to come out as Godot writes it, so the formatting below copies Godot 4's: a JSON
number is a float there (3 reads back as 3.0), str() of a float keeps 14 digits ("0.57", not
0.5700000000000001) and ends whole ones in ".0", JSON.stringify keeps 14 significant digits and
escapes only \\ " \\b \\f \\n \\r \\t \\v, "%.1f" rounds like printf, and a Vector2 is 32-bit.
"""

# The formats are summary.gd's own ("%d:%02d", "%.1f"), so they stay % formats.
# ruff: noqa: UP031

from __future__ import annotations

import math
import struct
from typing import Any

JSON_CAP = 15 * 1024
JSON_MARK = "== Key events (JSON) =="
# The events the JSON keeps first, and the ones it keeps when there is room.
KEY_TYPES = ["action", "death", "progress", "setting_changed", "error", "achievement", "custom", "rng"]
MORE_TYPES = ["snapshot", "screen", "load", "idle", "input", "steam", "overlay", "ui"]
LOG_LINES = 20

# The test project's levels (godot/fourgames_data/game/levels.gd): what the summary needs of them.
LEVEL_ORDER = ["level_1", "level_2"]
LEVEL_SCENES = {"res://game/level_1.tscn": "level_1", "res://game/level_2.tscn": "level_2"}
LEVELS = {"level_1": {"name": "First steps", "coins": 8}, "level_2": {"name": "Saw mill", "coins": 10}}

INF = math.inf


# Godot's ways of writing values


def _is_num(value: Any) -> bool:
    """A JSON number (Godot: float, or int for a whole one written without a point)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _fixed(x: float, decimals: int) -> str:
    """Godot's String::num: printf "%.<decimals>f", then the trailing zeros go, keeping one after
    the point."""
    decimals = min(decimals, 32)
    text = f"{x:.{decimals}f}"
    if "." in text:
        text = text.rstrip("0")
        if text.endswith("."):
            text += "0"
    return text


def float_str(x: float) -> str:
    """str() of a float."""
    if math.isnan(x):
        return "nan"
    if math.isinf(x):
        return "inf" if x > 0 else "-inf"
    if x == math.floor(x):
        return "0.0" if x == 0 else f"{x:.0f}.0"
    decimals = 14
    if abs(x) > 10:
        decimals -= math.floor(math.log10(abs(x)))
    if decimals < 0:
        decimals = 1  # (what Godot prints for the few fractions past 1e15)
    return _fixed(x, decimals)


def json_float(x: float) -> str:
    """A float in JSON.stringify: 14 significant digits."""
    if math.isnan(x):
        return "null"
    if math.isinf(x):
        return "1e99999" if x > 0 else "-1e99999"
    if x == 0:
        return "0.0"
    return _fixed(x, max(1, 14 - math.floor(math.log10(abs(x)))))


def _escape(text: str) -> str:
    """String::json_escape."""
    for raw, done in (("\\", "\\\\"), ("\b", "\\b"), ("\f", "\\f"), ("\n", "\\n"), ("\r", "\\r"),
                      ("\t", "\\t"), ("\v", "\\v"), ('"', '\\"')):
        text = text.replace(raw, done)
    return text


def gd_json(value: Any) -> str:
    """JSON.stringify(value, "", false): no spaces, keys in their order."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return json_float(value)
    if isinstance(value, str):
        return '"' + _escape(value) + '"'
    if isinstance(value, list):
        return "[" + ",".join(gd_json(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join('"' + _escape(str(k)) + '":' + gd_json(v) for k, v in value.items()) + "}"
    return '"' + _escape(str(value)) + '"'


def gd_str(value: Any, inside: bool = False) -> str:
    """str() of what JSON gave: every number a float, null "<null>", containers Godot's way."""
    if value is None:
        return "<null>"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if _is_num(value):
        return float_str(_float(value))
    if isinstance(value, str):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"' if inside else value
    if isinstance(value, list):
        return "[" + ", ".join(gd_str(v, True) for v in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{gd_str(k, True)}: {gd_str(v, True)}" for k, v in value.items()) + " }"
    return str(value)


def _float(value: Any) -> float:
    try:
        return float(value)
    except OverflowError:
        return INF if value > 0 else -INF


def _snapped(x: float, step: float) -> float:
    """snappedf."""
    q = x / step + 0.5
    if not math.isfinite(q):
        return q
    return math.floor(q) * step


def _int(value: Any) -> int:
    """int() of a Variant from JSON."""
    if isinstance(value, bool):
        return int(value)
    if _is_num(value):
        x = _float(value)
        return int(x) if math.isfinite(x) else 0
    if isinstance(value, str):
        digits = ""
        for ch in value.strip():
            if ch.isdigit() or (not digits and ch in "+-"):
                digits += ch
            else:
                break
        try:
            return int(digits)
        except ValueError:
            return 0
    return 0


def _f32(x: float) -> float:
    """What a Vector2 holds of a number: 32 bits."""
    try:
        return struct.unpack("f", struct.pack("f", x))[0]
    except OverflowError:
        return INF if x > 0 else -INF


def clock(seconds: float, tenths: bool = False) -> str:
    """Timeline.clock: 83.4 -> "1:23" (or "1:23.4")."""
    if not math.isfinite(seconds):
        seconds = 0.0
    whole = math.floor(seconds)
    text = "%d:%02d" % (_cdiv(whole, 60), whole - _cdiv(whole, 60) * 60)
    if tenths:
        tenth = math.floor(seconds * 10.0)
        text += ".%d" % (tenth - _cdiv(tenth, 10) * 10)
    return text


def _cdiv(a: int, b: int) -> int:
    """GDScript's / on ints: truncated, as in C."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def tidy(value: Any) -> Any:
    """Timeline.tidy: whole numbers as whole numbers (JSON read them back as floats)."""
    if _is_num(value):
        x = _float(value)
        if math.isfinite(x) and x == math.floor(x) and abs(x) < 1e15:
            return int(x)
        return x
    if isinstance(value, dict):
        return {k: tidy(v) for k, v in value.items()}
    if isinstance(value, list):
        return [tidy(v) for v in value]
    return value


def short(value: Any) -> str:
    """Timeline._short."""
    if _is_num(value):
        return float_str(_snapped(_float(value), 0.01)).removesuffix(".0")
    text = gd_json(tidy(value)) if isinstance(value, (dict, list)) else gd_str(value)
    return text[:80] + ("…" if len(text) > 80 else "")


def _num(value: Any) -> float:
    return _float(value) if _is_num(value) else 0.0


def _text(value: Any) -> str:
    if value is None:
        return "?"
    if _is_num(value):
        x = _float(value)
        if math.isfinite(x) and x == math.floor(x):
            return str(int(x))
    return gd_str(value)


def _first(value: Any, otherwise: Any) -> Any:
    return value if value is not None else otherwise


def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _strip_edges(text: str) -> str:
    """String.strip_edges: every character up to a space, both ends."""
    start, end = 0, len(text)
    while start < end and ord(text[start]) <= 32:
        start += 1
    while end > start and ord(text[end - 1]) <= 32:
        end -= 1
    return text[start:end]


def _get_file(path: str) -> str:
    sep = max(path.rfind("/"), path.rfind("\\"))
    return path if sep == -1 else path[sep + 1:]


def _get_basename(path: str) -> str:
    pos = path.rfind(".")
    if pos < 0 or pos < max(path.rfind("/"), path.rfind("\\")):
        return path
    return path[:pos]


# export_reader.gd: a session ready to summarise


def sort_events(events: list) -> list:
    """Events by t, those with the same t in the order they came; anything without a t left out."""
    keyed = [(_float(e["t"]), i, e) for i, e in enumerate(events)
             if isinstance(e, dict) and _is_num(e.get("t"))]
    keyed.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in keyed]


def duration_of(session: dict) -> float:
    events = session.get("events", [])
    last = _float(events[-1]["t"]) if events else 0.0
    played = session.get("playtime_s")
    if played is None and isinstance(session.get("summary"), dict):
        played = session["summary"].get("playtime_s")
    return max(last, _float(played) if _is_num(played) else 0.0)


def read(row: dict) -> dict:
    """What export_reader.gd's _from_rows makes of one session that carries its own events."""
    session = dict(row)
    session["session_id"] = gd_str(session.get("session_id", ""))
    session["app_id"] = _int(session.get("app_id", 0)) if session.get("app_id") is not None else 0
    session["test"] = session.get("test") is True
    events = session.get("events") if isinstance(session.get("events"), list) else []
    session["events"] = sort_events(events)
    for key in ("hardware", "settings", "reported"):
        session[key] = _dict(session.get(key))
    session["crashes"] = session.get("crashes", [])
    session["duration"] = duration_of(session)
    return session


# timeline.gd: the scenes and deaths


def point_of(data: dict) -> tuple[float, float] | None:
    x = data.get("x")
    y = data.get("z") if "z" in data else data.get("y")
    if _is_num(x) and _is_num(y):
        return _f32(_float(x)), _f32(_float(y))
    return None


class Timeline:
    def __init__(self, session: dict):
        self.events: list = session.get("events", [])
        self.duration = _float(session.get("duration", 0.0))
        self.deaths: list[dict] = []
        self._scenes: list[dict] = []
        scene = ""
        for event in self.events:
            t = _float(event.get("t", 0.0))
            kind = gd_str(event.get("type", ""))
            data = _dict(event.get("data"))
            self.duration = max(self.duration, t)
            said = data["scene"] if isinstance(data.get("scene"), str) else ""
            if said and said != scene and kind in ("position", "death", "load"):
                scene = said
                self._scenes.append({"t": t, "scene": scene})
            if kind == "death":
                self.deaths.append({"t": t, "scene": scene, "p": point_of(data),
                                    "cause": gd_str(data.get("cause", ""))})

    def scenes(self) -> list[str]:
        out: list[str] = []
        for entry in self._scenes:
            if entry["scene"] not in out:
                out.append(entry["scene"])
        return out


# summary.gd


def build(row: dict) -> str:
    session = read(row)
    line = Timeline(session)
    events = session["events"]
    ours = any(scene in LEVEL_SCENES for scene in line.scenes())
    out: list[str] = []
    if ours:
        out.append("Here is a play session from the fourgames_data test project (Four Games' player-data test game); "
                   "it was downloaded from fourgames.se/privacy and summarised by the project's replay viewer.")
    else:
        out.append("Here is a play session of Steam app %d, downloaded from fourgames.se/privacy and summarised "
                   % _int(session.get("app_id", 0)) + "by the fourgames_data replay viewer.")
    out.append("")
    out += _session_part(session, line)
    out += _levels_part(events) if ours else _scenes_part(line, events)
    out += _deaths_part(line)
    out += _settings_part(session, events)
    out += _perf_part(events)
    out += _hardware_part(session)
    out += _trouble_part(session, events)
    out.append(JSON_MARK)
    out.append(key_events_json(events))
    return "\n".join(out)


def _session_part(session: dict, line: Timeline) -> list[str]:
    out = ["== Session =="]
    out.append("id %s, app %d%s" % (gd_str(session.get("session_id", "?")), _int(session.get("app_id", 0)),
                                    ", a TEST session" if session.get("test") is True else ""))
    summary = _dict(session.get("summary"))
    length = "length %s" % clock(line.duration)
    active = _first(session.get("active_s"), summary.get("active_s"))
    if active is not None:
        length += " (active %s, idle %s)" % (clock(_num(active)),
                                             clock(_num(_first(session.get("idle_s"), summary.get("idle_s")))))
    out.append("started %s, %s" % (gd_str(session.get("started", "?")), length))
    country = session.get("country")
    out.append("game %s (build %s), Godot %s, %s, locale %s%s" % (
        _text(session.get("game_version")), _text(session.get("build_id")), _text(session.get("godot_version")),
        _text(session.get("platform")), _text(session.get("locale")),
        (", from " + country) if isinstance(country, str) else ""))
    if isinstance(session.get("ended"), str):
        out.append("ended cleanly at %s on %s" % (session["ended"],
                                                  _text(_first(session.get("last_scene"), summary.get("last_scene")))))
    else:
        out.append("no end received (the game crashed, was killed, or is still uploading)")
    if summary:
        out.append("end summary: %d events, %d actions, %d errors, session %s on this install (%s)" % (
            int(_num(summary.get("events"))), int(_num(summary.get("actions"))), int(_num(summary.get("errors"))),
            _text(summary.get("session_number")), _text(summary.get("boot_kind"))))
    out.append("")
    return out


def _levels_part(events: list) -> list[str]:
    out = ["== Levels =="]
    coins = 0
    deaths = 0
    scene_of = {level: scene for scene, level in LEVEL_SCENES.items()}
    for level_id in LEVEL_ORDER:
        scene = scene_of.get(level_id, "")
        entered = -1.0
        finished: dict = {}
        level_coins: set[int] = set()
        level_deaths = 0
        for event in events:
            data = _dict(event.get("data"))
            t = _float(event["t"])
            if entered < 0.0 and event.get("type") == "load" and data.get("scene") == scene:
                entered = t
            if gd_str(data.get("level", "")) != level_id:
                continue
            if entered < 0.0:
                entered = t
            if event.get("type") == "death":
                level_deaths += 1
            elif event.get("type") == "action" and event.get("name") == "coin":
                level_coins.add(_int(data.get("coin", -1)))
            elif event.get("type") == "action" and event.get("name") == "level_complete" and not finished:
                finished = {"t": t, "time_s": data.get("time_s")}
        if entered < 0.0:
            continue
        coins += len(level_coins)
        deaths += level_deaths
        done = ("completed at %s (%s s on the level)" % (clock(finished["t"]), _text(finished["time_s"]))
                if finished else "not completed")
        out.append('%s "%s": entered %s, %s, coins %d/%d, deaths %d' % (
            level_id, LEVELS[level_id]["name"], clock(entered), done, len(level_coins), LEVELS[level_id]["coins"],
            level_deaths))
    out.append("total: %d coins, %d deaths" % (coins, deaths))
    out.append("")
    return out


def _scenes_part(line: Timeline, events: list) -> list[str]:
    out = ["== Scenes =="]
    changes = []
    for event in events:
        if event.get("type") == "load" and event.get("name") == "scene" and isinstance(event.get("data"), dict):
            changes.append({"t": _float(event["t"]), "scene": gd_str(event["data"].get("scene", ""))})
    if not changes:
        out += line.scenes()
    for i, change in enumerate(changes):
        until = changes[i + 1]["t"] if i + 1 < len(changes) else line.duration
        out.append("%s %s for %s" % (clock(change["t"]), change["scene"], clock(until - change["t"])))
    actions = sum(1 for event in events if event.get("type") == "action")
    out.append("%d actions, %d deaths" % (actions, len(line.deaths)))
    out.append("")
    return out


def _deaths_part(line: Timeline) -> list[str]:
    out = ["== Deaths =="]
    for death in line.deaths:
        p = death["p"]
        where = "(%d, %d)" % (_int(p[0]), _int(p[1])) if p is not None else "(no position)"
        place = LEVEL_SCENES.get(death["scene"], "")
        out.append("%s %s, %s at %s" % (clock(death["t"]), place or death["scene"], death["cause"] or "no cause", where))
    if not line.deaths:
        out.append("none")
    out.append("")
    return out


def _settings_part(session: dict, events: list) -> list[str]:
    out = ["== Settings =="]
    start = session.get("settings", {})
    parts = ["%s=%s" % (key, short(start[key])) for key in sorted(start)]
    out.append("at start: " + (", ".join(parts) if parts else "(none sent)"))
    changed = False
    for event in events:
        if event.get("type") == "setting_changed" and isinstance(event.get("data"), dict):
            changed = True
            data = event["data"]
            out.append("%s %s: %s -> %s" % (clock(_float(event["t"])), gd_str(data.get("key", "?")),
                                            short(data.get("old")), short(data.get("new"))))
    if not changed:
        out.append("no changes")
    out.append("")
    return out


def _perf_part(events: list) -> list[str]:
    out = ["== Performance (per scene and screen) =="]
    by: dict[str, dict] = {}
    order: list[str] = []
    last_key: dict[str, str] = {}
    for event in events:
        if event.get("type") == "load" and event.get("name") == "boot" and isinstance(event.get("data"), dict):
            data = event["data"]
            out.append("boot: %s ms to the first frame, %s ms to playable (%s)" % (
                _text(data.get("boot_ms")), _text(data.get("to_play_ms")), _text(data.get("boot_kind"))))
        if event.get("type") != "perf" or not isinstance(event.get("data"), dict):
            continue
        data = event["data"]
        frames = int(_num(data.get("frames")))
        if frames <= 0 or not _is_num(data.get("fps_avg")):
            continue
        scene = _get_basename(_get_file(gd_str(data.get("scene", ""))))
        screen = gd_str(data.get("screen", ""))
        key = scene if scene else "(no scene)"
        if data.get("why") == "scene_change":
            key = last_key.get(scene, key)
        elif screen:
            key += ", %s screen" % screen
        last_key[scene] = key
        if key not in by:
            by[key] = {"frames": 0, "time_ms": 0.0, "low": INF, "worst": 0.0, "slow": 0}
            order.append(key)
        entry = by[key]
        entry["frames"] += frames
        entry["time_ms"] += frames * 1000.0 / max(_float(data["fps_avg"]), 0.001)
        if _is_num(data.get("fps_1pct_low")):
            entry["low"] = min(entry["low"], _float(data["fps_1pct_low"]))
        entry["worst"] = max(entry["worst"], _num(data.get("frame_ms_max")))
        entry["slow"] += int(_num(data.get("slow_frames")))
    for key in order:
        entry = by[key]
        out.append("%s: %.1f fps avg, min (1%% low) %s, worst frame %.1f ms, %d stutters (frames over 50 ms), %d frames" % (
            key, entry["frames"] * 1000.0 / max(entry["time_ms"], 0.001),
            ("%.1f" % entry["low"]) if entry["low"] != INF else "?", entry["worst"], entry["slow"], entry["frames"]))
    if not order:
        out.append("no perf events")
    out.append("")
    return out


def _hardware_part(session: dict) -> list[str]:
    hw = session.get("hardware", {})
    if not hw:
        return ["== Hardware ==", "not sent (no hardware consent, or none in the download)", ""]
    screen = ""
    if hw.get("screen_w") is not None:
        screen = "%dx%d" % (int(_num(hw["screen_w"])), int(_num(hw.get("screen_h"))))
    elif isinstance(hw.get("screen"), list) and len(hw["screen"]) == 2:
        screen = "%dx%d" % (int(_num(hw["screen"][0])), int(_num(hw["screen"][1])))
    gpu = hw["gpu"] if isinstance(hw.get("gpu"), str) and hw["gpu"] else "GPU unknown"
    if isinstance(hw.get("gpu_driver"), str) and hw["gpu_driver"]:
        gpu += ", driver " + hw["gpu_driver"]
    parts = [_text(hw.get("os")), "%s (%s cores)" % (_text(hw.get("cpu")), _text(hw.get("cpu_cores"))),
             "%.0f GB RAM" % (_num(hw.get("ram_mb")) / 1024.0), gpu, _text(hw.get("renderer"))]
    if screen and screen != "0x0":
        parts.append("%s @ %s Hz" % (screen, _text(hw.get("refresh_hz"))))
    if hw.get("steam_deck") is True:
        parts.append("Steam Deck")
    return ["== Hardware ==", " | ".join(parts), ""]


def _trouble_part(session: dict, events: list) -> list[str]:
    out = ["== Errors and crashes =="]
    for event in events:
        if event.get("type") == "error" and isinstance(event.get("data"), dict):
            data = event["data"]
            out.append("%s %s: %s (%s:%s in %s)" % (
                clock(_float(event["t"])), gd_str(event.get("name", "error")), gd_str(data.get("message", ""))[:300],
                _text(data.get("file")), _text(data.get("line")), _text(data.get("function"))))
    crashes = session.get("crashes", [])
    for crash in crashes if isinstance(crashes, list) else []:
        if not isinstance(crash, dict):
            continue
        out.append("this session crashed: %s, reported %s by session %s" % (
            _text(crash.get("signal")), _text(crash.get("received")), _text(crash.get("session_id"))))
        tail = crash["log_tail"] if isinstance(crash.get("log_tail"), str) else ""
        if tail:
            lines = _strip_edges(tail).split("\n")
            out.append("log tail (last %d lines):" % min(len(lines), LOG_LINES))
            for text in lines[max(len(lines) - LOG_LINES, 0):]:
                out.append("  " + text[:300])
    reported = session.get("reported", {})
    if reported:
        out.append("this launch reported a crash of session %s (%s)" % (
            _text(reported.get("crashed_session_id")), _text(reported.get("signal"))))
    if len(out) == 1:
        out.append("none")
    out.append("")
    return out


def key_events_json(events: list) -> str:
    """The key events as one JSON array, at most about JSON_CAP bytes: the game's own events first;
    then, if they all fit, the plugin's screens, loads, idles and snapshots too."""
    text, left_out = _fit(events, KEY_TYPES + MORE_TYPES)
    if left_out == 0:
        return text
    return _fit(events, KEY_TYPES)[0]


def _fit(events: list, types: list[str]) -> tuple[str, int]:
    parts: list[str] = []
    size = 2
    left_out = 0
    for event in events:
        if gd_str(event.get("type", "")) not in types:
            continue
        text = gd_json(tidy(event))
        length = len(text.encode("utf-8", "surrogatepass")) + 2
        if left_out > 0 or size + length > JSON_CAP - 40:
            left_out += 1
            continue
        parts.append(text)
        size += length
    if left_out > 0:
        parts.append(gd_json({"left_out": left_out}))
    return "[" + ",\n".join(parts) + "]", left_out
