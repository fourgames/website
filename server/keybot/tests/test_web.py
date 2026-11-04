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
