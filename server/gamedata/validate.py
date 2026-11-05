"""Shape checks for what the games send. Nothing from a client is trusted: every field is checked
for its type and size, and only the fields we know are kept.

The identifying parts (app id, session, seq, event types) are strict and refuse the request (400).
The descriptive parts (hardware, settings, crash details) are cleaned instead: a field of the wrong
type is dropped and long text is cut, so one odd value never costs a session.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from dataclasses import dataclass
from typing import Any

from .limits import Refused

EVENT_TYPES = frozenset({"action", "snapshot", "progress", "rng", "error", "custom",
                         "perf", "load", "input", "idle", "setting_changed", "screen", "marker",
                         "position", "death", "overlay", "achievement", "steam", "ui"})
MAX_EVENTS = 2000
MAX_CRASH_EVENTS = 500
MAX_SEQ = 100_000
# Seconds since session start: about four months of play is the most one session can have.
MAX_T = 1e7
MAX_NAME = 64
MAX_LOG_TAIL = 64 * 1024
MAX_SUMMARY = 16 * 1024
# One event's data, as JSON. A bigger event is dropped (and counted), the rest of the batch kept.
MAX_EVENT_DATA = 32 * 1024
MAX_DLC = 200
BOOT_KINDS = frozenset({"first_install", "first_after_update", "normal"})
MAX_PREVIOUS_CRASH = 4 * 1024
MAX_SETTINGS = 200
MAX_SETTING_KEY = 64
MAX_SETTING_TEXT = 256
MAX_TEXT = 200
# Steam's Web API tickets are a few hundred bytes, sent as hex.
MAX_TICKET = 8192
HEX = re.compile(r"^[0-9a-fA-F]+$")

# hardware: field -> kind. "text" is cut at MAX_TEXT characters.
HARDWARE = {
    "os": "text", "cpu": "text", "cpu_cores": "int", "ram_mb": "int", "gpu": "text",
    "gpu_driver": "text", "renderer": "text", "screen": "size", "refresh_hz": "number",
    "steam_deck": "bool",
}


def bad(message: str, error: str = "bad_request") -> Refused:
    return Refused(400, error, message)


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def text(value: object, limit: int = MAX_TEXT) -> str | None:
    """A string cut to `limit` characters, or None for anything else."""
    if not isinstance(value, str):
        return None
    return value[:limit]


def session_id(value: object) -> str:
    if not isinstance(value, str) or len(value) != 36:
        raise bad("session_id must be the id session/start gave")
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        raise bad("session_id must be the id session/start gave") from None
    if str(parsed) != value.lower():
        raise bad("session_id must be the id session/start gave")
    return value.lower()


def json_size(value: object) -> int:
    return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode())


@dataclass(frozen=True)
class Start:
    app_id: int
    ticket: str
    gameplay: bool
    hardware_consent: bool
    game_version: str | None
    build_id: str | None
    godot_version: str | None
    platform: str | None
    locale: str | None
    hardware: dict[str, Any] | None
    settings: dict[str, Any] | None
    previous_crash: Any
    input: dict[str, str | None] | None
    dlc: list[dict[str, Any]] | None
    boot_kind: str | None


def start(body: dict[str, Any], app_ids: frozenset[int]) -> Start:
    app_id = body.get("app_id")
    if isinstance(app_id, str) and app_id.isdigit():
        app_id = int(app_id)
    if not isinstance(app_id, int) or isinstance(app_id, bool):
        raise bad("app_id must be the game's Steam app id")
    if app_id not in app_ids:
        raise bad("this game doesn't send data here", "unknown_app")
    ticket = body.get("ticket")
    if not isinstance(ticket, str) or not 2 <= len(ticket) <= MAX_TICKET or not HEX.match(ticket):
        raise bad("ticket must be the hex ticket from getAuthTicketForWebApi")
    consent = body.get("consent")
    if (not isinstance(consent, dict) or not isinstance(consent.get("gameplay"), bool)
            or not isinstance(consent.get("hardware"), bool)):
        raise bad('consent must be {"gameplay": true|false, "hardware": true|false}')
    previous = body.get("previous_crash")
    if previous is not None and (not isinstance(previous, (dict, str)) or json_size(previous) > MAX_PREVIOUS_CRASH):
        previous = None
    return Start(
        app_id=app_id,
        ticket=ticket,
        gameplay=consent["gameplay"],
        hardware_consent=consent["hardware"],
        game_version=text(body.get("game_version"), MAX_NAME),
        build_id=text(body.get("build_id"), MAX_NAME),
        godot_version=text(body.get("godot_version"), MAX_NAME),
        platform=text(body.get("platform"), 32),
        locale=text(body.get("locale"), 16),
        hardware=hardware(body.get("hardware")),
        settings=settings(body.get("settings")),
        previous_crash=previous,
        input=input_device(body.get("input")),
        dlc=dlc(body.get("dlc")),
        boot_kind=boot if isinstance(boot := body.get("boot_kind"), str) and boot in BOOT_KINDS else None,
    )


def input_device(value: object) -> dict[str, str | None] | None:
    """{type, controller}: what the player plays with (e.g. "gamepad", "Xbox Wireless Controller")."""
    if not isinstance(value, dict):
        return None
    out = {"type": text(value.get("type"), 32), "controller": text(value.get("controller"), 100)}
    return out if any(out.values()) else None


def dlc(value: object) -> list[dict[str, Any]] | None:
    """[{app_id, owned}], at most MAX_DLC; entries of the wrong shape are dropped."""
    if not isinstance(value, list):
        return None
    out = []
    for item in value[:MAX_DLC]:
        if not isinstance(item, dict):
            continue
        app_id, owned = item.get("app_id"), item.get("owned")
        if isinstance(app_id, int) and not isinstance(app_id, bool) and app_id > 0 and isinstance(owned, bool):
            out.append({"app_id": app_id, "owned": owned})
    return out


def hardware(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {}
    for name, kind in HARDWARE.items():
        item = value.get(name)
        if kind == "text":
            out[name] = text(item)
        elif kind == "int":
            out[name] = int(item) if is_number(item) and 0 <= item <= 1 << 40 else None
        elif kind == "number":
            out[name] = float(item) if is_number(item) and 0 <= item <= 10_000 else None
        elif kind == "bool":
            out[name] = item if isinstance(item, bool) else None
        elif kind == "size":
            ok = (isinstance(item, list) and len(item) == 2
                  and all(is_number(n) and 0 <= n <= 100_000 for n in item))
            out[name] = [int(item[0]), int(item[1])] if ok else None
    return out


def settings(value: object) -> dict[str, Any] | None:
    """Flat key -> scalar. Anything nested is dropped, long text cut, at most MAX_SETTINGS keys."""
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {}
    for key, item in value.items():
        if len(out) >= MAX_SETTINGS:
            break
        if not isinstance(key, str) or not key or len(key) > MAX_SETTING_KEY:
            continue
        if item is None or isinstance(item, bool) or is_number(item):
            out[key] = item
        elif isinstance(item, str):
            out[key] = item[:MAX_SETTING_TEXT]
    return out


def event(value: object) -> dict[str, Any]:
    """One event, cleaned to the fields we keep: t, type, name, data."""
    if not isinstance(value, dict):
        raise ValueError("an event must be an object")
    t = value.get("t")
    if not is_number(t) or not 0 <= t <= MAX_T:
        raise ValueError("t must be seconds since the session started")
    kind = value.get("type")
    if not isinstance(kind, str) or kind not in EVENT_TYPES:
        raise ValueError("type must be one of " + ", ".join(sorted(EVENT_TYPES)))
    out: dict[str, Any] = {"t": t, "type": kind}
    name = value.get("name")
    if name is not None:
        if not isinstance(name, str) or not 0 < len(name) <= MAX_NAME:
            raise ValueError(f"name must be text of at most {MAX_NAME} characters")
        out["name"] = name
    elif kind == "action":
        raise ValueError("an action needs a name")
    data = value.get("data")
    if data is not None:
        if not isinstance(data, dict):
            raise ValueError("data must be an object")
        out["data"] = data
    return out


@dataclass(frozen=True)
class Batch:
    session_id: str
    seq: int
    events: list[dict[str, Any]]
    # Events left out for being bigger than MAX_EVENT_DATA.
    dropped: int = 0


def small_enough(event: dict[str, Any]) -> bool:
    return "data" not in event or json_size(event["data"]) <= MAX_EVENT_DATA


def seq(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= MAX_SEQ:
        raise bad(f"seq must be a whole number from 0 to {MAX_SEQ}")
    return value


def batch(body: dict[str, Any]) -> Batch:
    sid = session_id(body.get("session_id"))
    number = seq(body.get("seq"))
    events = body.get("events")
    if not isinstance(events, list):
        raise bad("events must be a list")
    if len(events) > MAX_EVENTS:
        raise bad(f"at most {MAX_EVENTS} events per batch", "too_many_events")
    cleaned = []
    dropped = 0
    for index, item in enumerate(events):
        try:
            checked = event(item)
        except ValueError as error:
            raise bad(f"event {index}: {error}", "bad_event") from None
        if small_enough(checked):
            cleaned.append(checked)
        else:
            dropped += 1
    return Batch(sid, number, cleaned, dropped)


@dataclass(frozen=True)
class End:
    session_id: str
    seq: int | None
    playtime_s: float | None
    summary: dict[str, Any] | None
    # Cleaned, not refused: a wrong type is left out.
    active_s: float | None = None
    idle_s: float | None = None
    first_session: bool | None = None
    last_scene: str | None = None
    last_screen: str | None = None


def seconds(value: object) -> float | None:
    return float(value) if is_number(value) and 0 <= value <= MAX_T else None


def end(body: dict[str, Any]) -> End:
    sid = session_id(body.get("session_id"))
    number = body.get("seq")
    number = seq(number) if number is not None else None
    playtime = body.get("playtime_s")
    if playtime is not None and (not is_number(playtime) or not 0 <= playtime <= MAX_T):
        raise bad("playtime_s must be seconds of play")
    summary = body.get("summary")
    if summary is not None:
        if not isinstance(summary, dict):
            raise bad("summary must be an object")
        if json_size(summary) > MAX_SUMMARY:
            raise Refused(413, "too_large", f"summary must be at most {MAX_SUMMARY // 1024} KB")
    return End(sid, number, float(playtime) if playtime is not None else None, summary,
               **end_fields(body, summary))


def end_fields(body: dict[str, Any], summary: dict[str, Any] | None) -> dict[str, Any]:
    """session/end's active_s, idle_s, first_session, last_scene and last_screen, cleaned: from the
    body, else from its summary (where the Godot plugin sends them), each checked the same way. A
    wrong type is left out (None)."""
    inner = summary if isinstance(summary, dict) else {}

    def pick(key: str, clean: Any) -> Any:
        value = clean(body.get(key))
        return value if value is not None else clean(inner.get(key))

    return {"active_s": pick("active_s", seconds), "idle_s": pick("idle_s", seconds),
            "first_session": pick("first_session", lambda v: v if isinstance(v, bool) else None),
            "last_scene": pick("last_scene", lambda v: text(v, 128)),
            "last_screen": pick("last_screen", lambda v: text(v, 128))}


@dataclass(frozen=True)
class Crash:
    crashed_session_id: str | None
    game_version: str | None
    log_tail: str | None
    last_events: list[dict[str, Any]]
    signal: str | None
    os: str | None


def crash(body: dict[str, Any]) -> Crash:
    crashed = body.get("crashed_session_id")
    if crashed in (None, ""):
        crashed = None
    else:
        try:
            crashed = session_id(crashed)
        except Refused:
            crashed = None
    log_tail = body.get("log_tail")
    if isinstance(log_tail, str):
        # The tail is what matters: cut from the front.
        encoded = log_tail.encode()
        if len(encoded) > MAX_LOG_TAIL:
            log_tail = encoded[-MAX_LOG_TAIL:].decode(errors="ignore")
    else:
        log_tail = None
    events = body.get("last_events")
    cleaned: list[dict[str, Any]] = []
    if isinstance(events, list):
        for item in events[-MAX_CRASH_EVENTS:]:
            try:
                checked = event(item)
            except ValueError:
                continue  # the ring can hold a half-written event; the rest still help
            if small_enough(checked):
                cleaned.append(checked)
    return Crash(
        crashed_session_id=crashed,
        game_version=text(body.get("game_version"), MAX_NAME),
        log_tail=log_tail,
        last_events=cleaned,
        signal=text(body.get("signal"), MAX_NAME),
        os=text(body.get("os")),
    )
