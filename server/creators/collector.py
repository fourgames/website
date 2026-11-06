"""One run of the collector: spends the YouTube units due by now on game searches and channel details.

Started every hour by creators.timer. The day's units are spread evenly over YouTube's quota day
(midnight to midnight Pacific), so each run spends about 1/24th, and a run missed is made up later.
"""

from __future__ import annotations

import logging
import math
import time
from datetime import datetime
from typing import Callable
from zoneinfo import ZoneInfo

from steamdata.net import Http, HttpError

from . import games as games_mod
from .config import USER_AGENT, Config
from .db import Store
from .youtube import LIST_COST, SEARCH_COST, QuotaExceeded, YouTube, channel_row, mentions, video_row

log = logging.getLogger("creators")
PACIFIC = ZoneInfo("America/Los_Angeles")
DAY = 86400


def quota_day(now: float) -> tuple[str, float]:
    """YouTube's quota day (its Pacific date) and how far into it we are, 0 to 1."""
    local = datetime.fromtimestamp(now, PACIFIC)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return local.strftime("%Y-%m-%d"), min(1.0, (local - midnight).total_seconds() / DAY)


# How often each channel's newest upload is read again.
UPLOAD_CHECK_DAYS = 14


class Collector:
    def __init__(self, config: Config, store: Store, youtube: YouTube | None = None,
                 clock: Callable[[], float] = time.time):
        self.config = config
        self.store = store
        self.youtube = youtube or YouTube(Http(USER_AGENT), config.youtube_api_key)
        self.clock = clock
        self.summary = {"searches": 0, "videos": 0, "new_videos": 0, "channels": 0, "uploads": 0, "units": 0}

    def allowed(self, spend_all: bool) -> tuple[str, int]:
        day, part = quota_day(self.clock())
        if spend_all:
            return day, self.config.daily_units
        # Up to the end of the coming hour, so hourly runs spend it all by midnight.
        return day, min(self.config.daily_units, math.ceil(self.config.daily_units * (part + 1 / 24)))

    def run(self, spend_all: bool = False, max_searches: int | None = None) -> dict:
        day, allowed = self.allowed(spend_all)
        spent, exhausted = self.store.units_spent(day)
        if exhausted or spent >= allowed:
            log.info("nothing to spend now (%d of %d units used today)", spent, allowed)
            return self.summary
        self.day, self.spent, self.limit = day, spent, allowed
        try:
            self._searches(max_searches)
            self._refresh_channels(stale=True)
            self._check_uploads()
        except QuotaExceeded as error:
            log.warning("YouTube refused (%s): stopping until the quota day ends", error)
            self.store.spend(self.day, 0, exhausted=True)
        except HttpError as error:
            # Network trouble or a 5xx: the next hourly run carries on.
            log.warning("YouTube error, stopping this run: %s", error)
        log.info("ran: %(searches)d searches, %(videos)d videos kept (%(new_videos)d new), "
                 "%(channels)d channels read, %(uploads)d newest uploads read, %(units)d units", self.summary)
        return self.summary

    def _pay(self, units: int) -> None:
        self.spent += units
        self.summary["units"] += units
        self.store.spend(self.day, units)

    def _can(self, units: int) -> bool:
        return self.spent + units <= self.limit

    def _searches(self, max_searches: int | None) -> None:
        now = int(self.clock())
        done = self.store.searches()
        for game in games_mod.read(self.config.steam_db, self.config.own_appids, self.config.min_reviews,
                                   self.config.max_reviews, self.config.own_studio, self.config.max_price):
            if max_searches is not None and self.summary["searches"] >= max_searches:
                return
            prior = done.get(game.appid)
            if prior and prior["due_at"] > now or not games_mod.searchable(game.name):
                continue
            # A search, up to one videos call, and the new channels' details.
            if not self._can(SEARCH_COST + 2 * LIST_COST):
                return
            self._search(game, prior, now)
            self._refresh_channels(stale=False)

    def _search(self, game: games_mod.Game, prior, now: int) -> None:
        # A day of overlap: YouTube's search lists some videos hours after they're published.
        since = prior["searched_at"] - DAY if prior and prior["searched_at"] else now - self.config.lookback_days * DAY
        ids = self.youtube.search(game.name, since)
        self._pay(SEARCH_COST)
        videos = self.youtube.videos(ids) if ids else []
        self._pay(LIST_COST * math.ceil(len(ids) / 50))
        rows = [video_row(game.appid, v) for v in videos
                if mentions(game.name, v) and (v.get("snippet") or {}).get("channelId")]
        new = self.store.save_videos(rows, now)
        every = games_mod.OWN_EVERY_DAYS if game.own else self.config.research_days
        self.store.searched(game.appid, game.name, now, now + every * DAY, len(ids), len(rows))
        self.summary["searches"] += 1
        self.summary["videos"] += len(rows)
        self.summary["new_videos"] += new
        log.debug("%s (%d): %d results, %d kept, %d new", game.name, game.appid, len(ids), len(rows), new)

    def _check_uploads(self) -> None:
        """Each channel's newest upload of any kind (is it still active?), every UPLOAD_CHECK_DAYS, 1 unit
        each. A 403 can be a private uploads playlist or the quota: three in a row count as the quota."""
        now = int(self.clock())
        refused = 0
        while self._can(LIST_COST):
            ids = self.store.channels_to_check_uploads(now, UPLOAD_CHECK_DAYS, 50)
            if not ids:
                return
            for channel_id in ids:
                if not self._can(LIST_COST):
                    return
                try:
                    last = self.youtube.latest_upload(channel_id)
                    refused = 0
                except HttpError as error:
                    if error.status != 403:
                        raise
                    refused += 1
                    if refused >= 3:
                        raise QuotaExceeded(str(error)) from None
                    last = None
                self._pay(LIST_COST)
                self.store.save_upload(channel_id, last, now)
                self.summary["uploads"] += 1

    def _refresh_channels(self, stale: bool) -> None:
        """New channels (stale=False), or also those not read for CHANNEL_REFRESH_DAYS, 50 per unit."""
        now = int(self.clock())
        # Without stale, a refresh age no channel has: only those never read.
        days = self.config.channel_refresh_days if stale else 100_000
        while self._can(LIST_COST):
            ids = self.store.channels_to_refresh(now, days, 50)
            if not ids:
                return
            rows = [channel_row(c) for c in self.youtube.channels(ids)]
            self._pay(LIST_COST)
            self.store.save_channels(rows, ids, now)
            self.summary["channels"] += len(rows)
