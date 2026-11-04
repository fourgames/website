"""The retention: nothing is ever deleted automatically. Instead, GAMEDATA_LINK_MONTHS (24) after a
player's last session, their data is unlinked from them: anonymised the same way as when they ask
on the privacy page (one fresh random pid for all of their rows, so their sessions stay grouped),
except that their opt-out choice is left as it was. If they play again later, they start afresh
under their own pid; the old data stays with the random one.

Runs every hour in a worker thread with its own database connection, one player per transaction,
so it never holds the database for long.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from pathlib import Path

from .store import Store

log = logging.getLogger("gamedata.retention")

CHUNK = 100


def months_before(now: float, months: int) -> float:
    """The same moment `months` calendar months earlier (the day clamped to the month's length)."""
    moment = datetime.fromtimestamp(now, timezone.utc)
    index = moment.year * 12 + moment.month - 1 - months
    year, month = divmod(index, 12)
    month += 1
    for day in range(moment.day, 27, -1):
        try:
            return moment.replace(year=year, month=month, day=day).timestamp()
        except ValueError:
            continue
    return moment.replace(year=year, month=month, day=min(moment.day, 28)).timestamp()


def run(data_dir: str | Path, link_months: int, now: float | None = None) -> int:
    """One pass. How many players it unlinked."""
    now = time.time() if now is None else now
    cutoff = months_before(now, link_months)
    store = Store(data_dir)
    unlinked = 0
    try:
        while pids := store.stale_pids(cutoff, CHUNK):
            for pid in pids:
                store.anonymise(pid, now, opt_out=False)
                unlinked += 1
    finally:
        store.close()
    return unlinked


def disk_usage(data_dir: str | Path) -> int:
    """DATA_DIR's bytes in use, from the index. Run it in a thread."""
    store = Store(data_dir)
    try:
        return store.used_bytes()
    finally:
        store.close()
