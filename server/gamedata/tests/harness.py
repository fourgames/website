"""The test setup: the real app on aiohttp's test server, and a fake Steam (Web API and OpenID) and
a fake GitHub (for the dashboard's proxy) on other local ones. No network."""

from __future__ import annotations

import asyncio
import gzip
import io
import json
import time
import zipfile
from dataclasses import dataclass
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gamedata.config import Config
from gamedata.web import Limits, make_app

SITE = "https://fourgames.se"
APP_ID = 5207970
STEAMID = "76561198000000001"
FRIEND = "76561198000000002"
TICKET = "14000000" + "ab" * 100
PUBLISHER_KEY = "PUBLISHERKEY0123456789ABCDEF"

ENV = {
    "GAMEDATA_PEPPER": "pepper-" + "p" * 40,
    "GAMEDATA_COOKIE_SECRET": "cookie-" + "c" * 40,
    "GAMEDATA_INTERNAL_KEY": "internal-" + "i" * 40,
    "GAMEDATA_TOKEN_SECRET": "token-" + "t" * 40,
    "STEAM_PUBLISHER_KEY": PUBLISHER_KEY,
    "GAMEDATA_APP_IDS": f"{APP_ID},3958210",
    # The test machine's disk may have less than the default free.
    "GAMEDATA_MIN_FREE_MB": "0",
}

HARDWARE = {"os": "Windows 11", "cpu": "AMD Ryzen 7 5800X", "cpu_cores": 8, "ram_mb": 16384,
            "gpu": "NVIDIA GeForce RTX 3070", "gpu_driver": "560.94", "renderer": "forward_plus",
            "screen": [2560, 1440], "refresh_hz": 144, "steam_deck": False}


def config(tmp_path: Path, **overrides: str) -> Config:
    return Config.from_env({**ENV, "DATA_DIR": str(tmp_path / "data"), **overrides})


class FakeSteam:
    """Steam's AuthenticateUserTicket, CheckAppOwnership and OpenID check_authentication."""

    def __init__(self):
        # ticket -> (steamid, ownersteamid)
        self.tickets: dict[str, tuple[str, str]] = {TICKET: (STEAMID, STEAMID)}
        # (steamid, appid) -> ownsapp
        self.owns: dict[tuple[str, int], bool] = {}
        self.calls: list[tuple[str, dict[str, str]]] = []
        self.fail_status: int | None = None
        self.openid_valid = True

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/ISteamUserAuth/AuthenticateUserTicket/v1/", self.authenticate)
        app.router.add_get("/ISteamUser/CheckAppOwnership/v2/", self.ownership)
        app.router.add_post("/openid/login", self.openid)
        return app

    async def authenticate(self, request: web.Request) -> web.Response:
        params = dict(request.query)
        self.calls.append(("authenticate", params))
        if self.fail_status:
            return web.Response(status=self.fail_status)
        if params.get("key") != PUBLISHER_KEY:
            return web.Response(status=403)
        found = self.tickets.get(params.get("ticket", ""))
        if found is None or params.get("identity") != "fourgames-gamedata":
            return web.json_response({"response": {"error": {"errorcode": 101, "errordesc": "Invalid ticket"}}})
        steamid, owner = found
        return web.json_response({"response": {"params": {
            "result": "OK", "steamid": steamid, "ownersteamid": owner,
            "vacbanned": False, "publisherbanned": False}}})

    async def ownership(self, request: web.Request) -> web.Response:
        params = dict(request.query)
        self.calls.append(("ownership", params))
        owns = self.owns.get((params["steamid"], int(params["appid"])), False)
        return web.json_response({"appownership": {"ownsapp": owns, "permanent": False, "result": "OK",
                                                   "ownersteamid": STEAMID if owns else "0"}})

    async def openid(self, request: web.Request) -> web.Response:
        form = dict(await request.post())
        self.calls.append(("openid", form))
        valid = "true" if self.openid_valid else "false"
        return web.Response(text=f"ns:http://specs.openid.net/auth/2.0\nis_valid:{valid}\n")

    def called(self, name: str) -> list[dict[str, str]]:
        return [params for call, params in self.calls if call == name]


class FakeGitHub:
    """api.github.com's /repos/... as far as the dashboard's proxy goes: every call is recorded
    and answered with what `answer` returns (status, body, headers), by default a JSON echo."""

    def __init__(self):
        self.calls: list[dict] = []
        self.answer = lambda call: (200, {"path": call["path"], "query": call["query"]},
                                    {"ETag": '"abc"', "Link": '<https://api.github.com/x?page=2>; rel="next"',
                                     "X-RateLimit-Remaining": "4999", "X-RateLimit-Reset": "1900000000",
                                     "Cache-Control": "private, max-age=60, s-maxage=60",
                                     "Set-Cookie": "gh=1", "X-OAuth-Scopes": "repo"})
        self.delay = 0.0

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_route("*", "/{path:.*}", self.handle)
        return app

    async def handle(self, request: web.Request) -> web.StreamResponse:
        body = await request.read()
        call = {"method": request.method, "path": request.path, "query": dict(request.query),
                "headers": dict(request.headers), "body": json.loads(body) if body else None}
        self.calls.append(call)
        if self.delay:
            await asyncio.sleep(self.delay)
        status, data, headers = self.answer(call)
        if isinstance(data, bytes):
            return web.Response(status=status, body=data, headers=headers, content_type="application/json")
        return web.json_response(data, status=status, headers=headers)


@dataclass
class World:
    client: TestClient
    steam: FakeSteam
    cfg: Config
    app: web.Application
    steam_server: TestServer
    github: FakeGitHub | None = None

    async def steam_server_down(self) -> None:
        await self.steam_server.close()

    @property
    def store(self):
        from gamedata.web import STORE
        return self.app[STORE]

    async def start(self, ticket: str = TICKET, app_id: int = APP_ID, gameplay: bool = True,
                    hardware: bool = True, hardware_extra: dict | None = None, **extra):
        body = {"app_id": app_id, "ticket": ticket, "game_version": "1.0.2", "build_id": "26413834",
                "godot_version": "4.7.0", "platform": "windows", "locale": "en",
                "consent": {"gameplay": gameplay, "hardware": hardware},
                "hardware": {**HARDWARE, **(hardware_extra or {})},
                "settings": {"volume": 0.8, "fullscreen": True, "lang": "en"},
                "previous_crash": None, **extra}
        response = await self.client.post("/gamedata/v1/session/start", json=body)
        return response.status, await response.json()

    async def started(self, **kwargs) -> dict:
        status, body = await self.start(**kwargs)
        assert status == 200 and body["ok"] and not body["opted_out"], body
        return body

    async def upload(self, token: str, session_id: str, seq: int, events: list | None = None,
                     raw: bytes | None = None, path: str = "/gamedata/v1/events"):
        if raw is None:
            if events is None:
                events = [{"t": 12.345, "type": "action", "name": "plant_seed",
                           "data": {"x": 3, "y": 7, "crop": "carrot"}},
                          {"t": 15.0, "type": "snapshot", "data": {"day": 4}},
                          {"t": 20.1, "type": "progress", "data": {"day": 4, "coins": 120}}]
            raw = gzip.compress(json.dumps({"session_id": session_id, "seq": seq, "events": events}).encode())
        response = await self.client.post(path, data=raw, headers={
            "Authorization": f"Bearer {token}", "Content-Type": "application/json", "Content-Encoding": "gzip"})
        return response.status, await response.json()

    async def sign_in(self, steamid: str = STEAMID, back: str = "/privacy") -> str:
        """The full Steam sign-in; the fg_privacy cookie's value."""
        location, nonce = await self.begin_sign_in(back)
        response = await self.finish_sign_in(location, nonce, steamid)
        assert response.status == 302, await response.text()
        assert response.headers["Location"] == SITE + back
        return cookies(response)["fg_privacy"].value

    async def begin_sign_in(self, back: str = "/privacy") -> tuple[str, str]:
        response = await self.client.get("/gamedata/v1/auth/steam", params={"return": back},
                                         allow_redirects=False)
        assert response.status == 302, await response.text()
        return response.headers["Location"], cookies(response)["fg_openid"].value

    async def finish_sign_in(self, location: str, nonce: str | None, steamid: str = STEAMID, **changes):
        query = {k: v[0] for k, v in parse_qs(urlsplit(location).query).items()}
        return_to = query["openid.return_to"]
        params = steam_assertion(return_to, steamid)
        params.update(changes)
        params = {k: v for k, v in params.items() if v is not None}
        state = parse_qs(urlsplit(return_to).query)["state"][0]
        headers = {"Cookie": f"fg_openid={nonce}"} if nonce else {}
        return await self.client.get("/gamedata/v1/auth/callback", params={"state": state, **params},
                                     headers=headers, allow_redirects=False)

    def page(self, cookie: str | None = None, **headers) -> dict[str, str]:
        out = {"Origin": SITE, **headers}
        if cookie:
            out["Cookie"] = f"fg_privacy={cookie}"
        return out


def steam_assertion(return_to: str, steamid: str) -> dict[str, str]:
    """What Steam sends back to return_to after a sign-in."""
    claimed = f"https://steamcommunity.com/openid/id/{steamid}"
    return {
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "id_res",
        "openid.op_endpoint": "https://steamcommunity.com/openid/login",
        "openid.claimed_id": claimed,
        "openid.identity": claimed,
        "openid.return_to": return_to,
        "openid.response_nonce": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "Fq2Rz7",
        "openid.assoc_handle": "1234567890",
        "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
        "openid.sig": "c2lnbmF0dXJl",
    }


def cookies(response) -> SimpleCookie:
    jar = SimpleCookie()
    for header in response.headers.getall("Set-Cookie", []):
        jar.load(header)
    return jar


def unzip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def run(tmp_path: Path, steps, limits: Limits | None = None, geo_opener=None, **env: str):
    async def go():
        steam = FakeSteam()
        steam_server = TestServer(steam.app())
        await steam_server.start_server()
        base = str(steam_server.make_url("")).rstrip("/")
        github = FakeGitHub()
        github_server = TestServer(github.app())
        await github_server.start_server()
        cfg = config(tmp_path, **env)
        extra = {"geo_opener": geo_opener} if geo_opener else {}
        app = make_app(cfg, steam_api=base, steam_openid=f"{base}/openid/login", run_retention=False,
                       limits=limits, github_api=str(github_server.make_url("")).rstrip("/"), **extra)
        client = TestClient(TestServer(app), cookie_jar=aiohttp.DummyCookieJar())
        await client.start_server()
        try:
            return await steps(World(client, steam, cfg, app, steam_server, github))
        finally:
            await client.close()
            await steam_server.close()
            await github_server.close()
    return asyncio.run(go())
