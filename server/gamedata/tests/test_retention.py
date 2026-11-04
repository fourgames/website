"""The retention: nothing is deleted; GAMEDATA_LINK_MONTHS after a player's last session their data
is unlinked (anonymised, grouped under one random pid). And the store's own guarantees."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

from gamedata import retention
from gamedata.store import Store, write_gzip_json

DAY = 86400
PID = "a" * 32
OTHER = "b" * 32
TABLES = ("sessions", "hardware", "settings", "batches", "crashes")


def fill(store: Store, pid: str, at: float, seq: int = 0, app_id: int = 5207970) -> str:
    """A session at `at` with hardware, settings, one stored batch and a crash report."""
    sid = store.start_session(pid, app_id, {"consent_hardware": True, "country": "SE", "region": "Stockholm"},
                              {"os": "Linux"}, {"v": 1}, now=at)
    session = store.session(sid)
    path = store.batch_path(session, seq)
    size = write_gzip_json(store.root / path, {"events": [{"t": 1, "type": "rng"}]})
    assert store.add_batch(session, seq, 1, 1.0, size, path, now=at)
    crash_path = f"crashes/{app_id}/2026-01/{sid}.json.gz"
    write_gzip_json(store.root / crash_path, {"log_tail": "x"})
    assert store.add_crash(sid, session, None, {"signal": "SIGSEGV"}, 0, 10, crash_path, now=at)
    return sid


def counts(store: Store) -> dict[str, int]:
    return {t: store.db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLES}


def pids(store: Store, table: str) -> set[str]:
    return {r[0] for r in store.db.execute(f"SELECT pid FROM {table}")}


def test_months_before():
    at = datetime(2026, 11, 4, 21, 6, tzinfo=timezone.utc).timestamp()
    assert datetime.fromtimestamp(retention.months_before(at, 24), timezone.utc) == \
        datetime(2024, 11, 4, 21, 6, tzinfo=timezone.utc)
    end = datetime(2026, 3, 31, tzinfo=timezone.utc).timestamp()
    assert datetime.fromtimestamp(retention.months_before(end, 1), timezone.utc).date().isoformat() == "2026-02-28"
    jan = datetime(2026, 1, 15, tzinfo=timezone.utc).timestamp()
    assert datetime.fromtimestamp(retention.months_before(jan, 13), timezone.utc).date().isoformat() == "2024-12-15"


def test_unlinks_after_the_link_months_and_deletes_nothing(tmp_path):
    store = Store(tmp_path)
    now = time.time()
    # Two sessions 25 and 26 months ago: the whole player is unlinked.
    fill(store, PID, now - 26 * 31 * DAY, 0)
    fill(store, PID, now - 25 * 31 * DAY, 0)
    # One player still playing: their old session stays linked because the last one is recent.
    fill(store, OTHER, now - 30 * 31 * DAY, 0)
    fill(store, OTHER, now - 3 * DAY, 0)
    store.set_opted_out(OTHER, True, now=now - 2 * DAY)
    before = counts(store)
    files = sorted(p for p in (tmp_path / "raw").rglob("*.json.gz")) + sorted((tmp_path / "crashes").rglob("*.gz"))

    assert retention.run(tmp_path, 24, now=now) == 1
    assert counts(store) == before
    assert sorted(p for p in (tmp_path / "raw").rglob("*.json.gz")) + \
        sorted((tmp_path / "crashes").rglob("*.gz")) == files
    for table in TABLES:
        assert PID not in pids(store, table)
    # One new pid for all of the player's rows, so their sessions stay grouped.
    new = pids(store, "sessions") - {OTHER}
    assert len(new) == 1
    for table in TABLES:
        assert pids(store, table) == new | {OTHER}
    # The player's own row keeps their choice, not the times that would point at the data.
    row = store.player(PID)
    assert (row["opted_out"], row["created"], row["updated"]) == (0, 0, 0)
    assert store.summary(PID) == {"opted_out": False, "games": []}

    # The anonymised pid isn't picked up again, ever.
    assert retention.run(tmp_path, 24, now=now + 3650 * DAY) == 1  # OTHER, ten years on
    assert pids(store, "sessions") >= new
    assert store.opted_out(OTHER)  # an unlinked player's opt-out stays

    # Coming back later: a fresh start under their own pid, not refused.
    assert store.start_session(PID, 5207970, {}, None, None) is not None
    store.close()


def test_batches_are_idempotent(tmp_path):
    store = Store(tmp_path)
    sid = store.start_session(PID, 1, {}, None, None)
    session = store.session(sid)
    assert store.add_batch(session, 0, 3, 2.0, 10, "raw/x", now=1, progress=(2.0, {"day": 3}))
    assert not store.add_batch(session, 0, 3, 2.0, 10, "raw/x", now=2, progress=(9.0, {"day": 9}))
    # An earlier batch arriving late doesn't replace the latest progress.
    assert store.add_batch(session, 1, 1, 1.0, 10, "raw/y", now=3, progress=(1.0, {"day": 1}))
    row = store.db.execute("SELECT batches, events, last_t, last_progress FROM sessions").fetchone()
    assert tuple(row) == (2, 4, 2.0, '{"day": 3}')
    store.close()


def test_opt_out_is_checked_when_the_session_is_made(tmp_path):
    store = Store(tmp_path)
    store.set_opted_out(PID, True)
    assert store.start_session(PID, 1, {}, None, None) is None
    store.set_opted_out(PID, False)
    assert store.start_session(PID, 1, {}, None, None) is not None
    store.close()


def test_anonymise_on_request_rewrites_every_pid_column(tmp_path):
    store = Store(tmp_path)
    now = time.time()
    fill(store, PID, now - DAY, 0)
    fill(store, PID, now - 2 * DAY, 1)
    new, changed = store.anonymise(PID, now=now)
    assert changed == {"sessions": 2, "hardware": 2, "settings": 2, "batches": 2, "crashes": 2}
    for table in TABLES:
        assert pids(store, table) == {new}
    row = store.player(PID)
    assert (row["opted_out"], row["created"], row["updated"]) == (1, int(now), int(now))
    assert not store.opted_out(new)
    assert store.summary(PID) == {"opted_out": True, "games": []}
    # Already anonymised: the automatic unlinking leaves it alone.
    assert store.stale_pids(now + 100 * 365 * DAY) == []
    store.close()


def test_the_service_runs_it_hourly(tmp_path):
    from aiohttp.test_utils import TestServer

    from gamedata.web import make_app, retention_loop

    from .harness import config

    async def go():
        cfg = config(tmp_path)
        store = Store(cfg.data_dir)
        fill(store, PID, time.time() - 800 * DAY)
        app = make_app(cfg)  # with the hourly task: it must start and stop with the app
        server = TestServer(app)
        await server.start_server()
        task = asyncio.create_task(retention_loop(app, first_delay=0, every=3600))
        for _ in range(100):
            await asyncio.sleep(0.02)
            if PID not in pids(store, "sessions"):
                break
        task.cancel()
        await server.close()
        left = pids(store, "sessions")
        store.close()
        return left

    left = asyncio.run(go())
    assert len(left) == 1 and PID not in left
