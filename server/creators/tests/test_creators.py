"""The creator collector against a fake YouTube and a small steam.db: no request leaves the machine."""

import json
import sqlite3
import urllib.parse
from datetime import datetime, timezone

import pytest

from steamdata.db import Store as SteamStore
from steamdata.net import Http

from creators import contacts
from creators.collector import Collector, quota_day
from creators.config import Config, ConfigError, read_own_appids
from creators.db import Store
from creators.games import normalize, read, searchable
from creators.youtube import YouTube, duration, mentions

# 2026-11-06 12:00 UTC = 04:00 Pacific
NOW = datetime(2026, 11, 6, 12, tzinfo=timezone.utc).timestamp()


def test_emails_plain_and_obfuscated():
    text = ("Business: Hello@Creator.TV\nalt: bob [at] gmail [dot] com, carl(at)mail.se, "
            "dana at proton dot me. icon@2x.png noreply@youtube.com")
    assert contacts.emails(text) == ["hello@creator.tv", "bob@gmail.com", "carl@mail.se", "dana@proton.me"]
    assert contacts.emails("meet me at noon dot") == []
    assert contacts.emails(None) == []


def test_links():
    text = "https://twitch.tv/SomeStreamer https://x.com/intent/foo https://twitter.com/real_one tiktok.com/@tok"
    assert contacts.links(text) == {"twitch": "SomeStreamer", "x": "real_one", "tiktok": "tok"}


def test_names():
    assert normalize("Café™: Rush!") == "cafe rush"
    assert not searchable("Dig") and not searchable("2048") and searchable("Pomo Valley")


def test_mentions_whole_words():
    video = {"snippet": {"title": "Playing POMO VALLEY for the first time!", "categoryId": "24"}}
    assert mentions("Pomo Valley", video)
    assert not mentions("Pomo Val", video)
    desc = {"snippet": {"title": "cozy games", "description": "featuring Pomo Valley", "categoryId": "20"}}
    assert mentions("Pomo Valley", desc)
    assert not mentions("Pomo Valley", {"snippet": {**desc["snippet"], "categoryId": "22"}})


def test_duration():
    assert duration("PT1H2M3S") == 3723 and duration("PT45S") == 45 and duration("P1D") == 86400
    assert duration("") is None


def test_quota_day_is_pacific():
    day, part = quota_day(NOW)
    assert day == "2026-11-06" and abs(part - 4 / 24) < 1e-6


def test_config(tmp_path):
    games = tmp_path / "games.js"
    games.write_text("export const GAMES = [{ appId: 111, x: 1 }, { appId: 222 }, { appId: 111 }];")
    assert read_own_appids(str(games)) == (111, 222)
    c = Config.from_env({"OWN_APPIDS": "5, 6", "DAILY_UNITS": "3000"})
    assert c.own_appids == (5, 6) and c.daily_units == 3000
    with pytest.raises(ConfigError):
        Config.from_env({"DAILY_UNITS": "lots"})


@pytest.fixture
def steam_db(tmp_path):
    path = str(tmp_path / "steam.db")
    SteamStore(path).close()
    db = sqlite3.connect(path)
    apps = [  # appid, name, reviews, tags
        (1, "Our Ice Game", 40, [1, 2, 3]),
        (2, "Frozen Lake Fishing", 500, [1, 2, 3, 4]),
        (3, "Space Shooter Deluxe", 900, [7, 8, 9]),
        (4, "Dig", 5000, [1, 2]),          # too short a name to search
        (5, "Quiet Little Game", 5, [1]),  # too few reviews
        (6, "Giant Shooter", 900_000, [7]),  # too many: channels too big for us
        (7, "Our Other Game", 2, [1, 2]),  # ours by studio name, despite few reviews
    ]
    for appid, name, reviews, tags in apps:
        studio = json.dumps(["Four Games"] if appid == 7 else ["Someone"])
        db.execute("INSERT INTO apps (appid, name, type, first_seen, reviews, tags, coming_soon, developers, publishers) "
                   "VALUES (?, ?, 'game', 0, ?, ?, 0, ?, ?)", (appid, name, reviews, json.dumps(tags), studio, studio))
        db.execute("INSERT INTO app_daily (day, appid, reviews) VALUES (100, ?, ?)", (appid, reviews // 2))
        db.execute("INSERT INTO app_daily (day, appid, reviews) VALUES (128, ?, ?)", (appid, reviews))
    db.commit()
    db.close()
    return path


def test_game_order(steam_db):
    games = read(steam_db, (1,), 30)
    assert [g.appid for g in games] == [1, 7, 4, 2, 3]  # ours, then activity lifted by shared tags
    assert games[3].gain == 250


class FakeYouTube:
    """Answers search, videos and channels like the Data API, from a few made-up videos."""

    def __init__(self):
        self.calls = []
        self.videos = {
            "v1": ("UCa", "Our Ice Game is wild", "20"),
            "v2": ("UCb", "frozen lake fishing gameplay", "20"),
            "v3": ("UCb", "unrelated vlog", "22"),
            "v4": ("UCc", "Frozen Lake Fishing #2", "20"),
        }
        self.quota_left = 10 ** 6

    def __call__(self, url, headers, timeout):
        parts = urllib.parse.urlsplit(url)
        q = dict(urllib.parse.parse_qsl(parts.query))
        kind = parts.path.rsplit("/", 1)[-1]
        self.calls.append((kind, q))
        cost = 100 if kind == "search" else 1
        if self.quota_left < cost:
            return 403, {}, b'{"error": {"errors": [{"reason": "quotaExceeded"}]}}'
        self.quota_left -= cost
        if kind == "search":
            name = q["q"].strip('"').lower()
            hits = [vid for vid, (_, title, _) in self.videos.items() if name.split()[0] in title.lower()]
            hits += ["v3"] if "frozen" in name else []
            body = {"items": [{"id": {"videoId": v}} for v in hits]}
        elif kind == "videos":
            body = {"items": [{"id": v, "snippet": {"channelId": c, "channelTitle": c, "title": t, "categoryId": cat,
                                                    "publishedAt": "2026-11-01T10:00:00Z"},
                               "statistics": {"viewCount": "1234"}, "contentDetails": {"duration": "PT10M"}}
                              for v in q["id"].split(",") for c, t, cat in [self.videos[v]]]}
        else:
            body = {"items": [{"id": c, "snippet": {"title": f"Channel {c}", "customUrl": f"@{c.lower()}",
                                                    "description": f"business: {c.lower()}@mail.com twitch.tv/{c}x",
                                                    "publishedAt": "2015-01-01T00:00:00Z"},
                               "statistics": {"subscriberCount": "5000", "videoCount": "300", "viewCount": "1"}}
                              for c in q["id"].split(",") if c != "UCc"]}  # UCc is gone
        return 200, {}, json.dumps(body).encode()


def make(tmp_path, steam_db, fake, **cfg):
    config = Config(db_path=str(tmp_path / "creators.db"), steam_db=steam_db, youtube_api_key="k",
                    own_appids=(1,), **cfg)
    store = Store(config.db_path)
    return Collector(config, store, YouTube(Http("t", transport=fake), "k"), clock=lambda: NOW), store


def test_run_collects_channels_and_emails(tmp_path, steam_db):
    fake = FakeYouTube()
    collector, store = make(tmp_path, steam_db, fake)
    summary = collector.run(spend_all=True)
    assert summary["searches"] == 4  # 1, 7, 2 and 3; "Dig", the 5-review and the giant game are skipped
    kept = {(r[0], r[1]) for r in store.db.execute("SELECT video_id, appid FROM youtube_videos")}
    assert kept == {("v1", 1), ("v2", 2), ("v4", 2)}  # v3 doesn't name the game
    b = store.db.execute("SELECT * FROM youtube_channels WHERE channel_id = 'UCb'").fetchone()
    assert json.loads(b["emails"]) == ["ucb@mail.com"] and json.loads(b["links"]) == {"twitch": "UCbx"}
    assert b["subscribers"] == 5000 and b["handle"] == "@ucb"
    assert store.db.execute("SELECT gone FROM youtube_channels WHERE channel_id = 'UCc'").fetchone()[0] == 1
    search = [q for kind, q in fake.calls if kind == "search"][0]
    assert search["q"] == '"Our Ice Game"' and search["publishedAfter"] == "2026-05-10T12:00:00Z"
    # Everything is due later now: a second run searches nothing.
    again, _ = make(tmp_path, steam_db, fake)
    assert again.run(spend_all=True)["searches"] == 0
    due = dict(store.db.execute("SELECT appid, due_at - searched_at FROM searches").fetchall())
    assert due == {1: 7 * 86400, 7: 7 * 86400, 2: 30 * 86400, 3: 30 * 86400}


def test_units_are_spread_over_the_day(tmp_path, steam_db):
    fake = FakeYouTube()
    # 4 a.m. Pacific: 5/24 of 2,400 = 500 units, enough for four searches but the steam.db has three.
    collector, store = make(tmp_path, steam_db, fake, daily_units=2400)
    assert collector.allowed(False) == ("2026-11-06", 500)
    collector, store = make(tmp_path, steam_db, fake, daily_units=1000)  # 209 units: two searches
    assert collector.run()["searches"] == 2
    assert store.units_spent("2026-11-06")[0] <= 209


def test_quota_exceeded_stops_for_the_day(tmp_path, steam_db):
    fake = FakeYouTube()
    fake.quota_left = 150
    collector, store = make(tmp_path, steam_db, fake)
    assert collector.run(spend_all=True)["searches"] == 1
    assert store.units_spent("2026-11-06")[1] is True
    later, _ = make(tmp_path, steam_db, fake)
    calls = len(fake.calls)
    later.run(spend_all=True)
    assert len(fake.calls) == calls
