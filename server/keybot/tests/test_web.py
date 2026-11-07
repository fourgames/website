"""The web routes the status page relies on (no network beyond localhost)."""

import asyncio

from aiohttp.test_utils import TestClient, TestServer

from keybot.web import build_app


async def get_health(path: str):
    async with TestClient(TestServer(build_app(object()))) as client:
        response = await client.get(path, headers={"Origin": "https://status.fourgames.se"})
        return response.status, response.headers, await response.json()


def test_health_allows_the_status_page():
    for path in ("/health", "/keybot/health"):
        status, headers, body = asyncio.run(get_health(path))
        assert status == 200
        assert body["ok"] is True and isinstance(body["time"], int)
        assert headers["Access-Control-Allow-Origin"] == "https://status.fourgames.se"
        assert headers["Cache-Control"] == "no-store"


# The verify pages: the explanation page first, then Discord's login.

import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from keybot.config import Config
from keybot.db import Store
from keybot.state import sign_state

from .test_handout_flow import ENV


def verify_bot(tmp_path):
    config = Config.from_env({**ENV, "DB_PATH": str(tmp_path / "keys.db")})
    store = Store(config.db_path)
    game, _ = store.add_game("Pomo <Valley>")
    return SimpleNamespace(config=config, store=store), game


def link(bot, game, now=None):
    now = time.time() if now is None else now
    token, state = sign_state(bot.config.state_secret, 5, game["id"], now)
    bot.store.save_state(state.nonce, 5, game["id"], state.expires_at, int(now))
    return token


async def fetch(bot, path, **params):
    async with TestClient(TestServer(build_app(bot))) as client:
        response = await client.get(path, params=params, allow_redirects=False)
        return response.status, response.headers, await response.text()


def test_verify_explains_before_sending_to_discord(tmp_path):
    bot, game = verify_bot(tmp_path)
    token = link(bot, game)
    for prefix in ("", "/keybot"):
        status, headers, body = asyncio.run(fetch(bot, f"{prefix}/verify", state=token))
        assert status == 200 and headers["Cache-Control"] == "no-store"
        assert "Pomo &lt;Valley&gt;" in body  # escaped
        assert "We never see" in body and "Continue with Discord" in body
        assert f'href="login?state={token}"' in body
        assert "expires in 15 minutes" in body


def test_login_goes_to_discord_with_the_same_state(tmp_path):
    bot, game = verify_bot(tmp_path)
    token = link(bot, game)
    status, headers, _ = asyncio.run(fetch(bot, "/keybot/login", state=token))
    assert status == 302
    target = urlsplit(headers["Location"])
    assert target.netloc == "discord.com"
    query = parse_qs(target.query)
    assert query["state"] == [token] and query["scope"] == ["identify connections"]
    assert query["redirect_uri"] == [bot.config.redirect_uri]


def test_old_or_used_links_get_a_clear_page(tmp_path):
    bot, game = verify_bot(tmp_path)
    old = link(bot, game, now=time.time() - 3600)
    for path in ("/verify", "/login"):
        status, _, body = asyncio.run(fetch(bot, path, state=old))
        assert status == 400 and "This link has expired" in body
    used = link(bot, game)
    bot.store.use_state(parse_used(used))
    status, _, body = asyncio.run(fetch(bot, "/verify", state=used))
    assert status == 400 and "already used" in body


def parse_used(token):
    from keybot.state import verify_state
    return verify_state(ENV["STATE_SECRET"], token).nonce


def test_result_pages_show_how_it_went():
    from keybot.web import page
    assert 'class="status success"' in page("Verified — check your DMs", "x").text
    assert 'class="status pending"' in page("Sent for review", "x").text
    assert 'class="status info"' in page("Cancelled", "x").text
    assert 'class="status pending"' in page("Verified, but we couldn't DM you", "x").text
    assert 'class="status info"' in page("This link has expired", "x", 400).text
    assert 'class="status problem"' in page("Something went wrong", "x", 500).text
