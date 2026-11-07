"""Events & awards: which festivals, showcases, Steam fests and awards each game entered, and how it went.

The researched list of events (name, link, cost, deadline, what you get) is the dashboard's
(src/lib/feedback/events-list.js). This keeps only the owner's own part, in the creators database next
to the launch checklist:
- each game's status per event (planned, applied, in, nominated, won, rejected, skipped) and a note,
  for appid 0 too: the studio itself (studio awards);
- events the owner added by hand, so the list never has to wait for a code change.
"""

from __future__ import annotations

import re
import time
from typing import Any

from .db import Store

SCHEMA = """
CREATE TABLE IF NOT EXISTS event_entries (
    event      TEXT NOT NULL,            -- the event's key, from the dashboard's list or event_custom
    appid      INTEGER NOT NULL,         -- 0: the studio, not one game
    status     TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (event, appid)
);
CREATE TABLE IF NOT EXISTS event_custom (
    key        TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    url        TEXT NOT NULL DEFAULT '',
    cost       TEXT NOT NULL DEFAULT '',
    deadline   TEXT,                     -- YYYY-MM-DD or YYYY-MM
    happens    TEXT,                     -- YYYY-MM-DD or YYYY-MM
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
"""
STATUSES = ("planned", "applied", "in", "nominated", "won", "rejected", "skipped")
KINDS = ("steam", "festival", "showcase", "award")
KEY = re.compile(r"^[a-z0-9-]{1,60}$")
DATE = re.compile(r"^20\d\d-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$")
URL = re.compile(r"^https?://[^\s]{1,500}$")
LIMITS = {"name": 120, "cost": 40, "note": 500}


class EventsError(ValueError):
    """A request the events list can't take; the message says why."""


def prepare(store: Store) -> Store:
    store.db.executescript(SCHEMA)
    return store


def state(store: Store) -> dict[str, Any]:
    """{entries: {event: {appid: {status, note, at}}}, custom: [event, ...]}."""
    entries: dict[str, dict[str, Any]] = {}
    for event, appid, status, note, at in store.db.execute(
            "SELECT event, appid, status, note, updated_at FROM event_entries"):
        entries.setdefault(event, {})[str(appid)] = {"status": status, "note": note, "at": at}
    custom = [{"key": k, "name": n, "kind": kind, "url": u, "cost": c, "deadline": d, "when": w, "note": note,
               "custom": True}
              for k, n, kind, u, c, d, w, note in store.db.execute(
                  "SELECT key, name, kind, url, cost, deadline, happens, note FROM event_custom ORDER BY created_at")]
    return {"entries": entries, "custom": custom}


def _text(value: Any, field: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > LIMITS[field]:
        raise EventsError(f"{field} must be text, at most {LIMITS[field]} characters")
    return value.strip()


def _date(value: Any, field: str) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not DATE.match(value):
        raise EventsError(f"{field} must be YYYY-MM-DD, YYYY-MM or empty")
    return value


def update(store: Store, body: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    """{event, appid, status, note?}: a game's status ("" clears it);
    {add: {name, kind, url?, cost?, deadline?, when?, note?}}: a new event of the owner's;
    {remove: key}: one of the owner's events, with its entries."""
    now = int(now if now is not None else time.time())
    with store.db:
        if "add" in body:
            e = body["add"]
            if not isinstance(e, dict) or not set(e) <= {"name", "kind", "url", "cost", "deadline", "when", "note"}:
                raise EventsError("add takes {name, kind, url, cost, deadline, when, note}")
            name = _text(e.get("name"), "name")
            if not name:
                raise EventsError("the event needs a name")
            if e.get("kind") not in KINDS:
                raise EventsError(f"kind must be one of {', '.join(KINDS)}")
            url = e.get("url") or ""
            if url and (not isinstance(url, str) or not URL.match(url)):
                raise EventsError("url must start with http:// or https://")
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "event"
            key = f"my-{slug}-{now % 100000}"
            store.db.execute("""INSERT INTO event_custom (key, name, kind, url, cost, deadline, happens, note, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                             (key, name, e["kind"], url, _text(e.get("cost"), "cost"), _date(e.get("deadline"), "deadline"),
                              _date(e.get("when"), "when"), _text(e.get("note"), "note"), now))
        elif "remove" in body:
            key = body["remove"]
            if not isinstance(key, str) or not KEY.match(key) or not key.startswith("my-"):
                raise EventsError("remove takes the key of an event you added")
            store.db.execute("DELETE FROM event_custom WHERE key = ?", (key,))
            store.db.execute("DELETE FROM event_entries WHERE event = ?", (key,))
        elif "event" in body:
            event, appid, status = body.get("event"), body.get("appid"), body.get("status")
            if not isinstance(event, str) or not KEY.match(event):
                raise EventsError("event must be an event key")
            if type(appid) is not int or appid < 0:
                raise EventsError("appid must be a game's app id, or 0 for the studio")
            if status == "":
                store.db.execute("DELETE FROM event_entries WHERE event = ? AND appid = ?", (event, appid))
            elif status in STATUSES:
                note = _text(body.get("note"), "note") if "note" in body else None
                store.db.execute("""INSERT INTO event_entries (event, appid, status, note, updated_at)
                                    VALUES (?, ?, ?, COALESCE(?, ''), ?)
                                    ON CONFLICT(event, appid) DO UPDATE SET status = excluded.status,
                                    note = COALESCE(?, note), updated_at = excluded.updated_at""",
                                 (event, appid, status, note, now, note))
            else:
                raise EventsError(f"status must be one of {', '.join(STATUSES)}, or \"\" to clear")
        else:
            raise EventsError("send {event, appid, status}, {add: {...}} or {remove: key}")
    return state(store)
