"""Ranking by what predicts coverage that sells: typical views, activity, genre fit with its evidence;
and the outreach parts that use it (their_game, UTM link, local hours, new vs repeat coverage)."""

import json
import sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo

from creators import coverage, export, outreach, reveal, score
from creators.db import Store
from creators.games import Game, rank, read
from creators.send import Sender, Settings
from creators.zones import zone_for

from .test_creators import NOW, steam_db  # noqa: F401 - the fixture

DAY = 86400


def add_tags(path, names):
    db = sqlite3.connect(path)
    db.executemany("INSERT INTO tags (tagid, name) VALUES (?, ?)", names)
    db.commit()
    db.close()


def test_score_basics():
    assert score.views_factor(100) == 0.05 and score.views_factor(50_000) == 1.0
    assert 0.6 <= score.views_factor(3e6) < 1
    # One upload lately (a lone Short) isn't a habit.
    assert score.activity(NOW - 2 * DAY, 1, None, NOW) == "quiet"
    assert score.activity(NOW - 2 * DAY, 8, None, NOW) == "active"
    assert score.activity(NOW - 2 * DAY, None, None, NOW) == "active"  # cadence not read yet
    assert score.activity(None, None, NOW - 100 * DAY, NOW) == "inactive"
    assert score.activity(None, None, None, NOW) == "unknown"
    # Meta tags don't count, the first tags weigh most.
    meta = {9}
    assert score.similarity([1, 2, 3], [1, 2, 3], meta) == 1.0
    assert score.similarity([9, 5], [9, 6], meta) == 0.0
    assert score.similarity([1, 7, 8], [1, 2, 3], meta) > score.similarity([3, 7, 8], [1, 2, 3], meta)
    # The same overlap is worth more with more games behind it.
    profile = [[1, 0.6], [2, 0.4]]
    w = score.tag_weights([1, 2], set())
    assert score.genre_fit(profile, w, 1) < score.genre_fit(profile, w, 6)
    assert score.performance(None, 1000) == 1 and score.performance(100_000, 1000) == 1.5 and score.performance(10, 1000) == 0.5


def test_genre_profile_weights_games_by_how_they_did():
    tags = {1: [10, 11], 2: [20, 21]}
    good, n = score.genre_profile([(1, 3, 20_000), (2, 3, 500)], tags, set(), mv=2000)
    assert n == 2 and good[0][0] == 10  # game 1's videos did 10x their typical views
    plain, _ = score.genre_profile([(1, 3, None), (2, 3, None)], tags, set(), mv=2000)
    assert dict(plain)[10] == dict(plain)[20]  # not known: even


def channel(store, cid, subs, videos, last_upload=None, u90=None, emails="[]"):
    """videos: [(appid, views, days ago, seconds)]."""
    store.db.execute("INSERT INTO youtube_channels (channel_id, handle, subscribers, emails, first_seen, last_upload, uploads_90d) "
                     "VALUES (?, ?, ?, ?, 0, ?, ?)", (cid, "@" + cid.lower(), subs, emails, last_upload, u90))
    for i, (appid, views, ago, dur) in enumerate(videos):
        store.db.execute("INSERT INTO youtube_videos (video_id, appid, channel_id, published, views, duration, found_at) "
                         "VALUES (?, ?, ?, ?, ?, ?, 0)", (f"{cid}{i}", appid, cid, NOW - ago * DAY, views, dur))


def test_hunt_ranks_by_expected_value_not_subscribers(tmp_path, steam_db):  # noqa: F811
    store = Store(str(tmp_path / "c.db"))
    recent = int(NOW - 3 * DAY)
    # Big channel, few views per video, games like ours.
    channel(store, "UCbig", 900_000, [(2, 300, 20, 900), (2, 250, 30, 900), (2, 280, 40, 900)], recent, 10)
    # Mid channel, many views per video, the same games.
    channel(store, "UCgood", 40_000, [(2, 30_000, 20, 900), (2, 25_000, 30, 900), (2, 28_000, 40, 900)], recent, 10)
    # Many views, but only games unlike ours.
    channel(store, "UCother", 40_000, [(3, 30_000, 20, 900), (3, 25_000, 30, 900)], recent, 10)
    # One of ours, small: still first.
    channel(store, "UCours", 800, [(1, 90, 20, 900)], recent, 10)
    store.db.commit()
    # Our creator first; then many views and like our games; a big channel with few views that fits
    # still beats many views on games unlike ours (no fit, no sale).
    assert reveal.to_check(store, {1}, NOW, 10, steam_db) == ["UCours", "UCgood", "UCbig", "UCother"]
    # Without the Steam tags, genre fit is even and reach decides.
    assert reveal.to_check(store, {1}, NOW, 10)[-1] == "UCbig"


def test_games_lookalikes_and_meta_tags(steam_db):  # noqa: F811
    add_tags(steam_db, [(1, "Indie"), (2, "Fishing"), (3, "Cozy"), (7, "FPS")])
    db = sqlite3.connect(steam_db)
    db.execute("INSERT INTO apps (appid, name, type, first_seen, reviews, tags, coming_soon, developers, publishers, price) "
               "VALUES (9, 'Huge Fishing Sim', 'game', 0, 400000, ?, 0, '[]', '[]', 999)", (json.dumps([2, 3, 1]),))
    db.commit()
    db.close()
    ids = [g.appid for g in read(steam_db, (1,), 30)]
    assert 9 in ids and 6 not in ids  # a big look-alike is searched; the unrelated giant shooter isn't
    assert 9 not in [g.appid for g in read(steam_db, (1,), 30, lookalike_max_reviews=100_000)]
    # Sharing only a meta tag (Indie) lifts nothing.
    games = [Game(1, "Ours", [1, 2], 10, own=True), Game(2, "Only indie", [1, 5], 100, gain=50),
             Game(3, "Fishing", [2, 5], 100, gain=50)]
    rank(games, meta={1})
    assert [g.appid for g in games] == [1, 3, 2] and games[2].similar == 0


def test_export_language_profile_engagement(tmp_path, steam_db):  # noqa: F811
    add_tags(steam_db, [(1, "Indie"), (2, "Fishing"), (3, "Cozy"), (4, "Ice")])
    store = Store(str(tmp_path / "c.db"))
    channel(store, "UCx", 100_000, [(2, 20_000, 20, 900), (2, 30_000, 30, 900), (3, 10_000, 40, 900), (5, 9000, 50, 900)],
            int(NOW - DAY), 12)
    store.db.execute("UPDATE youtube_channels SET language = 'en', refreshed_at = 1 WHERE channel_id = 'UCx'")
    store.db.execute("UPDATE youtube_videos SET language = 'de', likes = 10, comments = 2")
    store.db.commit()
    c = {c["id"]: c for c in export.build(store, steam_db, {1}, NOW)["creators"]}["UCx"]
    assert c["l"] == "de"  # most of their videos, not the channel's default setting
    assert c["u90"] == 12 and c["pn"] == 2 and c["mv"] == 15_000  # game 5 has only a meta tag: no genre evidence
    assert [x for x in c["g"] if x[0] == 2][0][4] == 25_000  # each game's typical views
    assert c["fa"] < export.FLAG_RATE  # 12 likes + comments on 10k+ views: flagged
    assert c["sm"] == 15_000 and c["smn"] == 4  # all four games have under 5,000 reviews


def test_their_game_utm_and_zone(tmp_path, steam_db):  # noqa: F811
    store = outreach.open_store(str(tmp_path / "c.db"))
    # Covered game 3 (a shooter) most, game 2 (like ours) once.
    channel(store, "UCa", 5000, [(3, 100, 20, 900), (3, 100, 30, 900), (2, 100, 40, 900)], emails='["a@a.com"]')
    store.db.execute("UPDATE youtube_channels SET title = 'A', country = 'JP' WHERE channel_id = 'UCa'")
    store.db.commit()
    spec = {"appid": 1, "game": "Our Ice Game", "audience": "creators", "from_name": "Danny", "from_email": "d@fourgames.se",
            "subject": "{game}", "body": "Hi {name}, you played {their_game}. {steam}\nDanny", "recipients": ["UCa"]}
    made = outreach.create_campaign(store, spec, {2: "Frozen Lake Fishing", 3: "Space Shooter Deluxe"}, {1}, NOW, steam_db)
    m = outreach.messages(store, made["id"])[0]
    assert "you played Frozen Lake Fishing" in m["body"]  # most like the campaign's game, not most videos
    assert f"https://store.steampowered.com/app/1/?utm_source=creators&utm_campaign=outreach-{made['id']}" in m["body"]
    assert m["zone"] == "Asia/Tokyo"
    assert zone_for(None, "de") == "Europe/Berlin" and zone_for("us", "de") == "America/Chicago" and zone_for(None, "en") is None
    # 10:00 in Stockholm is 18:00 in Tokyo: not sent now, but at 9:00 Tokyo the next morning.
    outreach.set_status(store, made["id"], "approved", NOW)
    sent = []

    class SMTP:
        def send_message(self, mail):
            sent.append(mail)

        def quit(self):
            pass

    stockholm_10 = datetime(2026, 11, 10, 10, tzinfo=ZoneInfo("Europe/Stockholm")).timestamp()
    tokyo_9 = datetime(2026, 11, 11, 9, 30, tzinfo=ZoneInfo("Asia/Tokyo")).timestamp()
    for at, want in ((stockholm_10, 0), (tokyo_9, 1)):
        s = Sender(Settings(user="u", password="p", pause=(0, 0)), store, smtp_factory=SMTP, clock=lambda at=at: at,
                   sleep=lambda x: None)
        assert s.send_due()["sent"] == want


def test_twitch_coverage_counts(tmp_path):
    store = outreach.open_store(str(tmp_path / "c.db"))
    from creators.twitch import ensure
    ensure(store.db)
    sent = int(NOW) - 5 * DAY
    store.db.execute("""INSERT INTO outreach_campaigns (id, appid, game, audience, from_name, from_email, subject, body,
                        daily_limit, status, created_at) VALUES (1, 1, 'G', 'streamers', 'D', 'd@f.se', 's', 'b', 5, 'approved', 0)""")
    for mid, uid in ((1, "u1"), (2, "u2")):
        store.db.execute("""INSERT INTO outreach_messages (id, campaign_id, target_kind, target_id, email, subject, body,
                            status, queued_at, sent_at) VALUES (?, 1, 'twitch', ?, ?, 's', 'b', 'sent', 0, ?)""",
                         (mid, f"tw:{uid}", f"{uid}@x.se", sent))
        store.db.execute("INSERT INTO twitch_channels (user_id, login, name, first_seen) VALUES (?, ?, ?, 0)", (uid, uid, uid))
    rows = [("123", "u1", sent + DAY, 300), ("live:9", "u2", sent + DAY, 40), ("100", "u2", sent - 30 * DAY, 50)]
    for sid, uid, started, views in rows:
        store.db.execute("INSERT INTO twitch_streams (stream_id, appid, user_id, started, views, found_at) VALUES (?, 1, ?, ?, ?, 0)",
                         (sid, uid, started, views))
    store.db.commit()
    found = coverage.videos_by_message(store, 1)
    assert found[1][0]["url"] == "https://www.twitch.tv/videos/123" and not found[1][0]["repeat"]
    assert found[2][0]["url"] == "https://www.twitch.tv/u2" and found[2][0]["repeat"]  # streamed it before the email
    assert coverage.totals(store, 1) == {"creators": 2, "new": 1, "repeat": 1, "videos": 2, "views": 340}
