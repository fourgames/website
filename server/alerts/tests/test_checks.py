"""Planning checks after pushes, and running announce.py --push as its own process."""

import asyncio
import logging
import sys
import time

from alerts.checks import Checks, run_announce


class Recorder:
    def __init__(self, seconds=0.0, ok=True):
        self.seconds = seconds
        self.ok = ok
        self.started = []
        self.running = 0
        self.most = 0

    async def __call__(self):
        self.started.append(time.monotonic())
        self.running += 1
        self.most = max(self.most, self.running)
        await asyncio.sleep(self.seconds)
        self.running -= 1
        return self.ok


async def run_for(seconds, checks, *requests):
    """Runs the planner for `seconds`; `requests` are (after seconds, reason)."""
    task = asyncio.create_task(checks.run_forever())
    start = time.monotonic()
    for after, reason in requests:
        await asyncio.sleep(max(0, start + after - time.monotonic()))
        checks.request(reason)
    await asyncio.sleep(max(0, start + seconds - time.monotonic()))
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    return start


def test_each_push_plans_a_check_per_delay():
    async def go():
        recorder = Recorder()
        checks = Checks(recorder, delays=(0.05, 0.25), coalesce=0.03)
        start = await run_for(0.5, checks, (0, "push"))
        return [round(t - start, 2) for t in recorder.started], checks.health()

    started, health = asyncio.run(go())
    assert len(started) == 2
    assert 0.04 <= started[0] < 0.15 and 0.24 <= started[1] < 0.4
    assert health["runs"] == 2 and health["lastOk"] is True and health["planned"] == 0


def test_one_push_gets_every_delay_however_close():
    async def go():
        recorder = Recorder()
        checks = Checks(recorder, delays=(0.05, 0.15), coalesce=1.0)
        await run_for(0.4, checks, (0, "push"))
        return recorder

    assert len(asyncio.run(go()).started) == 2


def test_pushes_close_together_share_their_checks():
    async def go():
        recorder = Recorder()
        checks = Checks(recorder, delays=(0.1, 0.3), coalesce=0.05)
        await run_for(0.6, checks, (0, "YouTube"), (0.01, "YouTube again"), (0.02, "Twitch"))
        return recorder

    assert len(asyncio.run(go()).started) == 2


def test_checks_never_overlap():
    async def go():
        recorder = Recorder(seconds=0.1)
        checks = Checks(recorder, delays=(0,), coalesce=0.001)
        await run_for(0.6, checks, *[(i * 0.02, f"push {i}") for i in range(5)])
        return recorder

    recorder = asyncio.run(go())
    assert recorder.most == 1
    # A push during a check gets a check after it (5 pushes in 0.1 s: one at once, the rest after).
    assert 2 <= len(recorder.started) <= 5


def test_a_failing_check_is_recorded():
    async def go():
        async def broken():
            raise OSError("no python")

        checks = Checks(broken, delays=(0,))
        await run_for(0.1, checks, (0, "push"))
        return checks.health()

    health = asyncio.run(go())
    assert health["runs"] == 1 and health["lastOk"] is False


def test_stopping_waits_for_the_running_check():
    async def go():
        recorder = Recorder(seconds=0.3)
        checks = Checks(recorder, delays=(0,))
        task = asyncio.create_task(checks.run_forever())
        checks.request("push")
        await asyncio.sleep(0.05)
        task.cancel()  # what stopping the service does
        await asyncio.gather(task, return_exceptions=True)
        await checks.close(grace=2)
        return checks.health()

    health = asyncio.run(go())
    assert health["runs"] == 1 and health["lastOk"] is True


def write_script(folder, code):
    feedback = folder / "feedback"
    feedback.mkdir()
    (feedback / "announce.py").write_text(code)
    return feedback


def test_run_announce_runs_the_script_from_the_checkout(tmp_path, caplog):
    feedback = write_script(tmp_path, "import os, sys\nprint('[announce] args', sys.argv[1:], 'cwd', os.getcwd())\n")
    with caplog.at_level(logging.INFO, logger="alerts.checks"):
        ok = asyncio.run(run_announce(sys.executable, str(feedback), timeout=30))
    assert ok
    line = next(r.getMessage() for r in caplog.records if r.getMessage().startswith("[announce]"))
    assert "['--push']" in line and str(tmp_path.resolve()) in line


def test_run_announce_reports_a_failure(tmp_path):
    feedback = write_script(tmp_path, "raise SystemExit(3)\n")
    assert asyncio.run(run_announce(sys.executable, str(feedback), timeout=30)) is False


def test_run_announce_stops_a_hung_check(tmp_path):
    feedback = write_script(tmp_path, "import time\ntime.sleep(30)\n")
    started = time.monotonic()
    assert asyncio.run(run_announce(sys.executable, str(feedback), timeout=0.5)) is False
    assert time.monotonic() - started < 10
