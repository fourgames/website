"""What worked and what failed in this run, for the dashboard's status bar (data/index.json → status).

Each part of a run reports ok(source) or fail(source, message). A source's entry only changes when
its state does (`since` is when it last flipped), so a run where everything still works leaves
index.json untouched and makes no commit. Messages must not carry per-run details (request IDs,
timestamps) for the same reason.
"""

import time

_seen = {}  # source → None (worked) or the first failure message of this run
_active = set()  # sources that brought in or did something new this run


def ok(source):
    _seen.setdefault(source, None)


def fail(source, message):
    if _seen.get(source) is None:
        _seen[source] = message


def active(source):
    """The source did something new (a new review, a sorted post, a sent alert): the dashboard shows
    when that last happened. Only marked alongside a data change, so it never makes a commit alone."""
    _active.add(source)
    _seen.setdefault(source, None)


def merge(previous):
    """The new status block: this run's results on top of the previous run's (for parts it skipped)."""
    out = dict(previous or {})
    for source, message in _seen.items():
        old = out.get(source) or {}
        entry = {"ok": message is None, "message": message}
        same = old.get("ok") == entry["ok"] and old.get("message") == message
        entry["since"] = old.get("since") if same and old.get("since") else int(time.time())
        entry["active"] = int(time.time()) if source in _active else old.get("active")
        out[source] = entry
    return dict(sorted(out.items()))
