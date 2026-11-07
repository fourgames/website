"""The Twitch part against a fake Helix API: categories, broadcasts, streamers, export and campaigns."""

import json
import urllib.parse

from creators import export, outreach
from creators.db import Store
from creators.twitch import Twitch, TwitchCollector, duration, twitch_name

from .test_creators import NOW, steam_db  # noqa: F401 - the fixture


class FakeHelix:
    def __init__(self):
        self.calls = []
        self.tokens = 0
        self.expire_once = True

    def __call__(self, method, url, headers, body):
        parts = urllib.parse.urlsplit(url)
        if parts.netloc == "id.twitch.tv":
            self.tokens += 1
            return 200, json.dumps({"access_token": f"t{self.tokens}", "expires_in": 3600}).encode()
        path = parts.path.split("/helix/", 1)[1]
        q = urllib.parse.parse_qs(parts.query)
        self.calls.append((path, q))
        if self.expire_once:
            self.expire_once = False
            return 401, b"{}"
        if path == "games":
            names = {"our ice game": "g1", "frozen lake fishing": "g2"}
            data = [{"id": names[n.lower()], "name": n} for n in q["name"] if n.lower() in names]
        elif path == "videos":
            data = [{"id": "v1", "user_id": "u1", "user_login": "icy", "user_name": "Icy", "title": "ice!",
                     "created_at": "2026-11-01T10:00:00Z", "view_count": 300, "duration": "2h3m4s", "language": "de"}
                    ] if q["game_id"] == ["g1"] else []
        elif path == "streams":
            data = [{"id": "s9", "user_id": "u2", "user_login": "fisher", "user_name": "Fisher", "title": "live",
                     "started_at": "2026-11-06T09:00:00Z", "viewer_count": 40, "language": "en"}] if q["game_id"] == ["g2"] else []
        elif path == "users":
            data = [{"id": i, "login": {"u1": "icy", "u2": "fisher"}[i], "display_name": {"u1": "Icy", "u2": "Fisher"}[i],
                     "description": "biz: icy@mail.de" if i == "u1" else "youtube.com/@fisherYT", "broadcaster_type": "affiliate",
                     "created_at": "2019-01-01T00:00:00Z"} for i in q["id"]]
        elif path == "channels/followers":
            return 200, json.dumps({"total": 1200, "data": []}).encode()
        else:
            return 404, b"{}"
        return 200, json.dumps({"data": data}).encode()


def collect(tmp_path, steam_db):  # noqa: F811
    store = Store(str(tmp_path / "creators.db"))
    fake = FakeHelix()
    twitch = Twitch("id", "secret", transport=fake, sleep=lambda s: None)
    summary = TwitchCollector(store, twitch, steam_db, (1,), 30, 50_000, "Four Games", 3000, clock=lambda: NOW).run()
    return store, fake, summary


def test_twitch_name():
    assert twitch_name("A Game About Digging A Hole™") == "A Game About Digging A Hole"
    assert twitch_name("Café®  Rush") == "Café Rush"


def test_duration():
    assert duration("2h3m4s") == 7384 and duration("45s") == 45 and duration("x") is None


def test_collects_streamers_of_searched_games(tmp_path, steam_db):  # noqa: F811
    store, fake, summary = collect(tmp_path, steam_db)
    assert fake.tokens == 2  # the first token "expired" once
    assert summary["games"] == 2 and summary["streams"] == 2 and summary["new_streamers"] == 2
    cats = dict(store.db.execute("SELECT appid, game_id FROM twitch_games").fetchall())
    assert cats[1] == "g1" and cats[2] == "g2" and cats[3] is None  # Space Shooter Deluxe isn't on Twitch
    u1 = store.db.execute("SELECT * FROM twitch_channels WHERE user_id = 'u1'").fetchone()
    assert json.loads(u1["emails"]) == ["icy@mail.de"] and u1["followers"] == 1200 and u1["language"] == "de"
    u2 = store.db.execute("SELECT * FROM twitch_channels WHERE user_id = 'u2'").fetchone()
    assert json.loads(u2["links"]) == {"youtube": "@fisherYT"}
    assert store.db.execute("SELECT stream_id FROM twitch_streams WHERE user_id = 'u2'").fetchone()[0] == "live:s9"
    # Nothing due an hour later: no broadcasts read again, nobody re-read.
    again = TwitchCollector(store, Twitch("id", "s", transport=FakeHelix(), sleep=lambda s: None), steam_db, (1,), 30,
                            50_000, "Four Games", 3000, clock=lambda: NOW + 3600).run()
    assert again["games"] == 0 and again["streamers_read"] == 0


def test_export_and_campaign(tmp_path, steam_db):  # noqa: F811
    store, _, _ = collect(tmp_path, steam_db)
    # Fisher's YouTube channel is on our list, with an email.
    store.db.execute("""INSERT INTO youtube_channels (channel_id, title, handle, emails, links, first_seen, refreshed_at)
                        VALUES ('UCf', 'Fisher YT', '@fisherYT', '["fish@mail.com"]', '{}', 0, 0)""")
    store.db.commit()
    data = export.build(store, steam_db, {1}, NOW)
    tw = {s["h"]: s for s in data["streamers"]}
    assert tw["icy"]["id"] == "tw:u1" and tw["icy"]["e"] == [["icy@mail.de", "description"]] and tw["icy"]["own"]
    assert tw["icy"]["g"][0][:2] == [1, 1] and tw["icy"]["s"] == 1200 and tw["icy"]["pl"] == "tw"
    assert tw["fisher"]["e"] == [["fish@mail.com", "youtube"]] and tw["fisher"]["yt"] == "UCf"
    outreach.migrate(store)
    spec = {"appid": 1, "game": "Our Ice Game", "audience": "streamers", "from_name": "Danny", "from_email": "a@fourgames.se",
            "subject": "{game}", "body": "Hi {name}, you streamed {their_game}. {steam}\nDanny", "recipients": ["tw:u1", "tw:u2", "tw:nope"]}
    made = outreach.create_campaign(store, spec, {1: "Our Ice Game", 2: "Frozen Lake Fishing"}, {1}, NOW)
    msgs = {m["target_id"]: m for m in outreach.messages(store, made["id"])}
    assert set(msgs) == {"tw:u1", "tw:u2"} and made["skipped"] == {"no email": 1}
    assert msgs["tw:u1"]["target_kind"] == "twitch" and msgs["tw:u1"]["email"] == "icy@mail.de"
    assert msgs["tw:u1"]["language"] == "en"  # no German version given, so English
    assert msgs["tw:u2"]["email"] == "fish@mail.com" and "you streamed Frozen Lake Fishing" in msgs["tw:u2"]["body"]
