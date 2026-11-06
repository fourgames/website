"""The "Tag my game" check (tagcheck.py): a fake Claude (never the real API) and a faked store page."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from gamedata import tagcheck

from .harness import STEAMID, run

ADMIN = {"GAMEDATA_ADMIN_STEAMIDS": STEAMID}
URL = "/gamedata/v1/admin/tagcheck"


class FakeStream:
    def __init__(self, message):
        self.message = message

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get_final_message(self):
        return self.message


class FakeClaude:
    def __init__(self, result):
        self.calls: list[dict] = []
        self.result = result
        self.messages = SimpleNamespace(stream=self.stream)

    def stream(self, **kwargs):
        self.calls.append(kwargs)
        content = [SimpleNamespace(type="text", text=json.dumps(self.result))]
        return FakeStream(SimpleNamespace(stop_reason="end_turn", content=content, model=tagcheck.MODEL))


ANSWER = {
    "summary": "Drop Visual Novel; add Roguelite.",
    "current": [{"tag": "tower defense", "fits": "yes", "why": "You build towers."},
                {"tag": "Visual Novel", "fits": "no", "why": "No story scenes."},
                {"tag": "Made up", "fits": "yes", "why": "not sent"}],
    "candidates": [{"tag": "Roguelite", "fits": "sure", "why": "Runs reset."}],
}


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")


def send(w, cookie, body):
    return w.client.post(URL, headers=w.page(cookie), json=body)


def test_check_with_a_given_description(tmp_path, key):
    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        fake = FakeClaude(ANSWER)
        w.app[tagcheck.TAGCHECK].client = fake
        response = await send(w, cookie, {"name": "Reforge Front", "about": "An FPS tower defense with goblins.",
                                          "tags": ["Tower Defense", "Visual Novel", "Tower Defense"],
                                          "candidates": ["Roguelite", "visual novel", "Co-op"]})
        assert response.status == 200, await response.text()
        out = await response.json()
        assert out["source"] == "given" and out["model"] == tagcheck.MODEL
        assert out["current"] == [{"tag": "Tower Defense", "fits": "yes", "why": "You build towers."},
                                  {"tag": "Visual Novel", "fits": "no", "why": "No story scenes."}], \
            "only the tags sent, deduplicated, in order, matched ignoring case"
        assert [c["tag"] for c in out["candidates"]] == ["Roguelite", "Co-op"], "a suggestion it already has is dropped"
        assert [c["fits"] for c in out["candidates"]] == ["maybe", "maybe"], "a bad or missing verdict is maybe"
        call = fake.calls[0]
        assert call["model"] == "claude-haiku-5-5"
        assert call["output_config"]["format"]["schema"] is tagcheck.SCHEMA
        assert "goblins" in call["messages"][0]["content"] and "Tower Defense, Visual Novel" in call["messages"][0]["content"]
    run(tmp_path, steps, **ADMIN)


def test_check_reads_the_store_page(tmp_path, key, monkeypatch):
    asked = []

    async def fake_about(appid):
        asked.append(appid)
        return "From the store."
    monkeypatch.setattr(tagcheck, "fetch_about", fake_about)

    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        fake = FakeClaude(ANSWER)
        w.app[tagcheck.TAGCHECK].client = fake
        response = await send(w, cookie, {"appid": 2807130, "name": "Reforge Front", "tags": ["Tower Defense"], "candidates": []})
        assert response.status == 200, await response.text()
        assert (await response.json())["source"] == "store" and asked == [2807130]
        assert "From the store." in fake.calls[0]["messages"][0]["content"]
    run(tmp_path, steps, **ADMIN)


def test_store_html_becomes_plain_text():
    assert tagcheck.plain("<p>Build &amp; defend.</p><ul><li>Goblins</li><li>Towers</li></ul>") == "Build & defend.\nGoblins\nTowers"


def test_bad_requests_and_no_key(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        response = await w.client.post(URL, headers=w.page(), json={"name": "x", "tags": ["A"], "candidates": []})
        assert response.status == 401
        for body in ({"name": "x", "tags": [], "candidates": []}, {"name": "", "tags": ["A"], "candidates": []},
                     {"name": "x", "tags": ["A"] * 21, "candidates": []}, {"name": "x", "tags": ["A"], "candidates": [], "extra": 1},
                     {"name": "x", "appid": "12", "tags": ["A"], "candidates": []}):
            response = await send(w, cookie, body)
            assert response.status == 400, body
        response = await send(w, cookie, {"name": "x", "about": "y", "tags": ["A"], "candidates": []})
        assert response.status == 503 and (await response.json())["error"] == "claude_not_configured"
    run(tmp_path, steps, **ADMIN)
