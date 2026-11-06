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
        (8, "New AAA Shooter", 4000, [7]),  # $70: skipped
    ]
    for appid, name, reviews, tags in apps:
        studio = json.dumps(["Four Games"] if appid == 7 else ["Someone"])
        db.execute("INSERT INTO apps (appid, name, type, first_seen, reviews, tags, coming_soon, developers, publishers, price) "
                   "VALUES (?, ?, 'game', 0, ?, ?, 0, ?, ?, ?)",
                   (appid, name, reviews, json.dumps(tags), studio, studio, 6999 if appid == 8 else 999))
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


def test_reveal_queue_and_save(tmp_path):
    from creators import reveal
    store = Store(str(tmp_path / "c.db"))
    t = int(NOW)
    rows = [  # id, subscribers, public emails, last video days ago, appid
        ("UCbig", 2_000_000, "[]", 1, 10), ("UCmid", 50_000, "[]", 40, 10), ("UCactive", 20_000, "[]", 2, 10),
        ("UCours", 500, "[]", 90, 99), ("UCpublic", 30_000, '["a@b.com"]', 1, 10)]
    for cid, subs, emails, ago, appid in rows:
        store.db.execute("INSERT INTO youtube_channels (channel_id, handle, subscribers, emails, first_seen) VALUES (?,?,?,?,?)",
                         (cid, "@" + cid.lower(), subs, emails, t))
        store.db.execute("INSERT INTO youtube_videos (video_id, appid, channel_id, published, found_at) VALUES (?,?,?,?,?)",
                         ("v" + cid, appid, cid, t - ago * 86400, t))
    store.db.commit()
    assert reveal.to_check(store, {99}, NOW, 10) == ["UCours", "UCactive", "UCmid", "UCbig"]
    lines = ['{"channel_id": "UCours", "button": true}', '{"channel_id": "UCactive", "button": true}',
             '{"channel_id": "UCmid", "button": false}', 'junk', '{"channel_id": "UCnope", "button": true}']
    assert reveal.save(store, lines, NOW) == {"button": 2, "no button": 1, "revealed": 0, "nothing shown": 0, "links": 0, "skipped": 2}
    assert reveal.to_check(store, {99}, NOW, 10) == ["UCbig"]
    queue = reveal.to_reveal(store, {99}, NOW, 10)
    assert [r["channel_id"] for r in queue] == ["UCours", "UCactive"] and queue[0]["own"]
    assert queue[0]["url"] == "https://www.youtube.com/@ucours/about"
    counts = reveal.save(store, ['{"channel_id": "UCours", "email": " Biz@Ours.COM "}',
                                 '{"channel_id": "UCactive", "email": "not an email"}'], NOW)
    assert counts["revealed"] == 1 and counts["skipped"] == 1
    assert store.db.execute("SELECT revealed_email FROM youtube_channels WHERE channel_id='UCours'").fetchone()[0] == "biz@ours.com"
    assert [r["channel_id"] for r in reveal.to_reveal(store, {99}, NOW, 10)] == ["UCactive"]
    reveal.save(store, ['{"channel_id": "UCactive", "email": null}'], NOW)
    assert reveal.to_reveal(store, {99}, NOW, 10) == []


def test_urls_and_followable():
    from creators.sites import followable
    text = "Biz: https://mysite.com/contact. Links: linktr.ee/somebody, (https://twitch.tv/x) www.beacons.ai/me!"
    assert contacts.urls(text) == ["https://mysite.com/contact", "https://twitch.tv/x",
                                   "https://linktr.ee/somebody", "https://www.beacons.ai/me"]
    assert followable("https://linktr.ee/somebody") and followable("https://sarahsunstone.store")
    for url in ("https://twitch.tv/x", "https://www.youtube.com/@a", "https://amazon.de/dp/1", "https://smile.amazon.com",
                "https://discord.gg/abc", "https://bit.ly/m/x", "ftp://a.com", "https://localhost/"):
        assert not followable(url), url


def test_page_emails():
    from creators.sites import page_emails
    page = ('<a href="mailto:Biz%40Creator.com?subject=hi">mail</a> privacy@linktr.ee me@linktr.ee '
            'your@email.com 123@sentry.wixpress.com other [at] gmail [dot] com')
    assert page_emails(page, "linktr.ee") == ["biz@creator.com", "other@gmail.com"]


def test_follower(tmp_path):
    from creators import reveal
    from creators.sites import Follower
    store = Store(str(tmp_path / "c.db"))
    t = int(NOW)
    for cid, desc in (("UCa", "Find me: linktr.ee/aaa and https://twitch.tv/aaa"), ("UCb", "My site https://bbb.com"),
                      ("UCc", "mail: c@c.com https://ccc.com")):
        store.db.execute("INSERT INTO youtube_channels (channel_id, description, emails, first_seen, email_button) "
                         "VALUES (?, ?, ?, ?, 1)", (cid, desc, '["c@c.com"]' if cid == "UCc" else "[]", t))
    store.db.commit()
    assert reveal.save(store, ['{"channel_id": "UCb", "links": ["bbb.com", "throne.com/b"]}'], NOW)["links"] == 2
    pages = {"https://linktr.ee/aaa": '<a href="mailto:aaa@gmail.com">x</a>',
             "https://bbb.com": '<a href="/contact-us">Contact</a><a href="https://other.com/contact">x</a>',
             "https://bbb.com/contact-us": "Business: hello@bbb.com"}
    asked = []

    def transport(url, headers, timeout):
        asked.append(url)
        return (200, {"content-type": "text/html; charset=utf-8"}, pages[url].encode(), url) if url in pages \
            else (404, {}, b"", url)

    counts = Follower(store, transport, pause=0).run(set(), 50, NOW)
    assert counts["with email"] == 2 and counts["skipped"] >= 2  # twitch and throne
    assert "https://ccc.com" not in asked and "https://other.com/contact" not in asked  # UCc has an email; other site
    found = dict(store.db.execute("SELECT channel_id, email FROM site_emails").fetchall())
    assert found == {"UCa": "aaa@gmail.com", "UCb": "hello@bbb.com"}
    assert reveal.to_reveal(store, set(), NOW, 10) == []  # no captcha needed for them
    assert Follower(store, transport, pause=0).run(set(), 50, NOW)["followed"] == 0  # nothing due again
