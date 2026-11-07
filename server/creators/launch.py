"""The launch checklist: per game, its launch date and which steps of the launch plan are done.

The steps themselves (what to do, when, with which tool) are the dashboard's (src/lib/feedback/
launch.js); this keeps only the owner's ticks and dates, by step key, in the creators database next
to the outreach campaigns, so the dashboard can also tick "creators emailed" from a campaign.
"""

from __future__ import annotations

import re
import time
from typing import Any

from .db import Store

SCHEMA = """
CREATE TABLE IF NOT EXISTS launch_games (
    appid       INTEGER PRIMARY KEY,
    launch_date TEXT,                   -- YYYY-MM-DD, the planned (or real) release day; NULL: not set
    updated_at  INTEGER
);
CREATE TABLE IF NOT EXISTS launch_checks (
    appid   INTEGER NOT NULL,
    item    TEXT NOT NULL,              -- the dashboard's step key, e.g. "press-release"
    done_at INTEGER NOT NULL,
    PRIMARY KEY (appid, item)
);
"""
ITEM = re.compile(r"^[a-z0-9-]{1,40}$")
DATE = re.compile(r"^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")


class LaunchError(ValueError):
    """A request the checklist can't take; the message says why."""


def prepare(store: Store) -> Store:
    store.db.executescript(SCHEMA)
    return store


def state(store: Store) -> dict[str, Any]:
    """{games: {appid: {date, done: {item: done_at}}}} for every game with a date or a tick."""
    games: dict[str, dict[str, Any]] = {}
    for appid, date in store.db.execute("SELECT appid, launch_date FROM launch_games"):
        games.setdefault(str(appid), {"date": None, "done": {}})["date"] = date
    for appid, item, done_at in store.db.execute("SELECT appid, item, done_at FROM launch_checks"):
        games.setdefault(str(appid), {"date": None, "done": {}})["done"][item] = done_at
    return {"games": games}


def update(store: Store, body: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    """{appid, date} sets (or with date null clears) the launch day; {appid, item, done} ticks a step."""
    now = int(now if now is not None else time.time())
    appid = body.get("appid")
    if type(appid) is not int or appid <= 0:
        raise LaunchError("send {appid, date} or {appid, item, done}")
    with store.db:
        if "date" in body:
            date = body["date"]
            if date is not None and (not isinstance(date, str) or not DATE.match(date)):
                raise LaunchError("date must be YYYY-MM-DD or null")
            store.db.execute("""INSERT INTO launch_games (appid, launch_date, updated_at) VALUES (?, ?, ?)
                                ON CONFLICT(appid) DO UPDATE SET launch_date = excluded.launch_date,
                                updated_at = excluded.updated_at""", (appid, date, now))
        elif "item" in body:
            item, done = body.get("item"), body.get("done")
            if not isinstance(item, str) or not ITEM.match(item) or type(done) is not bool:
                raise LaunchError("send {appid, item, done: true|false}")
            if done:
                store.db.execute("INSERT OR IGNORE INTO launch_checks (appid, item, done_at) VALUES (?, ?, ?)",
                                 (appid, item, now))
            else:
                store.db.execute("DELETE FROM launch_checks WHERE appid = ? AND item = ?", (appid, item))
        else:
            raise LaunchError("send {appid, date} or {appid, item, done}")
    return state(store)
