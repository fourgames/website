"""Counting minutes per local day, outages, retention and history.json."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

import pytest

from uptime import check
from uptime.check import DEGRADED, DOWN, UP

MIN = 60


def utc(*args) -> float:
    return datetime(*args, tzinfo=timezone.utc).timestamp()


@pytest.fixture
def db(tmp_path):
    db = check.connect(str(tmp_path / "uptime.db"))
    yield db
    db.close()


def days(db, part="website"):
    return {day: (u, d, dn) for day, u, d, dn in
            db.execute("SELECT day, up, degraded, down FROM daily WHERE part = ? ORDER BY day", (part,))}


def outages(db, part="website"):
    return db.execute("SELECT state, started_at, ended_at FROM outages WHERE part = ? ORDER BY started_at",
                      (part,)).fetchall()


def run(db, start, states, part="website"):
    """One run a minute from `start`, with these states for `part` (None: not counted)."""
    for n, state in enumerate(states):
        check.record(db, {} if state is None else {part: state}, start + n * MIN)


def test_wal(db):
    assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


# --- days in Europe/Stockholm ---

def test_midnight_in_summer_is_22_utc(db):
    run(db, utc(2026, 7, 1, 21, 58, 30), [UP, DOWN, UP])  # 23:58:30, 23:59:30, 00:00:30 local
    assert days(db) == {"2026-07-01": (1, 0, 1), "2026-07-02": (1, 0, 0)}


def test_midnight_in_winter_is_23_utc(db):
    run(db, utc(2026, 12, 31, 22, 59, 0), [DEGRADED, UP])
    assert days(db) == {"2026-12-31": (0, 1, 0), "2027-01-01": (1, 0, 0)}


def test_the_day_clocks_go_back_has_25_hours(db):
    # 2026-10-25: 03:00 CEST is 02:00 CET. Local midnight to midnight is 22:00 to 23:00 UTC.
    start = utc(2026, 10, 24, 22, 0, 5)
    run(db, start - MIN, [UP] * (25 * 60 + 2))
    assert days(db) == {"2026-10-24": (1, 0, 0), "2026-10-25": (1500, 0, 0), "2026-10-26": (1, 0, 0)}


def test_the_day_clocks_go_forward_has_23_hours(db):
    # 2026-03-29: 02:00 CET is 03:00 CEST. Local midnight to midnight is 23:00 to 22:00 UTC.
    start = utc(2026, 3, 28, 23, 0, 5)
    run(db, start, [UP] * (23 * 60))
    assert days(db) == {"2026-03-29": (1380, 0, 0)}


def test_a_second_run_in_the_same_minute_is_not_counted_twice(db):
    at = utc(2026, 11, 5, 10, 0, 1)
    check.record(db, {"website": DOWN}, at)
    check.record(db, {"website": DOWN}, at + 30)
    check.record(db, {"website": UP}, at + 60)
    assert days(db) == {"2026-11-05": (1, 0, 1)}


def test_parts_are_counted_separately(db):
    at = utc(2026, 11, 5, 10, 0, 1)
    check.record(db, {"website": UP, "keybot": DOWN, "alerts": DEGRADED}, at)
    assert days(db, "website") == {"2026-11-05": (1, 0, 0)}
    assert days(db, "keybot") == {"2026-11-05": (0, 0, 1)}
    assert days(db, "alerts") == {"2026-11-05": (0, 1, 0)}
    assert days(db, "broadcast") == {}


# --- outages ---

T = utc(2026, 11, 5, 10, 0, 0)


def test_consecutive_minutes_not_up_are_one_outage_with_the_worst_state(db):
    run(db, T, [UP, DEGRADED, DOWN, DEGRADED, UP, UP])
    assert outages(db) == [(DOWN, T + MIN, T + 4 * MIN)]


def test_degraded_only(db):
    run(db, T, [DEGRADED, DEGRADED, UP])
    assert outages(db) == [(DEGRADED, T, T + 2 * MIN)]


def test_an_outage_still_going_has_no_end(db):
    run(db, T, [UP, DOWN, DOWN])
    assert outages(db) == [(DOWN, T + MIN, None)]


def test_separate_outages(db):
    run(db, T, [DOWN, UP, DOWN, UP])
    assert outages(db) == [(DOWN, T, T + MIN), (DOWN, T + 2 * MIN, T + 3 * MIN)]


def test_a_pause_in_the_checks_ends_the_outage_at_the_last_check(db):
    run(db, T, [DOWN, DOWN])
    run(db, T + 12 * MIN, [DOWN, UP])  # the server was off for 10 minutes
    assert outages(db) == [(DOWN, T, T + 2 * MIN), (DOWN, T + 12 * MIN, T + 13 * MIN)]


def test_a_short_pause_keeps_the_outage(db):
    run(db, T, [DOWN])
    run(db, T + 3 * MIN, [DOWN, UP])  # one run missed
    assert outages(db) == [(DOWN, T, T + 4 * MIN)]


def test_a_part_no_longer_counted_has_its_outage_ended(db):
    # Broadcasts: not sending, then the stream is removed (no streams: not counted any more).
    run(db, T, [DOWN, DOWN, None, None, None, None], part="broadcast")
    assert outages(db, "broadcast") == [(DOWN, T, T + 2 * MIN)]
    assert days(db, "broadcast") == {"2026-11-05": (0, 0, 2)}


# --- retention ---

def test_keeps_100_days(db):
    now = utc(2026, 11, 5, 12, 0, 0)
    today = date(2026, 11, 5)
    for back in (0, 99, 100, 101, 150):
        db.execute("INSERT INTO daily (part, day, up) VALUES ('website', ?, 5)",
                   ((today - timedelta(days=back)).isoformat(),))
    old_end = check.day_starts_at(today - timedelta(days=100)) - 1
    db.execute("INSERT INTO outages (part, state, started_at, ended_at) VALUES ('website', 'down', ?, ?)",
               (old_end - 600, old_end))
    db.execute("INSERT INTO outages (part, state, started_at, ended_at) VALUES ('website', 'down', ?, ?)",
               (old_end + 1, old_end + 600))
    db.execute("INSERT INTO outages (part, state, started_at, ended_at) VALUES ('keybot', 'down', ?, NULL)",
               (old_end - 600,))
    check.record(db, {}, now)
    assert sorted(days(db)) == [(today - timedelta(days=b)).isoformat() for b in (100, 99, 0)]
    assert len(outages(db)) == 1 and outages(db)[0][1] == old_end + 1
    assert len(outages(db, "keybot")) == 1  # still going: kept


# --- history.json ---

NOW = utc(2026, 11, 5, 12, 0, 30)  # 13:00 in Stockholm


def test_shape_with_no_data(db):
    h = check.history(db, NOW)
    assert h["generatedAt"] == int(NOW)
    assert h["timezone"] == "Europe/Stockholm"
    assert len(h["days"]) == 90
    assert h["days"][0] == "2026-08-08" and h["days"][-1] == "2026-11-05"
    assert h["days"] == sorted(h["days"])
    assert list(h["parts"]) == list(check.PARTS)
    for part in h["parts"].values():
        assert part == {"uptime": None, "daily": [None] * 90, "outages": []}


def test_today_is_the_local_day(db):
    h = check.history(db, utc(2026, 11, 5, 23, 30, 0))  # 00:30 on the 6th in Stockholm
    assert h["days"][-1] == "2026-11-06"


def test_daily_counts_land_on_their_day(db):
    run(db, NOW - 2 * 86400, [UP, UP])
    run(db, NOW, [UP, DOWN, DEGRADED])
    h = check.history(db, NOW + 10 * MIN)
    daily = h["parts"]["website"]["daily"]
    assert daily[-1] == [1, 1, 1]
    assert daily[-2] is None
    assert daily[-3] == [2, 0, 0]
    assert h["parts"]["keybot"]["daily"] == [None] * 90
    assert h["parts"]["website"]["outages"] == [{"state": DOWN, "start": int(NOW) // 60 * 60 + MIN,
                                                 "end": None}]  # still degraded


def test_days_before_the_window_are_left_out(db):
    db.execute("INSERT INTO daily (part, day, down) VALUES ('website', '2026-08-07', 500)")
    db.execute("INSERT INTO daily (part, day, up) VALUES ('website', '2026-08-08', 10)")
    part = check.history(db, NOW)["parts"]["website"]
    assert part["daily"][0] == [10, 0, 0]
    assert part["uptime"] == 100


@pytest.mark.parametrize("daily,expected", [
    ([[1440, 0, 0]], 100),
    ([[1439, 0, 1]], 99.93),            # 99.930…
    ([[1000, 440, 0]], 100),           # degraded counts as up
    ([[99_999, 0, 1]], 99.99),         # rounded down: some time down never shows as 100
    ([[0, 0, 1440]], 0),
    ([[1440, 0, 0], None, [0, 0, 1440]], 50),
    ([None, None], None),
    ([], None),
])
def test_uptime_percent(daily, expected):
    assert check.uptime_percent(daily) == expected


def test_outages_are_the_50_newest_of_the_last_90_days(db):
    start = utc(2026, 11, 1, 0, 0, 0)
    for n in range(60):
        db.execute("INSERT INTO outages (part, state, started_at, ended_at) VALUES ('keybot', 'down', ?, ?)",
                   (start + n * 600, start + n * 600 + 120))
    db.execute("INSERT INTO outages (part, state, started_at, ended_at) VALUES ('keybot', 'degraded', ?, ?)",
               (utc(2026, 8, 1), utc(2026, 8, 2)))  # ended before the 90 days
    db.execute("INSERT INTO outages (part, state, started_at, ended_at) VALUES ('keybot', 'degraded', ?, NULL)",
               (utc(2026, 11, 5, 11),))
    shown = check.history(db, NOW)["parts"]["keybot"]["outages"]
    assert len(shown) == 50
    assert shown[0] == {"state": "degraded", "start": int(utc(2026, 11, 5, 11)), "end": None}
    assert [o["start"] for o in shown] == sorted((o["start"] for o in shown), reverse=True)
    assert shown[-1]["start"] == start + 11 * 600


def test_write_json_is_whole_and_small(db, tmp_path):
    for part in check.PARTS:
        for n in range(90):
            db.execute("INSERT INTO daily (part, day, up, degraded, down) VALUES (?, ?, 1430, 5, 5)",
                       (part, (date(2026, 11, 5) - timedelta(days=n)).isoformat()))
    path = tmp_path / "history.json"
    path.write_text("old")
    check.write_json(str(path), check.history(db, NOW))
    assert not (tmp_path / "history.json.tmp").exists()
    data = json.loads(path.read_text())
    assert data["parts"]["links"]["daily"][-1] == [1430, 5, 5]
    assert data["parts"]["links"]["uptime"] == 99.65
    assert path.stat().st_size < 20_000


def test_main_checks_records_and_writes(tmp_path, monkeypatch):
    status = tmp_path / "status"
    status.mkdir()
    monkeypatch.setattr(check, "DB_PATH", str(tmp_path / "uptime.db"))
    monkeypatch.setattr(check, "STATUS_DIR", str(status))

    class Fake:
        def checks(self):
            return {"website": lambda: UP, "keybot": lambda: DOWN, "broadcast": lambda: None}
    monkeypatch.setattr(check, "Checker", Fake)
    assert check.main() == 0
    data = json.loads((status / "history.json").read_text())
    assert data["parts"]["website"]["daily"][-1] == [1, 0, 0]
    assert data["parts"]["keybot"]["daily"][-1] == [0, 0, 1]
    assert data["parts"]["keybot"]["uptime"] == 0
    assert data["parts"]["broadcast"]["uptime"] is None
    assert not (status / "history.json.tmp").exists()
