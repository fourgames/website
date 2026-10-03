"""What worked and what failed in this run, for the dashboard's status bar (data/index.json → status).

Each part of a run reports ok(source) or fail(source, message). A source's entry only changes when
its state does (`since` is when it last flipped), so a run where everything still works leaves
index.json untouched and makes no commit. Messages must not carry per-run details (request IDs,
timestamps) for the same reason.
"""

import time

_seen = {}  # source → None (worked) or the first failure message of this run


def ok(source):
    _seen.setdefault(source, None)


def fail(source, message):
    if _seen.get(source) is None:
        _seen[source] = message


def merge(previous):
    """The new status block: this run's results on top of the previous run's (for parts it skipped)."""
    out = dict(previous or {})
    for source, message in _seen.items():
        old = out.get(source) or {}
        entry = {"ok": message is None, "message": message}
        same = old.get("ok") == entry["ok"] and old.get("message") == message
        entry["since"] = old.get("since") if same and old.get("since") else int(time.time())
        out[source] = entry
    return dict(sorted(out.items()))
