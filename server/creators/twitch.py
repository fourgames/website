"""Twitch streamers: who streamed the games we search, from Twitch's Helix API (free, an app token
from TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in creators.env, the same app the key bot uses).

Per game, every TWITCH_RESEARCH_DAYS (ours every week): its Twitch category (looked up by its Steam
name, 100 names a call), the past broadcasts saved in that category this month (videos, type archive)
and who's live in it right now (streams). Each new streamer is read once (users: name, description,
type) with their follower count (channels/followers, the total only), and again after
CHANNEL_REFRESH_DAYS. Emails come from the channel description; Twitch's About panels aren't in the
API, so a streamer whose YouTube channel is on our list also gets that channel's emails (export.py).

Twitch allows an app token 800 calls a minute; a run makes at most MAX_CALLS, paced under that.
Run from the hourly collector (python -m creators), after the YouTube part.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Callable, Optional

from . import contacts
from . import games as games_mod
from .config import USER_AGENT

log = logging.getLogger("creators.twitch")
HELIX = "https://api.twitch.tv/helix"
TOKEN_URL = "https://id.twitch.tv/oauth2/token"
DAY = 86400
MAX_CALLS = 1500
PACE = 0.09  # seconds between calls: about 660 a minute
REFRESH_DAYS = 30
OWN_EVERY_DAYS = 7
NOT_ON_TWITCH_DAYS = 60  # a Steam name with no Twitch category is looked up again after this

SCHEMA = """
CREATE TABLE IF NOT EXISTS twitch_games (
    appid       INTEGER PRIMARY KEY,
    game_id     TEXT,                   -- Twitch's category id; NULL: no category with the Steam name
    name        TEXT,
    checked_at  INTEGER NOT NULL,       -- when the category was looked up
    searched_at INTEGER,                -- when its broadcasts were last read
    due_at      INTEGER,
    found       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS twitch_channels (
    user_id      TEXT PRIMARY KEY,
    login        TEXT,
    name         TEXT,
    description  TEXT,
    kind         TEXT,                  -- partner, affiliate or ''
    followers    INTEGER,
    language     TEXT,                  -- of their broadcasts
    created      INTEGER,
    emails       TEXT,                  -- JSON list found in the description
    links        TEXT,                  -- JSON {"youtube": ..., "x": ...} from the description
    last_stream  INTEGER,               -- their newest broadcast we saw, of any game we searched
    first_seen   INTEGER NOT NULL,
    refreshed_at INTEGER,
    gone         INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS twitch_streams (
    stream_id   TEXT NOT NULL,          -- the past broadcast's video id, or "live:" + the stream id
    appid       INTEGER NOT NULL,
    user_id     TEXT NOT NULL,
    title       TEXT,
    started     INTEGER,
    views       INTEGER,                -- the video's views, or viewers when seen live
    duration    INTEGER,                -- seconds (past broadcasts only)
    language    TEXT,
    found_at    INTEGER NOT NULL,
    PRIMARY KEY (stream_id, appid)
);
CREATE INDEX IF NOT EXISTS twitch_streams_user ON twitch_streams (user_id);
"""


class TwitchError(Exception):
    def __init__(self, status: int | str, where: str):
        super().__init__(f"{where}: {status}")
        self.status = status


# transport(method, url, headers, body) -> (status, body bytes). Tests pass a fake one.
Transport = Callable[[str, str, dict, Optional[bytes]], tuple[int, bytes]]


def urllib_transport(method: str, url: str, headers: dict, body: bytes | None) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as res:
            return res.status, res.read(8_000_000)
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.read(64 * 1024) if error.fp else b""


def iso_time(text: str | None) -> int | None:
    if not text:
        return None
    try:
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def duration(text: str | None) -> int | None:
    """Twitch's "3h2m1s" -> 10921."""
    total, number = 0, ""
    for ch in text or "":
        if ch.isdigit():
            number += ch
        elif ch in "hms" and number:
            total += int(number) * {"h": 3600, "m": 60, "s": 1}[ch]
            number = ""
        else:
            return None
    return total or None


class Twitch:
    def __init__(self, client_id: str, secret: str, transport: Transport | None = None,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.time):
        self.client_id, self.secret = client_id, secret
        self.transport = transport or urllib_transport
        self.sleep, self.clock = sleep, clock
        self.token: str | None = None
        self.calls = 0

    def _token(self) -> str:
        if not self.token:
            form = urllib.parse.urlencode({"client_id": self.client_id, "client_secret": self.secret,
                                           "grant_type": "client_credentials"}).encode()
            status, body = self.transport("POST", TOKEN_URL, {"User-Agent": USER_AGENT,
                                                              "Content-Type": "application/x-www-form-urlencoded"}, form)
            if status != 200:
                raise TwitchError(status, "app token")
            self.token = json.loads(body)["access_token"]
        return self.token

    def get(self, path: str, params: list[tuple[str, str]]) -> dict:
        """One Helix call. A 401 gets a new token and one more try; 429 waits a minute and tries again."""
        url = f"{HELIX}/{path}?{urllib.parse.urlencode(params)}"
        for attempt in range(3):
            if self.calls >= MAX_CALLS:
                raise TwitchError("call budget used", path)
            self.calls += 1
            self.sleep(PACE)
            headers = {"Client-Id": self.client_id, "Authorization": f"Bearer {self._token()}", "User-Agent": USER_AGENT}
            try:
                status, body = self.transport("GET", url, headers, None)
            except (urllib.error.URLError, OSError) as error:
                raise TwitchError(f"network error ({type(error).__name__})", path) from None
            if status == 401 and attempt == 0:
                self.token = None
                continue
            if status == 429 and attempt < 2:
                self.sleep(60)
                continue
            if status != 200:
                raise TwitchError(status, path)
            return json.loads(body.decode("utf-8", errors="replace"))
        raise TwitchError("gave up", path)

    def categories(self, names: list[str]) -> dict[str, str]:
        """{normalized Steam name: Twitch category id} for the names Twitch has a category for."""
        out: dict[str, str] = {}
        for start in range(0, len(names), 100):
            data = self.get("games", [("name", n) for n in names[start:start + 100]]).get("data") or []
            for g in data:
                out[games_mod.normalize(g.get("name"))] = g["id"]
        return out

    def broadcasts(self, game_id: str) -> list[dict]:
        """The category's past broadcasts this month, newest first (one page of 100)."""
        return self.get("videos", [("game_id", game_id), ("type", "archive"), ("period", "month"),
                                   ("sort", "time"), ("first", "100")]).get("data") or []

    def live(self, game_id: str) -> list[dict]:
        return self.get("streams", [("game_id", game_id), ("first", "100")]).get("data") or []

    def users(self, ids: list[str]) -> list[dict]:
        out: list[dict] = []
        for start in range(0, len(ids), 100):
            out += self.get("users", [("id", i) for i in ids[start:start + 100]]).get("data") or []
        return out

    def followers(self, user_id: str) -> int | None:
        total = self.get("channels/followers", [("broadcaster_id", user_id), ("first", "1")]).get("total")
        return int(total) if isinstance(total, int) else None


def ensure(db) -> None:
    db.executescript(SCHEMA)


class TwitchCollector:
    def __init__(self, store, twitch: Twitch, steam_db: str, own_appids: tuple[int, ...], min_reviews: int,
                 max_reviews: int, own_studio: str, max_price: int, research_days: int = 30,
                 clock: Callable[[], float] = time.time):
        self.store, self.twitch, self.clock = store, twitch, clock
        self.steam_db, self.own_appids = steam_db, own_appids
        self.limits = (min_reviews, max_reviews, own_studio, max_price)
        self.research_days = research_days
        self.summary = {"games": 0, "streams": 0, "new_streamers": 0, "streamers_read": 0, "calls": 0}
        ensure(store.db)

    def run(self, max_games: int | None = None) -> dict:
        try:
            self._categories()
            self._search(max_games)
            self._read_streamers()
        except TwitchError as error:
            log.warning("Twitch stopped this run: %s", error)
        self.summary["calls"] = self.twitch.calls
        log.info("twitch: %(games)d games, %(streams)d broadcasts, %(new_streamers)d new streamers, "
                 "%(streamers_read)d streamers read, %(calls)d calls", self.summary)
        return self.summary

    def _games(self) -> list[games_mod.Game]:
        mn, mx, studio, price = self.limits
        return [g for g in games_mod.read(self.steam_db, self.own_appids, mn, mx, studio, price)
                if games_mod.searchable(g.name)]

    def _categories(self) -> None:
        """Looks up the Twitch category of games not looked up yet (or not found a while ago), best first."""
        now = int(self.clock())
        db = self.store.db
        known = {r[0]: r for r in db.execute("SELECT appid, game_id, checked_at FROM twitch_games")}
        todo = [g for g in self._games()
                if g.appid not in known or (known[g.appid][1] is None and known[g.appid][2] < now - NOT_ON_TWITCH_DAYS * DAY)]
        todo = todo[:500]  # 5 calls; the rest next hour
        if not todo:
            return
        found = self.twitch.categories([g.name for g in todo])
        with db:
            for g in todo:
                gid = found.get(games_mod.normalize(g.name))
                db.execute("""INSERT INTO twitch_games (appid, game_id, name, checked_at, due_at) VALUES (?, ?, ?, ?, ?)
                              ON CONFLICT(appid) DO UPDATE SET game_id = excluded.game_id, name = excluded.name,
                                  checked_at = excluded.checked_at""", (g.appid, gid, g.name, now, now))

    def _search(self, max_games: int | None) -> None:
        now = int(self.clock())
        db = self.store.db
        order = {g.appid: (i, g.own) for i, g in enumerate(self._games())}
        due = [r for r in db.execute("SELECT appid, game_id FROM twitch_games WHERE game_id IS NOT NULL AND COALESCE(due_at, 0) <= ?",
                                     (now,)) if r[0] in order]
        due.sort(key=lambda r: order[r[0]][0])
        for appid, game_id in due:
            if max_games is not None and self.summary["games"] >= max_games:
                return
            if self.twitch.calls > MAX_CALLS - 250:  # leave room to read the new streamers
                return
            rows = []
            for v in self.twitch.broadcasts(game_id):
                if v.get("user_id"):
                    rows.append((v["id"], appid, v["user_id"], v.get("user_login"), v.get("user_name"), v.get("title"),
                                 iso_time(v.get("created_at")), v.get("view_count"), duration(v.get("duration")), v.get("language")))
            for s in self.twitch.live(game_id):
                if s.get("user_id"):
                    rows.append((f"live:{s['id']}", appid, s["user_id"], s.get("user_login"), s.get("user_name"), s.get("title"),
                                 iso_time(s.get("started_at")), s.get("viewer_count"), None, s.get("language")))
            every = OWN_EVERY_DAYS if order[appid][1] else self.research_days
            with db:
                for sid, a, uid, login, name, title, started, views, dur, lang in rows:
                    self.summary["new_streamers"] += db.execute(
                        "INSERT OR IGNORE INTO twitch_channels (user_id, login, name, first_seen) VALUES (?, ?, ?, ?)",
                        (uid, login, name, now)).rowcount
                    db.execute("""INSERT INTO twitch_streams (stream_id, appid, user_id, title, started, views, duration, language, found_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                  ON CONFLICT(stream_id, appid) DO UPDATE SET views = MAX(COALESCE(views, 0), COALESCE(excluded.views, 0))""",
                               (sid, a, uid, title, started, views, dur, (lang or "").lower() or None, now))
                    db.execute("UPDATE twitch_channels SET last_stream = MAX(COALESCE(last_stream, 0), ?) WHERE user_id = ?",
                               (started or 0, uid))
                db.execute("UPDATE twitch_games SET searched_at = ?, due_at = ?, found = ? WHERE appid = ?",
                           (now, now + every * DAY, len(rows), appid))
            self.summary["games"] += 1
            self.summary["streams"] += len(rows)

    def _read_streamers(self) -> None:
        """New streamers, then those not read for REFRESH_DAYS: profile (100 a call) and followers (1 call each)."""
        now = int(self.clock())
        db = self.store.db
        while self.twitch.calls < MAX_CALLS - 2:
            room = min(100, MAX_CALLS - self.twitch.calls - 1)
            ids = [r[0] for r in db.execute(
                """SELECT user_id FROM twitch_channels WHERE gone = 0 AND (refreshed_at IS NULL OR refreshed_at < ?)
                   ORDER BY refreshed_at IS NOT NULL, refreshed_at LIMIT ?""", (now - REFRESH_DAYS * DAY, room))]
            if not ids:
                return
            got = {u["id"]: u for u in self.twitch.users(ids)}
            langs = dict(db.execute(
                f"""SELECT user_id, language FROM twitch_streams WHERE language IS NOT NULL AND user_id IN ({",".join("?" * len(ids))})
                    GROUP BY user_id, language ORDER BY COUNT(*)""", ids).fetchall())  # most used last, so it wins
            for uid in ids:
                u = got.get(uid)
                if not u:
                    with db:
                        db.execute("UPDATE twitch_channels SET gone = 1, refreshed_at = ? WHERE user_id = ?", (now, uid))
                    continue
                try:
                    followers = self.twitch.followers(uid)
                except TwitchError as error:
                    if error.status == "call budget used":
                        return
                    followers = None
                text = u.get("description") or ""
                with db:
                    db.execute("""UPDATE twitch_channels SET login = ?, name = ?, description = ?, kind = ?, followers = ?,
                                  language = ?, created = ?, emails = ?, links = ?, refreshed_at = ? WHERE user_id = ?""",
                               (u.get("login"), u.get("display_name"), text, u.get("broadcaster_type") or "", followers,
                                langs.get(uid), iso_time(u.get("created_at")), json.dumps(contacts.emails(text)),
                                json.dumps(contacts.links(text)), now, uid))
                self.summary["streamers_read"] += 1
