"""Starting the announce check after a push, one at a time.

A push asks for a check a little later, once per CHECK_DELAYS value (by default 30 s and 150 s:
YouTube's API can take a moment to call a stream live, Twitch's to list it). Pushes that come close
together share their checks. The check itself is feedback/announce.py --push, run as its own process
with the loop's interpreter: the very code the loop runs, fresh after each git pull, under the lock
it shares with the loop (see run() there). So a push can never post anything the loop's state
doesn't know about, and if this service is down the loop's checks every 5 minutes carry on as before.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Awaitable, Callable, Iterable

log = logging.getLogger("alerts.checks")

# A check due within this many seconds of one already planned isn't planned again.
COALESCE = 15.0


class Checks:
    def __init__(self, run_check: Callable[[], Awaitable[bool]], delays: Iterable[float],
                 coalesce: float = COALESCE, clock: Callable[[], float] = time.monotonic):
        self._run_check = run_check
        self._delays = tuple(delays)
        self._coalesce = coalesce
        self._clock = clock
        self._due: list[float] = []
        self._wake = asyncio.Event()
        self._current: asyncio.Future | None = None
        # For /health (wall-clock seconds).
        self.requested_at: int | None = None
        self.ran_at: int | None = None
        self.last_ok: bool | None = None
        self.runs = 0

    def request(self, reason: str) -> None:
        now = self._clock()
        planned = list(self._due)
        for delay in self._delays:
            at = now + delay
            if not any(abs(at - due) < self._coalesce for due in planned):
                self._due.append(at)
        self._due.sort()
        self.requested_at = int(time.time())
        log.info("%s: check in %s s", reason, ", ".join(f"{max(0, d - now):.0f}" for d in self._due))
        self._wake.set()

    @property
    def planned(self) -> int:
        return len(self._due)

    async def run_forever(self) -> None:
        while True:
            self._wake.clear()
            if not self._due:
                await self._wake.wait()
                continue
            wait = self._due[0] - self._clock()
            if wait > 0:
                try:  # a new push may plan an earlier one
                    await asyncio.wait_for(self._wake.wait(), wait)
                except TimeoutError:
                    pass
                continue
            now = self._clock()
            self._due = [at for at in self._due if at > now]  # one check covers all that are due
            # Shielded: stopping the service lets a running check finish (see close()).
            self._current = asyncio.ensure_future(self._run_one())
            await asyncio.shield(self._current)

    async def _run_one(self) -> None:
        self.ran_at = int(time.time())
        try:
            ok = await self._run_check()
        except Exception:
            log.exception("the announce check couldn't start")
            ok = False
        self.last_ok = ok
        self.runs += 1

    async def close(self, grace: float) -> None:
        """Waits up to `grace` seconds for a running check, so a restart doesn't stop one between
        posting and saving what it posted."""
        if self._current is not None and not self._current.done():
            log.info("waiting for the running check to finish")
            try:
                await asyncio.wait_for(asyncio.shield(self._current), grace)
            except TimeoutError:
                log.warning("the check was still running at shutdown")

    def health(self) -> dict:
        return {"requestedAt": self.requested_at, "ranAt": self.ran_at, "lastOk": self.last_ok,
                "runs": self.runs, "planned": self.planned}


async def run_announce(python: str, feedback_dir: str, timeout: float) -> bool:
    """feedback/announce.py --push from the checkout's root, like the loop runs run.py. Its output
    goes to this service's log. True when it ran to the end."""
    folder = Path(feedback_dir)
    process = await asyncio.create_subprocess_exec(
        python, str(folder / "announce.py"), "--push", cwd=str(folder.parent),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout)
    except TimeoutError:
        # A hung request; the lock goes with the process.
        process.kill()
        await process.wait()
        log.error("the announce check took over %.0f s and was stopped", timeout)
        return False
    for line in output.decode("utf-8", "replace").splitlines():
        if line.strip():
            log.info("%s", line)
    if process.returncode:
        log.warning("the announce check failed (exit %s)", process.returncode)
        return False
    return True
