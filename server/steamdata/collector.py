"""The collector: one thread, one request at a time, each host at its own pace.

Work is split into lanes (the app list, tag names, the daily snapshot, player counts, the monthly
demos, metadata, the store pages' AI disclosure, PCGamingWiki). Each lane takes what's due from the
database a small batch at a time. The loop picks the lane whose host may be asked soonest (lanes sharing a host go in the order
below, so the daily snapshot goes before player counts), sleeps until then, and does one request.
"""

from __future__ import annotations

import json
import logging
import random
import threading
import time
from collections import Counter, deque
from typing import Any, Callable

from . import cadence, engine, pcgw, steam
from .config import Config
from .db import Store
from .limiter import Limiter
from .net import Http, HttpError, Throttled, Transient

log = logging.getLogger("steamdata")

SUMMARY_EVERY = 600


class Lane:
    name = ""
    idle = 60.0  # seconds between checks for new work when there's none
    # Lanes that may have new work after this one did something: they look right away.
    wakes: tuple[str, ...] = ()

    def __init__(self, c: "Collector", limiter: Limiter):
        self.c = c
        self.limiter = limiter
        self.queue: deque = deque()
        self.next_check = 0.0
        self.failures = 0  # transient failures in a row of the item at the front
        self.counts: Counter = Counter()

    @property
    def store(self) -> Store:
        return self.c.store

    def refill(self, now: float) -> list:
        return []

    def run(self, item: Any, now: float) -> None:
        raise NotImplementedError

    def give_up(self, item: Any, now: float) -> None:
        """The item failed for now: put it off (it stays in the database as due later)."""
        self.next_check = now + cadence.RETRY_LATER


class AppListLane(Lane):
    """IStoreService/GetAppList: the changed apps every 6 hours, every game once a day. The page
    cursor is saved after each page, so a restart carries on from there."""

    name = "applist"
    wakes = ("snapshot", "details")

    def __init__(self, c, limiter):
        super().__init__(c, limiter)
        self.warned = False

    def refill(self, now):
        if not self.c.cfg.web_api_key:
            if not self.warned:
                log.warning("no STEAM_WEB_API_KEY: the app list can't be fetched, so only the apps "
                            "already in the database (and PCGamingWiki's) are collected")
                self.warned = True
            self.next_check = now + cadence.HOUR
            return []
        state = json.loads(self.store.meta("applist_run") or "null")
        if state is None:
            if now >= self.store.meta_float("applist_full_due"):
                state = {"full": True, "since": None}
            elif now >= self.store.meta_float("applist_due"):
                state = {"full": False, "since": self.store.meta_float("applist_since") or None}
            else:
                return []
            state.update(cursor=0, started=int(now), pages=0, apps=0, new=0)
            self.store.set_meta("applist_run", json.dumps(state))
        return [state]

    def run(self, state, now):
        apps, more, last = steam.app_list_page(self.c.http, self.c.cfg.web_api_key, state["cursor"], state["since"])
        state["new"] += self.store.save_list_apps(apps, now, full=state["full"])
        state["pages"] += 1
        state["apps"] += len(apps)
        if more and last > state["cursor"]:
            state["cursor"] = last
            self.store.set_meta("applist_run", json.dumps(state))
            self.queue.appendleft(state)
            return
        gone = self.store.finish_full_list(state["started"], now) if state["full"] else 0
        self.store.set_meta("applist_run", None)
        if state["full"]:
            self.store.set_meta("applist_full_due", int(now) + cadence.APPLIST_FULL_EVERY)
        self.store.set_meta("applist_due", int(now) + cadence.APPLIST_EVERY)
        self.store.set_meta("applist_since", state["started"] - cadence.APPLIST_OVERLAP)
        log.info("app list (%s): %d apps in %d page(s), %d new, %d no longer listed",
                 "full" if state["full"] else "changed since last time", state["apps"], state["pages"],
                 state["new"], gone)


class TagsLane(Lane):
    """IStoreService/GetTagList: the user tags' names, weekly."""

    name = "tags"
    idle = 600.0

    def refill(self, now):
        return ["tags"] if now >= self.store.meta_float("tags_due") else []

    def run(self, item, now):
        tags = steam.tag_list(self.c.http)
        self.store.save_tags(tags)
        self.store.set_meta("tags_due", int(now) + cadence.TAGS_EVERY)
        log.info("tag names: %d", len(tags))


class SnapshotLane(Lane):
    """IStoreBrowseService/GetItems: every game once per UTC day, 100 per request."""

    name = "snapshot"
    wakes = ("players", "details")

    def refill(self, now):
        due = self.store.due("snapshot", now, steam.ITEMS_PER_CALL * 5)
        return [due[i:i + steam.ITEMS_PER_CALL] for i in range(0, len(due), steam.ITEMS_PER_CALL)]

    def run(self, appids, now):
        results = steam.get_items(self.c.http, appids, self.c.cfg.country)
        self.counts["rows"] += self.store.save_snapshot(results, now, self.c.rng)
        # A guard: whatever the reply was, nothing in this batch is asked for again within the hour.
        # (Only moves dues forward, so the ones just scheduled for tomorrow keep that.) Without it,
        # one app the reply didn't account for was asked for 60 times a minute, all day.
        self.store.delay("snapshot", appids, now + cadence.RETRY_LATER)

    def give_up(self, appids, now):
        self.store.delay("snapshot", appids, now + cadence.RETRY_LATER)


class PlayersLane(Lane):
    """ISteamUserStats/GetNumberOfCurrentPlayers: one game per request, as often as cadence.py says."""

    name = "players"
    idle = 30.0

    def refill(self, now):
        return self.store.due("players", now, 50)

    def run(self, appid, now):
        count = steam.current_players(self.c.http, appid)
        self.store.save_players(appid, count, now, self.c.rng)

    def give_up(self, appid, now):
        self.store.delay("players", [appid], now + cadence.RETRY_LATER)


class DemosLane(Lane):
    """The demos of games coming soon or just out (db.sync_demos): their review counts once a day
    (GetItems, 100 per request) and their players (GetNumberOfCurrentPlayers) as often as
    cadence.demo_players_interval says. On the Web API host after the games' own lanes, so it only
    uses what's left of the budget."""

    name = "demos"
    idle = 300.0

    def refill(self, now):
        if now >= self.store.meta_float("demos_sync_due"):
            added, dropped = self.store.sync_demos(now)
            self.store.set_meta("demos_sync_due", int(now) + cadence.DEMO_SYNC_EVERY)
            if added or dropped:
                log.info("demos: %d newly followed, %d no longer", added, dropped)
        due = self.store.due_demos("snapshot", now, steam.ITEMS_PER_CALL * 2)
        items: list = [("snapshot", due[i:i + steam.ITEMS_PER_CALL]) for i in range(0, len(due), steam.ITEMS_PER_CALL)]
        items += [("players", a) for a in self.store.due_demos("players", now, 50)]
        return items

    def run(self, item, now):
        kind, arg = item
        if kind == "snapshot":
            self.counts["rows"] += self.store.save_demo_snapshot(steam.get_items(self.c.http, arg, self.c.cfg.country), now)
            # Whatever the reply, nothing in this batch is asked for again within the hour.
            self.store.delay_demos("snapshot", arg, now + cadence.RETRY_LATER)
        else:
            self.store.save_demo_players(arg, steam.current_players(self.c.http, arg), now, self.c.rng)

    def give_up(self, item, now):
        kind, arg = item
        self.store.delay_demos(kind, arg if isinstance(arg, list) else [arg], now + cadence.RETRY_LATER)


class DetailsLane(Lane):
    """store appdetails: new games first (newest first), then each game every DETAILS_DAYS."""

    name = "details"
    wakes = ("players",)

    def refill(self, now):
        return self.store.due("details", now, 20)

    def run(self, appid, now):
        data = steam.app_details(self.c.http, appid, self.c.cfg.country)
        details = steam.parse_details(data) if data is not None else None
        signals = engine.scan(details.texts) if details else []
        self.store.save_details(appid, details, signals, now, self.c.rng, self.c.cfg.details_days)

    def give_up(self, appid, now):
        self.store.delay("details", [appid], now + cadence.DAY)


class AiLane(Lane):
    """The store page's AI disclosure: recent and upcoming games (db.AI_SINCE), never-read first
    (newest first), then each every AI_DAYS. Shares the store's pace with the metadata, after it."""

    name = "ai"

    def refill(self, now):
        return self.store.due("ai", now, 20)

    def run(self, appid, now):
        page = steam.store_page(self.c.http, appid, self.c.cfg.country)
        self.store.save_ai(appid, steam.parse_ai_disclosure(page, appid), now, self.c.rng, self.c.cfg.ai_days)

    def give_up(self, appid, now):
        self.store.delay("ai", [appid], now + cadence.DAY)


class PcgwLane(Lane):
    """PCGamingWiki, weekly: the pages linking each engine, then the changed pages' wikitext."""

    name = "pcgw"
    wakes = ("snapshot", "details", "players")
    idle = 300.0

    def __init__(self, c, limiter):
        super().__init__(c, limiter)
        self.active = False
        self.linked: dict[str, set[int]] = {}
        self.known: dict[str, dict[int, int]] = {}
        self.listed: set[str] = set()

    def refill(self, now):
        engines = self.c.cfg.pcgw_engines
        if self.active or not engines or now < self.store.meta_float("pcgw_due"):
            return []
        self.active = True
        self.listed = set()
        self.linked = {pcgw.engine_key(e): set() for e in engines}
        self.known = {pcgw.engine_key(e): self.store.pcgw_revisions(pcgw.engine_key(e)) for e in engines}
        return [("list", e, None) for e in engines]

    def run(self, item, now):
        kind, name, arg = item
        key = pcgw.engine_key(name)
        if kind == "list":
            refs, cont = pcgw.backlinks(self.c.http, name, arg)
            changed = []
            for ref in refs:
                self.linked[key].add(ref.pageid)
                if self.known[key].get(ref.pageid) != ref.revid:
                    changed.append(ref.pageid)
            if cont:
                self.queue.appendleft(("list", name, cont))
            else:
                self.listed.add(key)
            size = pcgw.PAGES_PER_REQUEST
            self.queue.extend(("pages", name, changed[i:i + size]) for i in range(0, len(changed), size))
        else:
            texts = pcgw.contents(self.c.http, arg)
            pages = [pcgw.parse_page(pid, title, revid, text, name) for pid, (title, revid, text) in texts.items()]
            self.store.save_pcgw_pages(key, pages, now)
        if not self.queue:
            self.finish(now)

    def finish(self, now):
        for key in sorted(self.listed):
            result = self.store.finish_pcgw(key, self.linked[key], now)
            log.info("PCGamingWiki %s: %d pages link it, %d games (%d with it in the infobox), "
                     "%d dropped, %d apps new to us, %d Godot-set changes", key, len(self.linked[key]),
                     result["games"], result["strong"], result["removed"], result["new_apps"],
                     result["godot_changed"])
        self.store.set_meta("pcgw_due", int(now) + cadence.PCGW_EVERY)
        self.active = False

    def give_up(self, item, now):
        # The pages saved so far stay; the next pass (in 6 hours) only fetches what's missing.
        self.queue.clear()
        self.active = False
        self.store.set_meta("pcgw_due", int(now) + 6 * cadence.HOUR)


class Collector:
    def __init__(self, cfg: Config, store: Store, http: Http | None = None,
                 clock: Callable[[], float] = time.time, sleep: Callable[[float], Any] | None = None,
                 rng: random.Random | None = None, lanes: set[str] | None = None):
        self.cfg = cfg
        self.store = store
        self.http = http or Http(cfg.user_agent)
        self.clock = clock
        self._stop = threading.Event()
        self.sleep = sleep or self._stop.wait
        self.rng = rng or random.Random()
        webapi = Limiter("api.steampowered.com", 60.0 / cfg.webapi_per_minute, throttle_pause=60)
        store_api = Limiter("store.steampowered.com", 300.0 / cfg.appdetails_per_5min, throttle_pause=300)
        wiki = Limiter("www.pcgamingwiki.com", cfg.pcgw_seconds, throttle_pause=300)
        # Order matters for lanes sharing a host: earlier ones go first.
        all_lanes = [AppListLane(self, webapi), TagsLane(self, webapi), SnapshotLane(self, webapi),
                     PlayersLane(self, webapi), DemosLane(self, webapi), DetailsLane(self, store_api), AiLane(self, store_api), PcgwLane(self, wiki)]
        self.lanes = [lane for lane in all_lanes if lanes is None or lane.name in lanes]
        self.next_summary = 0.0
        self.day: int | None = None
        self.errors_in_row = 0
        self.requests = 0

    def stop(self) -> None:
        self._stop.set()

    def run(self, max_requests: int | None = None) -> int:
        """Collects until stop() (or max_requests requests). Returns the number of requests."""
        log.info("collecting into %s (lanes: %s)", self.store_path(), ", ".join(l.name for l in self.lanes))
        start = self.requests
        while not self._stop.is_set():
            now = self.clock()
            self._housekeeping(now)
            lane, wait = self._next(now)
            if lane is None or wait > 0:
                self.sleep(min(max(wait, 0.05), 60.0))
                continue
            item = lane.queue.popleft()
            lane.limiter.took(now)
            self.requests += 1
            self._attempt(lane, item, now)
            if max_requests and self.requests - start >= max_requests:
                break
        self._flush(self.clock())
        return self.requests - start

    def store_path(self) -> str:
        row = self.store.db.execute("PRAGMA database_list").fetchone()
        return row[2] if row else "?"

    def _next(self, now: float) -> tuple[Lane | None, float]:
        """The lane to serve next and how long until its host may be asked."""
        for lane in self.lanes:
            if not lane.queue and now >= lane.next_check:
                try:
                    items = lane.refill(now)
                except Exception:
                    log.exception("%s: couldn't look up what's due", lane.name)
                    items = []
                lane.queue.extend(items)
                if not items and lane.next_check <= now:
                    lane.next_check = now + lane.idle
        best = None
        for lane in self.lanes:
            if lane.queue and (best is None or lane.limiter.ready_at() < best.limiter.ready_at()):
                best = lane
        # Wake up in time to look for work in the idle lanes too.
        idle = min((lane.next_check - now for lane in self.lanes if not lane.queue), default=60.0)
        if best is None:
            return None, idle
        wait = best.limiter.ready_at() - now
        return best, (wait if wait <= 0 else min(wait, idle))

    def _attempt(self, lane: Lane, item: Any, now: float) -> None:
        log.debug("%s: %s", lane.name, _describe(item))
        try:
            lane.run(item, now)
        except Throttled as error:
            pause = lane.limiter.throttled(now, error.retry_after)
            lane.queue.appendleft(item)
            lane.counts["throttled"] += 1
            log.warning("%s: %s: pausing %s for %ds, then one request per %.1fs", lane.name, error,
                        lane.limiter.name, pause, lane.limiter.interval)
        except Transient as error:
            pause = lane.limiter.failed(now)
            lane.counts["failed"] += 1
            lane.failures += 1
            if lane.failures >= 3:
                lane.failures = 0
                log.warning("%s: %s (3 times): trying %s again later", lane.name, error, _describe(item))
                self._give_up(lane, item, now)
            else:
                lane.queue.appendleft(item)
                log.info("%s: %s: retrying in %ds", lane.name, error, pause)
        except HttpError as error:
            lane.counts["failed"] += 1
            lane.failures = 0
            log.warning("%s: %s: skipping %s for now", lane.name, error, _describe(item))
            self._give_up(lane, item, now)
        except Exception:
            lane.counts["failed"] += 1
            lane.failures = 0
            self.errors_in_row += 1
            log.exception("%s: unexpected error on %s", lane.name, _describe(item))
            self._give_up(lane, item, now)
            if self.errors_in_row >= 20:
                log.error("20 unexpected errors in a row (disk full? database locked?): pausing 5 minutes")
                self.errors_in_row = 0
                self.sleep(300)
        else:
            lane.limiter.ok()
            lane.failures = 0
            self.errors_in_row = 0
            lane.counts["ok"] += 1
            for other in self.lanes:
                if other.name in lane.wakes and not other.queue:
                    other.next_check = min(other.next_check, now)

    def _give_up(self, lane: Lane, item: Any, now: float) -> None:
        try:
            lane.give_up(item, now)
        except Exception:
            log.exception("%s: couldn't put %s off", lane.name, _describe(item))

    def _housekeeping(self, now: float) -> None:
        day = cadence.day_number(now)
        if day != self.day:
            self.day = day
            self._daily(now)
        if now >= self.next_summary:
            if self.next_summary:
                self._summary(now)
            self.next_summary = now + SUMMARY_EVERY

    def _daily(self, now: float) -> None:
        try:
            if self.cfg.samples_keep_days:
                removed = self.store.prune_samples(now - self.cfg.samples_keep_days * cadence.DAY)
                if removed:
                    log.info("removed %d player samples older than %d days", removed, self.cfg.samples_keep_days)
            self.store.optimize()
        except Exception:
            log.exception("daily upkeep failed")

    def _flush(self, now: float) -> None:
        try:
            self.store.add_http_counts(cadence.day_number(now), self.http.take_counts())
        except Exception:
            log.exception("couldn't save the request counts")

    def _summary(self, now: float) -> None:
        self._flush(now)
        done = ", ".join(f"{lane.name} {lane.counts['ok']}" for lane in self.lanes if lane.counts["ok"])
        trouble = sum(lane.counts["throttled"] + lane.counts["failed"] for lane in self.lanes)
        try:
            due = ", ".join(f"{name} {self.store.count_due(name, now):,}"
                            for name in ("snapshot", "players", "details", "ai")
                            if any(lane.name == name for lane in self.lanes))
        except Exception:
            due = "?"
        log.info("last %d min: %s requests%s | due now: %s", SUMMARY_EVERY // 60, done or "no",
                 f", {trouble} throttled or failed" if trouble else "", due)
        for lane in self.lanes:
            lane.counts.clear()


def _describe(item: Any) -> str:
    if isinstance(item, list):
        return f"{len(item)} apps ({item[0]}...)" if item else "nothing"
    if isinstance(item, dict):
        return "the app list"
    if isinstance(item, tuple) and len(item) == 2:
        return f"demo {item[0]} of {_describe(item[1])}"
    if isinstance(item, tuple):
        return f"PCGamingWiki {item[0]} for {item[1]}"
    return f"app {item}" if isinstance(item, int) else str(item)
