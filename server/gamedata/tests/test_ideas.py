"""The owner's game ideas (ideas.py): saved, scored by a fake Claude (never the real API), re-scored,
edited, archived and deleted, and the daily market score worked out from the market files."""

from __future__ import annotations

import gzip
import json
import math
from types import SimpleNamespace

import pytest

from gamedata import ideas

from .harness import STEAMID, run

ADMIN = {"GAMEDATA_ADMIN_STEAMIDS": STEAMID}
BASE = "/gamedata/v1/admin/ideas"
TODAY = 20762  # 2026-11-05

# Two strong tags, one weak, one too small to rate (only in overview).
TAGS = [
    {"tag": 1, "name": "Extraction Shooter", "releases": 80, "releasesYearAgo": 40, "supply": 1.0, "hitRate": 0.198,
     "hitRateRaw": 0.25, "hitGames": 60, "hits": 15, "hitLift": 2.0, "demand": 2.0, "heat": 2.0,
     "medianReviews": 40, "topReviews": 900},
    {"tag": 2, "name": "Roguelite", "releases": 400, "releasesYearAgo": 200, "supply": 2.0, "hitRate": 0.099,
     "hitRateRaw": 0.1, "hitGames": 300, "hits": 30, "hitLift": 1.0, "demand": None, "heat": 1.4,
     "medianReviews": 4, "topReviews": 200},
    {"tag": 3, "name": "Visual Novel", "releases": 500, "releasesYearAgo": 500, "supply": 0.5, "hitRate": 0.0495,
     "hitRateRaw": 0.03, "hitGames": 400, "hits": 12, "hitLift": 0.5, "demand": 0.5, "heat": 0.5,
     "medianReviews": 1, "topReviews": 30},
]
TRENDS = {"supplyWindow": 90, "hitRateWindow": [14, 180], "baseHitRate": 0.099, "priorGames": 30,
          "baseMedianReviews": 4, "releasesNow": 10000, "releasesYearAgo": 5000, "tags": TAGS, "alerts": []}
OVERVIEW = {"builtAt": 1793903934, "today": TODAY, "tags": {"1": "Extraction Shooter", "2": "Roguelite",
                                                            "3": "Visual Novel", "4": "Dwarf"}}
COLUMNS = ["appid", "name", "day", "price", "reviews", "pos", "tags", "flags", "langs", "hit", "gain7", "gain28", "players"]


def games(rows):
    return {"columns": COLUMNS, "topTags": 5, "flags": {}, "rows": rows}


def write_market(path, trends=TRENDS, overview=OVERVIEW, rows=()):
    path.mkdir(exist_ok=True)
    for name, data in (("trends", trends), ("overview", overview), ("games", games(list(rows))),
                       ("growth", {"years": [2025, 2026], "yearDone": 0.85, "total": {"y": [20155, 25484]},
                                   "users": {"y": [41666455, 41816052]}})):
        (path / f"{name}.json.gz").write_bytes(gzip.compress(json.dumps(data).encode()))
    ideas._cache.clear()


def answer(**changes):
    out = {
        "tags": [{"id": 1, "name": "Extraction Shooter", "why": "core loop"},
                 {"id": 2, "name": "Roguelite", "why": "runs"},
                 {"id": 999, "name": "Made up", "why": "not a tag"}],
        "score": 72,
        "subscores": [{"key": "timing", "score": 80, "reason": "demand doubled"},
                      {"key": "demand", "score": 85, "reason": "hit rate 20%, twice Steam's"},
                      {"key": "competition", "score": 140, "reason": "80 releases"},
                      {"key": "hit_odds", "score": 70, "reason": "median 40 reviews"},
                      {"key": "small_team_fit", "score": 40, "reason": "multiplayer is heavy"}],
        "verdict": "Strong tag, heavy scope.",
        "risks": ["Netcode", "Cheaters"],
        "pivots": [{"change": "Solo PvE extraction", "why": "Roguelite pairs well"}],
        "alternatives": [{"idea": "Extraction fishing", "why": "cozy and hits"}],
        "timing": {"advice": "now", "detail": "Supply flat, demand up", "watch": "Extraction Shooter supply over 1.5"},
    }
    out.update(changes)
    return out


class FakeStream:
    def __init__(self, message):
        self.message = message

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get_final_message(self):
        if isinstance(self.message, BaseException):
            raise self.message
        return self.message


class FakeClaude:
    """client.messages.stream(...) as the SDK has it; every call's arguments are kept."""

    def __init__(self):
        self.calls: list[dict] = []
        self.replies: list = []
        self.messages = SimpleNamespace(stream=self.stream)

    def reply(self, result=None, stop_reason="end_turn", text=None):
        content = [SimpleNamespace(type="thinking", thinking=""),
                   SimpleNamespace(type="text", text=text if text is not None else json.dumps(result or answer()))]
        self.replies.append(SimpleNamespace(stop_reason=stop_reason, content=content, model=ideas.MODEL,
                                            usage=SimpleNamespace(input_tokens=5000, output_tokens=900,
                                                                  cache_read_input_tokens=0)))

    def stream(self, **kwargs):
        self.calls.append(kwargs)
        return FakeStream(self.replies.pop(0))


@pytest.fixture
def market(tmp_path, monkeypatch):
    monkeypatch.setenv("MARKET_DIR", str(tmp_path / "market"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.delenv("IDEAS_DB", raising=False)
    # Rated games: 20 with both tags 1 and 2 (8 hits), released inside the 14-180 day window.
    rows = [[i, f"g{i}", TODAY - 30, 999, 10, 90, [1, 2, 492], 0, 1, 95 if i < 8 else 50, None, None, None]
            for i in range(20)]
    rows.append([99, "too new", TODAY - 3, 999, 10, 90, [1, 2], 0, 1, 99, None, None, None])
    write_market(tmp_path / "market", rows=rows)
    return tmp_path / "market"


def claude_of(w) -> FakeClaude:
    fake = FakeClaude()
    w.app[ideas.IDEAS].client = fake
    return fake


def send(w, cookie, method, path, body=None):
    return w.client.request(method, path, headers=w.page(cookie), json={} if body is None else body)


# The score without Claude


def test_market_score_formula(market):
    m = ideas.Market.load()
    strong = ideas.tag_score(m.tags[1], m)
    # hit 75 (twice the base rate), crowd 50 (supply 1), demand 75 (doubled), reviews 50 + 12*log2(41/5)
    reviews = 50 + 12 * math.log2(41 / 5)
    assert strong["score"] == round(0.45 * 75 + 0.2 * 50 + 0.15 * 75 + 0.2 * reviews, 1)
    weak = ideas.tag_score(m.tags[3], m)
    assert weak["score"] < 50 < strong["score"]
    pair = ideas.best_pair([1, 2, 3], m)
    # 8 hits in 20 games (the 3-day-old one is outside the window), shrunk with 30 base-rate games.
    assert pair["tags"] == [1, 2] and pair["games"] == 20 and pair["hits"] == 8
    assert pair["hitRate"] == round((8 + 30 * 0.099) / 50, 3)
    point = ideas.market_score([1, 2], m)
    tags = (strong["score"] * 1 + ideas.tag_score(m.tags[2], m)["score"] / 1.25) / (1 + 1 / 1.25)
    assert point["score"] == round(0.7 * tags + 0.3 * pair["score"])
    assert ideas.market_score([4], m) is None, "a tag too small to rate gives no score"
    assert ideas.market_score([], m) is None


def test_the_brief_has_every_tag_on_one_line(market):
    brief = ideas.market_brief(ideas.Market.load())
    assert "1|Extraction Shooter|80|40|1.0|20%|15/60|40|900|2.00" in brief
    assert "3|Visual Novel|" in brief and "4:Dwarf" in brief
    assert "2026-11-05" in brief and "41.8M" in brief


# The routes


def test_scoring_saving_and_the_history(tmp_path, market):
    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        fake = claude_of(w)
        fake.reply()
        response = await send(w, cookie, "POST", BASE, {"text": "  An extraction shooter with dwarves  "})
        assert response.status == 201, await response.text()
        idea = (await response.json())["idea"]
        assert idea["text"] == "An extraction shooter with dwarves" and not idea["archived"]
        a = idea["analysis"]
        assert [t["id"] for t in a["tags"]] == [1, 2], "made-up tag ids are dropped"
        assert [s["key"] for s in a["subscores"]] == ideas.SUBSCORES
        assert a["subscores"][1]["score"] == 100, "scores are kept to 0-100"
        assert a["score"] == 72 and a["model"] == ideas.MODEL and a["day"] == "2026-11-05"
        assert idea["tags"] == [1, 2] and len(idea["points"]) == 1 and idea["points"][0]["day"] == "2026-11-05"

        call = fake.calls[0]
        assert call["model"] == "claude-haiku-5-5" and "fallbacks" not in call
        assert call["output_config"]["format"]["schema"] is ideas.SCHEMA
        assert "1|Extraction Shooter|" in call["system"][0]["text"]
        assert "dwarves" in call["messages"][0]["content"]

        # Re-scored: a second analysis, and Claude hears the first score.
        fake.reply(answer(score=55, tags=[{"id": 3, "name": "Visual Novel", "why": "story"}]))
        response = await send(w, cookie, "POST", f"{BASE}/{idea['id']}/score")
        assert response.status == 200, await response.text()
        again = (await response.json())["idea"]
        assert [x["score"] for x in again["analyses"]] == [72, 55]
        assert again["tags"] == [3] and again["analysis"]["score"] == 55
        assert len(again["points"]) == 1, "one point a day, worked out again from the new tags"
        assert again["points"][0]["score"] == ideas.market_score([3], ideas.Market.load())["score"]
        assert "Scored before" not in fake.calls[1]["messages"][0]["content"], "no anchoring on the old score"

        # The list, newest first; a new market day adds a point.
        fake.reply()
        await send(w, cookie, "POST", BASE, {"text": "A cozy roguelite", "notes": "jam idea"})
        listing = await (await w.client.get(BASE, headers=w.page(cookie))).json()
        assert [i["text"] for i in listing["ideas"]] == ["A cozy roguelite", "An extraction shooter with dwarves"]
        assert listing["market"]["day"] == "2026-11-05" and listing["claude"] is True
        write_market(market, overview={**OVERVIEW, "today": TODAY + 1})
        listing = await (await w.client.get(BASE, headers=w.page(cookie))).json()
        assert [p["day"] for p in listing["ideas"][1]["points"]] == ["2026-11-05", "2026-11-06"]

        # Edit, archive (archived ideas get no new points), delete.
        response = await send(w, cookie, "PUT", f"{BASE}/{idea['id']}", {"notes": "ask a netcode friend", "archived": True})
        edited = (await response.json())["idea"]
        assert edited["notes"] == "ask a netcode friend" and edited["archived"] and edited["text"].startswith("An extraction")
        write_market(market, overview={**OVERVIEW, "today": TODAY + 2})
        listing = await (await w.client.get(BASE, headers=w.page(cookie))).json()
        assert len(listing["ideas"][1]["points"]) == 2 and len(listing["ideas"][0]["points"]) == 3
        response = await send(w, cookie, "DELETE", f"{BASE}/{idea['id']}")
        assert response.status == 200
        response = await send(w, cookie, "DELETE", f"{BASE}/{idea['id']}")
        assert response.status == 404
        listing = await (await w.client.get(BASE, headers=w.page(cookie))).json()
        assert [i["text"] for i in listing["ideas"]] == ["A cozy roguelite"]
    run(tmp_path, steps, **ADMIN)
    assert (tmp_path / "data" / "ideas.db").exists(), "kept next to the rest of the data by default"


def test_a_failed_score_keeps_nothing(tmp_path, market):
    import anthropic
    import httpx2

    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        fake = claude_of(w)
        fake.reply(stop_reason="refusal", text="")
        response = await send(w, cookie, "POST", BASE, {"text": "an idea"})
        assert response.status == 502 and (await response.json())["error"] == "claude_refused"
        fake.reply(text="not json")
        response = await send(w, cookie, "POST", BASE, {"text": "an idea"})
        assert (await response.json())["error"] == "claude_bad_answer"
        fake.replies.append(anthropic.APITimeoutError(request=httpx2.Request("POST", "https://api.anthropic.com")))
        response = await send(w, cookie, "POST", BASE, {"text": "an idea"})
        assert response.status == 504 and (await response.json())["error"] == "claude_timeout"
        listing = await (await w.client.get(BASE, headers=w.page(cookie))).json()
        assert listing["ideas"] == []
    run(tmp_path, steps, **ADMIN)


def test_without_a_key_or_market(tmp_path, market, monkeypatch):
    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        monkeypatch.delenv("ANTHROPIC_API_KEY")
        response = await send(w, cookie, "POST", BASE, {"text": "an idea"})
        assert response.status == 503 and (await response.json())["error"] == "claude_not_configured"
        listing = await (await w.client.get(BASE, headers=w.page(cookie))).json()
        assert listing["claude"] is False and listing["ideas"] == []
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
        monkeypatch.setenv("MARKET_DIR", str(tmp_path / "nowhere"))
        claude_of(w)
        response = await send(w, cookie, "POST", BASE, {"text": "an idea"})
        assert response.status == 503 and (await response.json())["error"] == "market_not_built"
        listing = await (await w.client.get(BASE, headers=w.page(cookie))).json()
        assert listing["market"] is None
    run(tmp_path, steps, **ADMIN)


def test_checks_and_who_may(tmp_path, market, monkeypatch):
    monkeypatch.setenv("IDEAS_DB", str(tmp_path / "elsewhere" / "my.db"))

    async def steps(w):
        response = await w.client.get(BASE, headers=w.page())
        assert response.status == 401
        cookie = await w.sign_in(back="/fb-dash")
        response = await w.client.get(BASE, headers={"Cookie": f"fg_privacy={cookie}", "Origin": "https://evil.example"})
        assert response.status == 403
        response = await w.client.post(BASE, headers=w.page(cookie), data="text=x")
        assert response.status == 415
        for body in ({"text": ""}, {"text": "x" * 2001}, {"text": "x", "extra": 1}, {"text": 5}):
            response = await send(w, cookie, "POST", BASE, body)
            assert response.status == 400, body
        for path in (f"{BASE}/123", f"{BASE}/abc"):
            response = await send(w, cookie, "PUT", path, {"notes": "x"})
            assert response.status == 404
        fake = claude_of(w)
        fake.reply()
        idea = (await (await send(w, cookie, "POST", BASE, {"text": "x"})).json())["idea"]
        for body in ({}, {"archived": "yes"}, {"text": ""}, {"score": 99}):
            response = await send(w, cookie, "PUT", f"{BASE}/{idea['id']}", body)
            assert response.status == 400, body
        response = await w.client.options(f"{BASE}/{idea['id']}", headers=w.page())
        assert "DELETE" in response.headers["Access-Control-Allow-Methods"]
    run(tmp_path, steps, **ADMIN)
    assert (tmp_path / "elsewhere" / "my.db").exists()


def test_the_listed_tags_their_pairs_and_the_biggest_games_reach_claude(tmp_path, monkeypatch):
    """The template's Genre line is read as Steam tags; their pair's hit rate and the biggest games
    with them go into the prompt, and a listed tag Claude left out is kept."""
    rows = [[100 + i, f"Shooter {i}", TODAY - 30 - i, 999, 5000 - i if i < 3 else 2, 90, [1, 2], 0, 1, 95 if i < 4 else 10, None, None, None]
            for i in range(12)]
    write_market(tmp_path, rows=rows)
    monkeypatch.setenv("MARKET_DIR", str(tmp_path))
    m = ideas.Market.load()
    text = "Working title: Dig\nGenre (closest Steam tags): Roguelite, extraction shooter, Not A Tag\nHook: x"
    assert ideas.listed_tags(text, m) == [2, 1]
    prompt = ideas.user_prompt({"text": text}, [], m)
    assert "Roguelite + Extraction Shooter: 4 hits of 12 games" in prompt
    assert "Shooter 0 (5,000 reviews" in prompt
    kept = ideas.tidy(answer(tags=[{"id": 1, "name": "Extraction Shooter", "why": "core"}]), m, [2, 1])
    assert [t["id"] for t in kept["tags"]] == [1, 2] and kept["tags"][1]["why"] == "listed by you"
    assert ideas.user_prompt({"text": "no template here"}, [], m).count("Tag pairs") == 0


def test_pivots_that_only_restate_the_idea_are_dropped(tmp_path, monkeypatch):
    """A post-apocalyptic zombie driving game isn't told to "pivot to post-apocalyptic": Claude names the
    hook and what the idea already has first, and a pivot that only adds one of those is left out."""
    write_market(tmp_path)
    monkeypatch.setenv("MARKET_DIR", str(tmp_path))
    m = ideas.Market.load()
    kept = ideas.tidy(answer(
        hook="Physics-driven car crashes through zombie hordes",
        has=["Post-apocalyptic setting", "Zombies", "Driving", " "],
        pivots=[{"change": "Pivot to a post-apocalyptic setting", "why": "x"},
                {"change": "Add Roguelite", "why": "already a tag"},
                {"change": "Add zombies", "why": "x"},
                {"change": "Add roguelite runs between safe houses", "why": "a real change"},
                {"change": "Cut the open world to short arena levels", "why": "scope"}]), m)
    assert kept["hook"].startswith("Physics-driven") and kept["has"] == ["Post-apocalyptic setting", "Zombies", "Driving"]
    assert [p["change"] for p in kept["pivots"]] == ["Add roguelite runs between safe houses", "Cut the open world to short arena levels"]
    assert ideas.SCHEMA["required"].index("has") < ideas.SCHEMA["required"].index("pivots")
    assert "already" in ideas.SYSTEM and "hook" in ideas.SYSTEM
    assert "correlation, not cause" in ideas.SYSTEM, "tag numbers are a modest signal, not proof"

    prompt = ideas.user_prompt({"text": "zombie cars", "stars": 5}, [], m)
    assert "5 of 5 stars" in prompt and "must not move the scores" in prompt
    assert "stars" not in ideas.user_prompt({"text": "zombie cars", "stars": 0}, [], m)


def test_pinning_and_stars(tmp_path, market):
    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        claude_of(w).reply()
        idea = (await (await send(w, cookie, "POST", BASE, {"text": "zombie cars"})).json())["idea"]
        assert idea["pinned"] is False and idea["stars"] == 0
        response = await send(w, cookie, "PUT", f"{BASE}/{idea['id']}", {"pinned": True, "stars": 4})
        changed = (await response.json())["idea"]
        assert changed["pinned"] is True and changed["stars"] == 4
        for body in ({"pinned": "yes"}, {"stars": 6}, {"stars": -1}, {"stars": 2.5}, {"stars": True}):
            response = await send(w, cookie, "PUT", f"{BASE}/{idea['id']}", body)
            assert response.status == 400, body
    run(tmp_path, steps, **ADMIN)


def test_an_older_database_gets_the_ranking_columns(tmp_path):
    import sqlite3
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE ideas (id INTEGER PRIMARY KEY, text TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', "
               "archived INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL)")
    db.execute("INSERT INTO ideas (text, created, updated) VALUES ('old one', 1, 1)")
    db.commit()
    db.close()
    store = ideas.Ideas(str(path))
    assert store.get(1)["pinned"] is False and store.get(1)["stars"] == 0
    store.update(1, {"pinned": True, "stars": 3})
    assert store.get(1)["pinned"] is True and store.get(1)["stars"] == 3
    store.close()
