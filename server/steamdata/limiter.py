"""One rate limiter per host: a fixed gap between requests that widens when the host pushes back."""

from __future__ import annotations

import logging

log = logging.getLogger("steamdata.limiter")


class Limiter:
    def __init__(self, name: str, interval: float, throttle_pause: float):
        self.name = name
        self.base = interval          # seconds between requests, as configured
        self.interval = interval      # the current gap: wider after throttling, back to base slowly
        self.throttle_pause = throttle_pause
        self.next_at = 0.0
        self.strikes = 0              # throttles or failures in a row
        self.good = 0                 # successes since the gap last changed

    def ready_at(self) -> float:
        return self.next_at

    def took(self, now: float) -> None:
        """A request starts now."""
        self.next_at = now + self.interval

    def ok(self) -> None:
        self.strikes = 0
        self.good += 1
        # 200 good requests in a row: narrow the gap a step, back towards the configured rate.
        if self.interval > self.base and self.good >= 200:
            self.interval = max(self.base, self.interval / 1.25)
            self.good = 0
            log.info("%s: back to one request per %.1fs", self.name, self.interval)

    def throttled(self, now: float, retry_after: float | None = None) -> float:
        """The host said slow down (429): pause, then go on 50% slower (at most 4x the base gap).
        Returns the pause in seconds."""
        self.strikes += 1
        self.good = 0
        pause = self.throttle_pause * 2 ** min(self.strikes - 1, 4)
        pause = min(max(pause, retry_after or 0), 3600)
        self.interval = min(self.interval * 1.5, self.base * 4)
        self.next_at = now + pause
        return pause

    def failed(self, now: float) -> float:
        """A 5xx, timeout or broken reply: wait 10s, 20s, 40s ... up to 15 minutes, same rate."""
        self.strikes += 1
        pause = min(10 * 2 ** min(self.strikes - 1, 7), 900)
        self.next_at = max(self.next_at, now + pause)
        return pause
