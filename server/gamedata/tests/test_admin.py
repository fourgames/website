"""The owner's endpoints (admin.py): who may, the dashboard's GitHub proxy (against a fake GitHub),
the sessions list, one session and its "Copy for Claude", and the players behind posts."""

from __future__ import annotations

import base64
import io
import json
import logging
import time
import zipfile
from pathlib import Path

import pytest

from gamedata import admin, summary
from gamedata.config import Config, ConfigError
from gamedata.signing import make_pid, sign
from gamedata.web import Limits

from .harness import APP_ID, ENV, FRIEND, SITE, STEAMID, cookies, run

TOKEN = "github_pat_" + "T" * 40
# STEAMID is the owner; FRIEND is anyone else.
ADMIN = {"GAMEDATA_ADMIN_STEAMIDS": STEAMID, "GAMEDATA_GITHUB_TOKEN": TOKEN}
PID = make_pid(ENV["GAMEDATA_PEPPER"], STEAMID)
FRIEND_TICKET = "f00d" * 4
TEST_APP = 4242420
SHA = "0123456789abcdef0123456789abcdef01234567"
GH = "/gamedata/v1/admin/github"


def admin_headers(w, cookie, **more):
    return {**w.page(cookie), **more}


# Settings


def test_config(tmp_path):
    base = {**ENV, "DATA_DIR": str(tmp_path)}
    cfg = Config.from_env(base)
    assert cfg.admin_steamids == frozenset() and cfg.github_token == ""
    cfg = Config.from_env({**base, "GAMEDATA_ADMIN_STEAMIDS": f" {STEAMID} , {FRIEND}", "GH_TOKEN": "from-feedback"})
    assert cfg.admin_steamids == {STEAMID, FRIEND} and cfg.github_token == "from-feedback"
    cfg = Config.from_env({**base, "GH_TOKEN": "from-feedback", "GAMEDATA_GITHUB_TOKEN": TOKEN})
    assert cfg.github_token == TOKEN, "its own token wins over the feedback loop's"
    assert TOKEN not in repr(cfg) and STEAMID not in repr(Config.from_env({**base, **ADMIN}))
    # The owner's two accounts.
    owners = Config.from_env({**base, "GAMEDATA_ADMIN_STEAMIDS": "76561198989975936,76561198725283865"})
    assert owners.admin_steamids == {"76561198989975936", "76561198725283865"}
    for value in ("1234", f"{STEAMID},x", "76561197960265728"):
        with pytest.raises(ConfigError):
            Config.from_env({**base, "GAMEDATA_ADMIN_STEAMIDS": value})


# Signing in and who may


def test_signing_in_for_the_dashboard(tmp_path):
    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        response = await w.client.get("/gamedata/v1/admin/me", headers=w.page(cookie))
        body = await response.json()
        assert response.status == 200 and body["ok"] and body["admin"] is True
        assert abs(body["until"] - (time.time() + 12 * 3600)) < 60
        # The admin's cookie lasts 12 hours, anyone else's an hour (wherever they signed in).
        location, nonce = await w.begin_sign_in("/fb-dash")
        response = await w.finish_sign_in(location, nonce)
        assert response.headers["Location"] == f"{SITE}/fb-dash"
        assert cookies(response)["fg_privacy"]["max-age"] == str(12 * 3600)
        location, nonce = await w.begin_sign_in("/fb-dash")
        response = await w.finish_sign_in(location, nonce, steamid=FRIEND)
        assert response.headers["Location"] == f"{SITE}/fb-dash"
        assert cookies(response)["fg_privacy"]["max-age"] == "3600"
        # A failed sign-in goes back to the dashboard too, saying so.
        location, nonce = await w.begin_sign_in("/fb-dash")
        w.steam.openid_valid = False
        response = await w.finish_sign_in(location, nonce)
        assert response.headers["Location"] == f"{SITE}/fb-dash?signin=failed"
    run(tmp_path, steps, **ADMIN)


@pytest.mark.parametrize("path", ["/v1/admin/me", "/v1/admin/sessions", "/v1/admin/github-check",
                                  "/v1/admin/sessions/aaaaaaaa-0000-4000-8000-000000000001",
                                  "/v1/admin/github/feedback-data/contents/index.json?ref=main"])
def test_only_the_owner_signed_in_from_the_site(tmp_path, path):
    async def steps(w):
        url = "/gamedata" + path
        response = await w.client.get(url, headers=w.page())
        assert (response.status, (await response.json())["error"]) == (401, "not_signed_in")
        # The dashboard can read the refusal (CORS on errors too), to show the sign-in.
        assert response.headers["Access-Control-Allow-Origin"] == SITE
        forged = sign("x" * 40, "cookie", {"p": PID}, 600)
        response = await w.client.get(url, headers=w.page(forged))
        assert response.status == 401
        expired = sign(w.cfg.cookie_secret, "cookie", {"p": PID}, -1)
        assert (await w.client.get(url, headers=w.page(expired))).status == 401
        friend = await w.sign_in(steamid=FRIEND)
        response = await w.client.get(url, headers=w.page(friend))
        assert (response.status, (await response.json())["error"]) == (403, "not_admin")
        owner = await w.sign_in()
        # From another site, or with no Origin at all (a link, a script tag): refused.
        for headers in ({"Origin": "https://evil.example"}, {}):
            response = await w.client.get(url, headers={**headers, "Cookie": f"fg_privacy={owner}"})
            assert (response.status, (await response.json())["error"]) == (403, "bad_origin")
            assert "Access-Control-Allow-Origin" not in response.headers
        response = await w.client.get(url, headers=w.page(owner))
        assert response.status in (200, 404), await response.text()  # (the session doesn't exist)
        assert response.headers["Access-Control-Allow-Origin"] == SITE
        assert response.headers["Access-Control-Allow-Credentials"] == "true"
        assert response.headers["Vary"] == "Origin, Cookie"
        assert not w.github.calls or w.github.calls[-1]["path"].startswith("/repos/fourgames/")
        # Nobody has admin rights without GAMEDATA_ADMIN_STEAMIDS: see the next test.
    run(tmp_path, steps, **ADMIN)


def test_without_admin_steamids_nobody_is_the_owner(tmp_path):
    async def steps(w):
        cookie = await w.sign_in()
        response = await w.client.get("/gamedata/v1/admin/me", headers=w.page(cookie))
        assert (response.status, (await response.json())["error"]) == (403, "not_admin")
    run(tmp_path, steps, GAMEDATA_GITHUB_TOKEN=TOKEN)


def test_preflight(tmp_path):
    async def steps(w):
        response = await w.client.options(f"{GH}/feedback-data/contents/cleared.json", headers={
            "Origin": SITE, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type"})
        assert response.status == 204
        assert response.headers["Access-Control-Allow-Origin"] == SITE
        assert response.headers["Access-Control-Allow-Credentials"] == "true"
        assert "PUT" in response.headers["Access-Control-Allow-Methods"]
        assert response.headers["Access-Control-Allow-Headers"] == "Content-Type"
        response = await w.client.options(f"{GH}/feedback-data/contents/cleared.json", headers={
            "Origin": "https://evil.example", "Access-Control-Request-Method": "PUT"})
        assert "Access-Control-Allow-Origin" not in response.headers
        assert not w.github.calls
    run(tmp_path, steps, **ADMIN)


def test_signing_out(tmp_path):
    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        response = await w.client.post("/gamedata/v1/auth/signout", json={}, headers=w.page(cookie))
        assert response.status == 200 and cookies(response)["fg_privacy"]["max-age"] == "0"
    run(tmp_path, steps, **ADMIN)


def test_admin_rate_limit(tmp_path):
    limits = Limits()
    limits.admin_pid.limit = 3

    async def steps(w):
        cookie = await w.sign_in()
        statuses = [(await w.client.get("/gamedata/v1/admin/me", headers=w.page(cookie))).status for _ in range(4)]
        assert statuses == [200, 200, 200, 429]
    run(tmp_path, steps, limits=limits, **ADMIN)


# The GitHub proxy


async def gh(w, cookie, path, method="GET", **kwargs):
    headers = {**w.page(cookie), **kwargs.pop("headers", {})}
    response = await w.client.request(method, f"{GH}/{path}", headers=headers, **kwargs)
    return response, await response.read()


def test_reads_go_through_with_the_server_s_token(tmp_path, caplog):
    caplog.set_level(logging.INFO)

    async def steps(w):
        cookie = await w.sign_in()
        response, body = await gh(w, cookie, f"feedback-data/contents/games/5207970.json?ref={SHA}", headers={
            "Accept": "application/vnd.github.object+json", "Authorization": "Bearer from-the-browser",
            "If-None-Match": '"old"'})
        assert response.status == 200
        assert json.loads(body) == {"path": "/repos/fourgames/feedback-data/contents/games/5207970.json",
                                    "query": {"ref": SHA}}
        [call] = w.github.calls
        assert call["method"] == "GET"
        assert call["headers"]["Authorization"] == f"Bearer {TOKEN}", "the server's token, never the browser's"
        assert call["headers"]["Accept"] == "application/vnd.github.object+json"
        assert call["headers"]["X-GitHub-Api-Version"] == "2022-11-28"
        assert call["headers"]["If-None-Match"] == '"old"'
        assert "Cookie" not in call["headers"] and "Origin" not in call["headers"]
        # GitHub's headers the dashboard needs come back (and may be read: CORS exposes them);
        # its cookie doesn't, and the token is nowhere.
        assert response.headers["ETag"] == '"abc"' and "rel=\"next\"" in response.headers["Link"]
        assert response.headers["X-RateLimit-Reset"] == "1900000000"
        assert response.headers["Cache-Control"] == "private, max-age=60, s-maxage=60"
        assert "Set-Cookie" not in response.headers and "X-OAuth-Scopes" not in response.headers
        exposed = response.headers["Access-Control-Expose-Headers"]
        assert "ETag" in exposed and "Link" in exposed and "X-RateLimit-Reset" in exposed
        assert TOKEN not in str(response.headers) and TOKEN.encode() not in body

        # The other reads the dashboard makes.
        for path, query in (("feedback-data/contents/index.json?ref=main", {"ref": "main"}),
                            ("feedback-data/contents/research-index.json", {}),
                            ("feedback-data/commits?per_page=1", {"per_page": "1"}),
                            ("website/actions/workflows/feedback.yml/runs?per_page=1", {"per_page": "1"}),
                            ("website/actions/workflows/static.yml/runs?per_page=1", {"per_page": "1"})):
            response, body = await gh(w, cookie, path)
            assert response.status == 200, (path, body)
            assert w.github.calls[-1]["query"] == query
            assert w.github.calls[-1]["headers"]["Accept"] == "application/vnd.github+json"
        assert w.github.calls[-2]["path"] == "/repos/fourgames/website/actions/workflows/feedback.yml/runs"
    run(tmp_path, steps, **ADMIN)
    # (aiohttp's access log is off in the service; the test server's shows the sign-in's URL.)
    text = "\n".join(r.getMessage() for r in caplog.records if r.name.startswith("gamedata"))
    assert TOKEN not in text and STEAMID not in text and "github GET feedback-data/commits" in text


@pytest.mark.parametrize("path, method, status", [
    ("feedback-data/contents/notes.txt", "GET", 404),
    ("feedback-data/contents/..%2Findex.json", "GET", 404),
    ("feedback-data/contents/games%2F..%2Findex.json", "GET", 404),
    ("feedback-data/contents/a/b.json", "GET", 404),
    ("feedback-data/contents/.hidden.json", "GET", 404),
    # (No route at all: only the preflight's.)
    ("feedback-data", "GET", 405),
    ("feedback-data/", "GET", 405),
    ("feedback-data/git/refs", "GET", 404),
    ("feedback-data/actions/workflows/feedback.yml/runs", "GET", 404),
    ("website/contents/index.json", "GET", 404),
    ("website/actions/workflows/deploy.yml/runs", "GET", 404),
    ("other-repo/contents/index.json", "GET", 404),
    ("feedback-data/contents/index.json", "PUT", 404),
    ("feedback-data/contents/games/5207970.json", "PUT", 404),
    ("feedback-data/contents/cleared.json", "DELETE", 405),
    ("feedback-data/contents/cleared.json", "POST", 405),
    ("feedback-data/contents/index.json?ref=main;rm", "GET", 400),
    ("feedback-data/contents/index.json?ref=main&ref=main", "GET", 400),
    ("feedback-data/contents/index.json?ref=main&token=x", "GET", 400),
    ("feedback-data/commits?per_page=100", "GET", 400),
    ("feedback-data/commits?sha=main", "GET", 400),
    ("website/actions/workflows/feedback.yml/runs?per_page=1&status=failure", "GET", 400),
])
def test_anything_else_isn_t_forwarded(tmp_path, path, method, status):
    async def steps(w):
        cookie = await w.sign_in()
        kwargs = {"json": {"message": "m", "branch": "main", "content": "e30K"}} if method in ("PUT", "POST") else {}
        response, body = await gh(w, cookie, path, method, **kwargs)
        assert response.status == status, body
        assert not w.github.calls
    run(tmp_path, steps, **ADMIN)


def test_dot_dot_and_odd_paths_are_never_forwarded():
    from multidict import MultiDict
    for path in ("contents/games/../index.json", "contents/../../x.json", "contents/index.json/..", "contents/",
                 "contents/games/12a.json", "contents/Index.json"):
        with pytest.raises(admin.Refused) as refused:
            admin.allowed("GET", "feedback-data", path, MultiDict())
        assert refused.value.status == 404, path
    assert admin.allowed("GET", "feedback-data", "contents/games/12.json", MultiDict(ref="main")) == {"ref": "main"}


def save(raw=b'{"1": {}}\n', **changes):
    return {"message": 'Feedback: fixed "Crash on load"', "branch": "main", "sha": SHA,
            "content": base64.b64encode(raw).decode(), **changes}


def test_saves_go_through_checked(tmp_path):
    async def steps(w):
        cookie = await w.sign_in()
        w.github.answer = lambda call: (200, {"content": {"sha": "f" * 40}, "commit": {"sha": "e" * 40}}, {})
        for name in ("cleared", "credit", "bundles", "competitors", "research"):
            response, body = await gh(w, cookie, f"feedback-data/contents/{name}.json", "PUT", json=save())
            assert response.status == 200, body
            assert json.loads(body)["commit"]["sha"] == "e" * 40
            call = w.github.calls[-1]
            assert call["method"] == "PUT" and call["path"] == f"/repos/fourgames/feedback-data/contents/{name}.json"
            assert call["body"] == save() and call["headers"]["Authorization"] == f"Bearer {TOKEN}"
        # A new file has no sha yet.
        body = save()
        del body["sha"]
        response, _ = await gh(w, cookie, "feedback-data/contents/credit.json", "PUT", json=body)
        assert response.status == 200 and w.github.calls[-1]["body"] == body
        calls = len(w.github.calls)

        url = "feedback-data/contents/cleared.json"
        for bad in (save(branch="gh-pages"), save(sha="nope"), save(content="not base64!"), save(message=""),
                    {**save(), "committer": {"name": "x"}}, save(content=None), save(branch=None)):
            response, body = await gh(w, cookie, url, "PUT", json=bad)
            assert response.status == 400, (bad, body)
        response, _ = await gh(w, cookie, url, "PUT", data=json.dumps(save()), headers={"Content-Type": "text/plain"})
        assert response.status == 415
        response = await w.client.put(f"{GH}/{url}", json=save(), headers={"Origin": "https://evil.example",
                                                                         "Cookie": f"fg_privacy={cookie}"})
        assert response.status == 403
        response, _ = await gh(w, cookie, url, "PUT", data=b"{" * 10, headers={"Content-Type": "application/json"})
        assert response.status == 400
        response, _ = await gh(w, cookie, url, "PUT", json=save(raw=b"x" * (3 * 1024 * 1024)))
        assert response.status == 413
        assert len(w.github.calls) == calls
    run(tmp_path, steps, **ADMIN)


def test_github_s_own_answers_come_back_as_they_are(tmp_path):
    async def steps(w):
        cookie = await w.sign_in()
        # A file that isn't there yet, someone else's save in between, an unchanged file.
        for status in (404, 409, 422):
            w.github.answer = lambda call, status=status: (status, {"message": "Not Found" if status == 404 else "conflict"}, {})
            method = "GET" if status == 404 else "PUT"
            response, body = await gh(w, cookie, "feedback-data/contents/credit.json", method,
                                      **({"json": save()} if method == "PUT" else {}))
            assert response.status == status and "message" in json.loads(body)
        w.github.answer = lambda call: (304, b"", {"ETag": '"abc"', "Cache-Control": "private, max-age=60"})
        response, body = await gh(w, cookie, f"feedback-data/contents/index.json?ref={SHA}",
                                  headers={"If-None-Match": '"abc"'})
        assert response.status == 304 and body == b"" and response.headers["ETag"] == '"abc"'
    run(tmp_path, steps, **ADMIN)


def test_when_the_token_can_t_the_proxy_says_so(tmp_path):
    async def steps(w):
        cookie = await w.sign_in()
        url = "feedback-data/contents/index.json?ref=main"
        w.github.answer = lambda call: (401, {"message": "Bad credentials"}, {})
        response, body = await gh(w, cookie, url)
        assert response.status == 502 and json.loads(body)["error"] == "github_token_refused"
        w.github.answer = lambda call: (403, {"message": "Resource not accessible by personal access token"},
                                        {"X-Accepted-GitHub-Permissions": "contents=read"})
        response, body = await gh(w, cookie, url)
        answer = json.loads(body)
        assert response.status == 502 and answer["error"] == "github_forbidden"
        assert "Resource not accessible" in answer["message"] and "contents=read" in answer["message"]
        reset = str(int(time.time()) + 120)
        w.github.answer = lambda call: (403, {"message": "API rate limit exceeded"},
                                        {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset})
        response, body = await gh(w, cookie, url)
        assert response.status == 429 and json.loads(body)["error"] == "rate_limited"
        assert 100 <= int(response.headers["Retry-After"]) <= 121 and response.headers["X-RateLimit-Reset"] == reset
        for status in (429, 403):
            w.github.answer = lambda call, status=status: (status, {"message": "secondary rate limit"}, {"Retry-After": "30"})
            response, _ = await gh(w, cookie, url)
            assert response.status == 429 and response.headers["Retry-After"] == "30"
        w.github.answer = lambda call: (503, {"message": "unicorn"}, {})
        response, body = await gh(w, cookie, url)
        assert response.status == 502 and json.loads(body)["error"] == "github_unavailable"
    run(tmp_path, steps, **ADMIN)


def test_size_and_time_limits(tmp_path, monkeypatch):
    monkeypatch.setattr(admin, "GITHUB_MAX_BODY", 1000)
    monkeypatch.setattr(admin, "GITHUB_TIMEOUT", admin.aiohttp.ClientTimeout(total=0.3))

    async def steps(w):
        cookie = await w.sign_in()
        url = "feedback-data/contents/index.json?ref=main"
        w.github.answer = lambda call: (200, {"content": "x" * 5000}, {})
        response, body = await gh(w, cookie, url)
        assert response.status == 502 and json.loads(body)["error"] == "github_too_large"
        w.github.answer = lambda call: (200, {"ok": 1}, {})
        w.github.delay = 1.0
        response, body = await gh(w, cookie, url)
        assert response.status == 504 and json.loads(body)["error"] == "github_timeout"
    run(tmp_path, steps, **ADMIN)


def test_without_a_token(tmp_path):
    async def steps(w):
        cookie = await w.sign_in()
        response, body = await gh(w, cookie, "feedback-data/contents/index.json?ref=main")
        assert response.status == 503 and json.loads(body)["error"] == "github_not_configured"
        assert not w.github.calls
    run(tmp_path, steps, GAMEDATA_ADMIN_STEAMIDS=STEAMID)


def test_github_check(tmp_path):
    async def steps(w):
        cookie = await w.sign_in()
        response = await w.client.get("/gamedata/v1/admin/github-check", headers=w.page(cookie))
        body = await response.json()
        assert response.status == 200 and body["can"] == {"read_data": True, "read_runs": True, "write_data": True}
        assert body["message"] == "the token does everything the dashboard needs"
        assert sorted(c["path"] for c in w.github.calls) == [
            "/repos/fourgames/feedback-data", "/repos/fourgames/feedback-data/contents/index.json",
            "/repos/fourgames/website/actions/workflows/feedback.yml/runs"]
        # The feedback loop's token as it is today: fourgames/website, Actions only (fine-grained, no scopes).
        w.github.answer = lambda call: (200, {}, {}) if call["path"].startswith("/repos/fourgames/website") \
            else (404, {"message": "Not Found"}, {})
        body = await (await w.client.get("/gamedata/v1/admin/github-check", headers=w.page(cookie))).json()
        assert body["can"] == {"read_data": False, "read_runs": True, "write_data": None}
        assert "can't read fourgames/feedback-data" in body["message"]
    run(tmp_path, steps, **ADMIN)


# Sessions


async def a_few_sessions(w):
    """A real session with events, hardware and an end; a test session that crashed, reported by
    the next one; another player's session of another app. Returns their ids."""
    real = await w.started(game_version="1.0.1")
    await w.upload(real["token"], real["session_id"], 1, events=[
        {"t": 30.5, "type": "death", "data": {"cause": "fell", "scene": "res://w.tscn", "x": 3.5, "y": 1, "z": 2}}])
    await w.upload(real["token"], real["session_id"], 0)
    await w.client.post("/gamedata/v1/session/end", headers={"Authorization": f"Bearer {real['token']}"}, json={
        "session_id": real["session_id"], "seq": 2, "playtime_s": 40.5, "active_s": 38, "idle_s": 2.5,
        "last_scene": "res://w.tscn", "summary": {"events": 4, "actions": 1, "errors": 0}})
    test = await w.started(app_id=TEST_APP, hardware=False)
    await w.upload(test["token"], test["session_id"], 0, events=[{"t": 1, "type": "load", "name": "scene",
                                                                   "data": {"scene": "res://game/level_1.tscn"}}])
    later = await w.started(app_id=TEST_APP)
    response = await w.client.post("/gamedata/v1/crash", headers={"Authorization": f"Bearer {later['token']}"}, json={
        "crashed_session_id": test["session_id"], "log_tail": "a\nb\nsignal 11", "signal": "SIGSEGV",
        "last_events": [{"t": 2, "type": "action", "name": "boom"}]})
    assert response.status == 200
    w.steam.tickets[FRIEND_TICKET] = (FRIEND, FRIEND)
    other = await w.started(ticket=FRIEND_TICKET, app_id=3958210)
    # Started a second apart, so newest first is a known order (and two at the same second).
    db = w.store.db
    for session_id, started in ((real["session_id"], 1000), (test["session_id"], 2000),
                                (later["session_id"], 3000), (other["session_id"], 3000)):
        db.execute("UPDATE sessions SET started = ? WHERE session_id = ?", (started, session_id))
    return real["session_id"], test["session_id"], later["session_id"], other["session_id"]


TEST_ENV = {"GAMEDATA_TEST_APP_IDS": str(TEST_APP), "GAMEDATA_TEST_STEAMIDS": STEAMID}


def test_the_session_list(tmp_path):
    async def steps(w):
        real, test, later, other = await a_few_sessions(w)
        cookie = await w.sign_in()

        async def listed(query=""):
            response = await w.client.get(f"/gamedata/v1/admin/sessions{query}", headers=w.page(cookie))
            assert response.status == 200, await response.text()
            return await response.json()

        body = await listed()
        newest_two = sorted([later, other], reverse=True)
        assert [s["id"] for s in body["sessions"]] == [*newest_two, test, real]
        assert body["next"] is None
        row = next(s for s in body["sessions"] if s["id"] == real)
        assert row == {"id": real, "app_id": APP_ID, "started": 1000, "ended": row["ended"], "length_s": 40,
                       "test": False, "events": 4, "game_version": "1.0.1", "country": None, "platform": "windows",
                       "pid": PID[:8]}
        assert row["ended"] is not None
        assert next(s for s in body["sessions"] if s["id"] == test)["length_s"] == 1
        text = json.dumps(body)
        assert STEAMID not in text and FRIEND not in text and PID not in text
        assert body["apps"] == [{"app_id": 3958210, "sessions": 1, "test_sessions": 0},
                                {"app_id": TEST_APP, "sessions": 2, "test_sessions": 2},
                                {"app_id": APP_ID, "sessions": 1, "test_sessions": 0}]

        assert [s["id"] for s in (await listed("?test=1"))["sessions"]] == [later, test]
        assert [s["id"] for s in (await listed("?test=0"))["sessions"]] == [other, real]
        assert [s["id"] for s in (await listed(f"?app_id={APP_ID}"))["sessions"]] == [real]
        assert [s["id"] for s in (await listed(f"?app_id={TEST_APP}&test=0"))["sessions"]] == []

        # Pages: two at the same second still come once each.
        first = await listed("?limit=1")
        seen = [s["id"] for s in first["sessions"]]
        cursor = first["next"]
        while cursor:
            page = await listed(f"?limit=1&before={cursor}")
            seen += [s["id"] for s in page["sessions"]]
            cursor = page["next"]
        assert seen == [*newest_two, test, real]
        assert [s["id"] for s in (await listed("?before=3000"))["sessions"]] == [test, real]

        for query in ("?app_id=abc", "?test=maybe", "?limit=0", "?limit=201", "?before=x", "?before=1:short"):
            response = await w.client.get(f"/gamedata/v1/admin/sessions{query}", headers=w.page(cookie))
            assert response.status == 400, query
    run(tmp_path, steps, **ADMIN, **TEST_ENV)


def from_download(files: dict[str, bytes], session_id: str) -> dict:
    """What export_reader.gd attaches to one session of a download, done here by hand."""
    rows = json.loads(files["sessions.json"])
    row = dict(next(r for r in rows if r["session_id"] == session_id))
    batches = sorted((int(name.rsplit("/", 1)[1][:-5]), json.loads(data)) for name, data in files.items()
                     if name.startswith("events/") and f"/{session_id}/" in name)
    row["events"] = [event for _, batch in batches for event in batch["events"]]
    row["hardware"] = next((h for h in json.loads(files["hardware.json"]) if h["session_id"] == session_id), {})
    row["settings"] = next((s["data"] for s in json.loads(files["settings.json"]) if s["session_id"] == session_id), {})
    crashes = json.loads(files["crashes.json"])

    def with_log(entry):
        entry = dict(entry)
        if entry.get("log_file"):
            log = json.loads(files[entry["log_file"]])
            entry.update(log_tail=log["log_tail"], last_events=log["last_events"], log_file=None)
        return entry

    row["crashes"] = [with_log(c) for c in crashes if c["crashed_session_id"] == session_id]
    row["reported"] = next((with_log(c) for c in crashes if c["session_id"] == session_id), {})
    return row


def test_one_session_is_as_in_the_download(tmp_path):
    async def steps(w):
        ids = await a_few_sessions(w)
        cookie = await w.sign_in()
        response = await w.client.get("/gamedata/v1/me/export", headers=w.page(cookie))
        with zipfile.ZipFile(io.BytesIO(await response.read())) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        for session_id in ids[:3]:
            response = await w.client.get(f"/gamedata/v1/admin/sessions/{session_id}",
                                          headers=w.page(cookie, **{"Accept-Encoding": "gzip"}))
            assert response.status == 200
            assert response.headers.get("Content-Encoding") == "gzip"
            session = (await response.json())["session"]
            assert session == from_download(files, session_id)
            assert "pid" not in session and PID not in json.dumps(session)
        real, test, later, _ = ids
        session = (await (await w.client.get(f"/gamedata/v1/admin/sessions/{real}", headers=w.page(cookie))).json())["session"]
        # Batches in seq order, as sent (seq 1 came first); the viewer sorts by t.
        assert [e["t"] for e in session["events"]] == [12.345, 15.0, 20.1, 30.5]
        assert session["hardware"]["gpu"] == "NVIDIA GeForce RTX 3070" and session["settings"]["volume"] == 0.8
        assert session["crashes"] == [] and session["reported"] == {} and session["test"] is False
        crashed = (await (await w.client.get(f"/gamedata/v1/admin/sessions/{test}", headers=w.page(cookie))).json())["session"]
        assert crashed["hardware"] == {} and crashed["settings"] == {} and crashed["test"] is True
        [crash] = crashed["crashes"]
        assert crash["log_tail"] == "a\nb\nsignal 11" and crash["session_id"] == later and crash["test"] is True
        reporter = (await (await w.client.get(f"/gamedata/v1/admin/sessions/{later}", headers=w.page(cookie))).json())["session"]
        assert reporter["reported"]["crashed_session_id"] == test

        for bad in ("nope", "AAAAAAAA-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000001"):
            response = await w.client.get(f"/gamedata/v1/admin/sessions/{bad}", headers=w.page(cookie))
            assert response.status == 404
    run(tmp_path, steps, **ADMIN, **TEST_ENV)


def test_a_session_too_large_to_show(tmp_path, monkeypatch):
    from gamedata import export
    monkeypatch.setattr(export, "MAX_SESSION_GZ", 10)

    async def steps(w):
        real, *_ = await a_few_sessions(w)
        cookie = await w.sign_in()
        response = await w.client.get(f"/gamedata/v1/admin/sessions/{real}", headers=w.page(cookie))
        assert response.status == 413
    run(tmp_path, steps, **ADMIN, **TEST_ENV)


# The players behind posts (POST /v1/admin/players)

STRANGER = "76561198000000003"  # no data anywhere
FRIEND_PID = make_pid(ENV["GAMEDATA_PEPPER"], FRIEND)
PLAYERS = "/gamedata/v1/admin/players"


async def players_of(w, cookie, body, status=200):
    response = await w.client.post(PLAYERS, json=body, headers=w.page(cookie))
    assert response.status == status, await response.text()
    data = await response.json()
    return data["players"] if status == 200 else data["error"]


def test_players_only_for_the_owner_from_the_site(tmp_path):
    async def steps(w):
        body = {"steamids": [STEAMID]}
        response = await w.client.post(PLAYERS, json=body, headers=w.page())
        assert (response.status, (await response.json())["error"]) == (401, "not_signed_in")
        friend = await w.sign_in(steamid=FRIEND)
        response = await w.client.post(PLAYERS, json=body, headers=w.page(friend))
        assert (response.status, (await response.json())["error"]) == (403, "not_admin")
        owner = await w.sign_in()
        for headers in ({"Origin": "https://evil.example"}, {}):
            response = await w.client.post(PLAYERS, json=body, headers={**headers, "Cookie": f"fg_privacy={owner}"})
            assert (response.status, (await response.json())["error"]) == (403, "bad_origin")
        # A form post (no preflight) can't get in either.
        response = await w.client.post(PLAYERS, data="steamids=1", headers={
            **w.page(owner), "Content-Type": "application/x-www-form-urlencoded"})
        assert response.status == 415
        assert (await w.client.get(PLAYERS, headers=w.page(owner))).status == 405
        # The browser asks first (JSON from another origin): POST is allowed, for the site only.
        response = await w.client.options(PLAYERS, headers={
            "Origin": SITE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
        assert response.status == 204 and "POST" in response.headers["Access-Control-Allow-Methods"]
        assert await players_of(w, owner, body) == {}
    run(tmp_path, steps, **ADMIN)


def test_players_behind_posts(tmp_path, caplog):
    caplog.set_level(logging.INFO)

    async def steps(w):
        real, test, later, other = await a_few_sessions(w)
        cookie = await w.sign_in()
        listed = (await (await w.client.get("/gamedata/v1/admin/sessions", headers=w.page(cookie))).json())["sessions"]
        rows = {s["id"]: s for s in listed}

        # Every game: test sessions counted and marked, the newest first, the list's own rows.
        found = await players_of(w, cookie, {"steamids": [STEAMID, FRIEND, STRANGER, STEAMID, int(FRIEND)]})
        assert set(found) == {STEAMID, FRIEND}, "no data at all: left out; repeats once"
        me = found[STEAMID]
        assert {k: v for k, v in me.items() if k != "recent"} == {
            "opted_out": False, "sessions": 3, "test_sessions": 2, "playtime_s": 42,
            "first_seen": 1000, "last_seen": me["last_seen"]}
        assert me["last_seen"] >= 3000
        assert me["recent"] == [rows[later], rows[test], rows[real]]
        assert [s["test"] for s in me["recent"]] == [True, True, False]
        assert found[FRIEND]["sessions"] == 1 and found[FRIEND]["recent"] == [rows[other]]
        assert "other_games_sessions" not in me
        # Only the steamids the dashboard sent, as keys: none in the rows, nor a whole pid.
        values = json.dumps([entry for entry in found.values()])
        assert STEAMID not in values and FRIEND not in values and PID not in values and FRIEND_PID not in values

        # The game being looked at.
        found = await players_of(w, cookie, {"steamids": [STEAMID, FRIEND], "app_id": APP_ID})
        assert found[STEAMID]["sessions"] == 1 and found[STEAMID]["test_sessions"] == 0
        assert found[STEAMID]["playtime_s"] == 40 and found[STEAMID]["recent"] == [rows[real]]
        assert found[FRIEND] == {"opted_out": False, "sessions": 0, "test_sessions": 0, "playtime_s": 0,
                                 "first_seen": None, "last_seen": None, "recent": [], "other_games_sessions": 1}
        found = await players_of(w, cookie, {"steamids": [STEAMID], "app_id": TEST_APP})
        assert found[STEAMID]["sessions"] == 2 and found[STEAMID]["test_sessions"] == 2
        assert found[STEAMID]["playtime_s"] == 1 and found[STEAMID]["recent"] == [rows[later], rows[test]]
        assert await players_of(w, cookie, {"steamids": [STRANGER], "app_id": APP_ID}) == {}

        # Opted out: that alone, here too, whatever the game.
        w.store.set_opted_out(FRIEND_PID, True)
        for extra in ({}, {"app_id": 3958210}, {"app_id": APP_ID}):
            found = await players_of(w, cookie, {"steamids": [FRIEND, STEAMID], **extra})
            assert found[FRIEND] == {"opted_out": True}
        text = "\n".join(r.getMessage() for r in caplog.records if r.name.startswith("gamedata"))
        assert "players for " in text and STEAMID not in text and FRIEND not in text
    run(tmp_path, steps, **ADMIN, **TEST_ENV)


def test_players_limits(tmp_path):
    limits = Limits()

    async def steps(w):
        cookie = await w.sign_in()
        many = [str(76561198000000000 + n) for n in range(1, 202)]
        assert await players_of(w, cookie, {"steamids": many[:200]}) == {}
        for body in ({"steamids": many}, {"steamids": "x"}, {}, {"steamids": [STEAMID], "app_id": "5207970"},
                     {"steamids": [STEAMID], "app_id": True}, {"steamids": [STEAMID], "app_id": 0},
                     {"steamids": [STEAMID], "more": 1}):
            assert await players_of(w, cookie, body, 400) == "bad_request", body
        for bad in ("1029710208", "76561197960265728", "7656119800000000x", None, 1.5):
            assert await players_of(w, cookie, {"steamids": [STEAMID, bad]}, 400) == "bad_steamid", bad
        response = await w.client.post(PLAYERS, data=b"{" * 20000, headers={**w.page(cookie), "Content-Type": "application/json"})
        assert response.status == 413
        # The admin limits count it like every other call.
        limits.admin_pid.limit = 0
        assert (await w.client.post(PLAYERS, json={"steamids": []}, headers=w.page(cookie))).status == 429
    run(tmp_path, steps, limits=limits, **ADMIN)


def test_players_newest_sessions_only(tmp_path):
    async def steps(w):
        real, test, later, _ = await a_few_sessions(w)
        found = w.store.players([PID, PID, FRIEND_PID, "0" * 32], recent=2)
        assert [s["id"] for s in found[PID]["recent"]] == [later, test]
        assert found[PID]["sessions"] == 3
        assert w.store.players([]) == {}
        assert admin.RECENT == 10 and admin.MAX_PLAYERS == 200
    run(tmp_path, steps, **ADMIN, **TEST_ENV)


def test_copy_for_claude(tmp_path):
    async def steps(w):
        real, test, *_ = await a_few_sessions(w)
        cookie = await w.sign_in()
        for session_id in (real, test):
            response = await w.client.get(f"/gamedata/v1/admin/sessions/{session_id}/summary", headers=w.page(cookie))
            assert response.status == 200
            assert response.headers["Content-Type"] == "text/plain; charset=utf-8"
            text = await response.text()
            session = (await (await w.client.get(f"/gamedata/v1/admin/sessions/{session_id}",
                                                 headers=w.page(cookie))).json())["session"]
            assert text == summary.build(session)
        lines = text.split("\n")
        assert lines[0].startswith("Here is a play session from the fourgames_data test project")
        assert f"id {test}, app {TEST_APP}, a TEST session" in lines
        assert "this session crashed: SIGSEGV, reported" in text and "  signal 11" in lines
        real_text = await (await w.client.get(f"/gamedata/v1/admin/sessions/{real}/summary", headers=w.page(cookie))).text()
        assert f"Here is a play session of Steam app {APP_ID}" in real_text
        assert "started 1970-01-01T00:16:40Z, length 0:40 (active 0:38, idle 0:02)" in real_text
        assert "0:30 res://w.tscn, fell at (3, 2)" in real_text
        assert "at start: fullscreen=true, lang=en, volume=0.8" in real_text
        assert "Windows 11 | AMD Ryzen 7 5800X (8 cores) | 16 GB RAM | NVIDIA GeForce RTX 3070, driver 560.94 | forward_plus | 2560x1440 @ 144 Hz" in real_text
        assert summary.JSON_MARK in real_text
        response = await w.client.get("/gamedata/v1/admin/sessions/aaaaaaaa-0000-4000-8000-000000000009/summary",
                                      headers=w.page(cookie))
        assert response.status == 404
    run(tmp_path, steps, **ADMIN, **TEST_ENV)


# The summary port against the replay viewer's own text


FIXTURES = Path(__file__).resolve().parents[3] / "godot" / "fourgames_data" / "tests" / "fixtures"


@pytest.mark.skipif(not (FIXTURES / "summary_sessions.json").exists(), reason="no godot/ folder next to server/")
def test_the_same_text_as_the_replay_viewer():
    """godot/fourgames_data/tests/fixtures/summary/<id>.txt are what summary.gd writes for each
    session of summary_sessions.json (tests/tools/summary_golden.gd; test_summary.gd checks them
    on the Godot side)."""
    rows = json.loads((FIXTURES / "summary_sessions.json").read_text(encoding="utf-8"))
    assert len(rows) == 4
    for row in rows:
        with open(FIXTURES / "summary" / f"{row['session_id']}.txt", encoding="utf-8", newline="") as file:
            expected = file.read()
        text = summary.build(row)
        if text != expected:
            for number, (got, want) in enumerate(zip(text.split("\n"), expected.split("\n")), 1):
                assert got == want, f"{row['session_id']} line {number}"
        assert text == expected


def test_godot_s_way_of_writing_numbers():
    # Each as Godot 4.7 writes it (str(), JSON.stringify, snappedf + str), checked there.
    for value, as_str, as_json in ((0.57, "0.57", "0.57"), (0.1 + 0.2, "0.3", "0.3"), (1.0, "1.0", "1.0"),
                                   (1 / 3, "0.33333333333333", "0.333333333333333"),
                                   (100 / 3, "33.3333333333333", "33.3333333333333"),
                                   (12.345678901234567, "12.3456789012346", "12.3456789012346"),
                                   (1e15, "1000000000000000.0", "1000000000000000.0"),
                                   (1e20, "100000000000000000000.0", "100000000000000000000.0"),
                                   (1e14 + 0.25, "100000000000000", "100000000000000.2"),
                                   (0.999999999999999, "1.0", "0.999999999999999"),
                                   (1e-20, "0.0", "0.00000000000000000001"), (1e-40, "0.0", "0.0"),
                                   (1.2345e-7, "0.00000012345", "0.00000012345"), (-0.0, "0.0", "0.0"),
                                   (-2.5, "-2.5", "-2.5"), (123456.789, "123456.789", "123456.789")):
        assert summary.float_str(value) == as_str, value
        assert summary.json_float(value) == as_json, value
    assert [summary.short(v) for v in (0.57, 123456.789, 1.005, 3, 1e-5, True, None)] == \
        ["0.57", "123456.79", "1", "3", "0", "true", "<null>"]
    assert summary.gd_json({"a": 'q"\\\n\t\x01\x0b/é😀', "b": [1, 2.5, None, True], "c": {}}) == \
        '{"a":"q\\"\\\\\\n\\t\x01\\v/é😀","b":[1,2.5,null,true],"c":{}}'
    assert summary.gd_str({"a": 1.0, "b": "x", "c": [1, None, True], "d": {}}) == \
        '{ "a": 1.0, "b": "x", "c": [1.0, <null>, true], "d": {  } }'
    assert summary.clock(83.4, True) == "1:23.4" and summary.clock(3725.0) == "62:05"


# The Steam market files


def test_market_files(tmp_path, monkeypatch):
    import gzip
    market = tmp_path / "market"
    market.mkdir()
    (market / "growth.json.gz").write_bytes(gzip.compress(b'{"years":[2025,2026]}'))
    monkeypatch.setenv("MARKET_DIR", str(market))

    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        response = await w.client.get("/gamedata/v1/admin/market/growth.json", headers=w.page(cookie))
        assert response.status == 200 and await response.json() == {"years": [2025, 2026]}
        assert response.headers["Content-Encoding"] == "gzip"
        response = await w.client.get("/gamedata/v1/admin/market/trends", headers=w.page(cookie))
        assert response.status == 404 and (await response.json())["error"] == "not_built"
        response = await w.client.get("/gamedata/v1/admin/market/..%2Fsecret", headers=w.page(cookie))
        assert response.status == 404
        response = await w.client.get("/gamedata/v1/admin/market/growth", headers=w.page())
        assert response.status == 401
    run(tmp_path, steps, **ADMIN)


def test_creators_file(tmp_path, monkeypatch):
    import gzip
    path = tmp_path / "creators.json.gz"
    monkeypatch.setenv("CREATORS_FILE", str(path))

    async def steps(w):
        cookie = await w.sign_in(back="/fb-dash")
        response = await w.client.get("/gamedata/v1/admin/creators", headers=w.page(cookie))
        assert response.status == 404 and (await response.json())["error"] == "not_built"
        path.write_bytes(gzip.compress(b'{"creators":[]}'))
        response = await w.client.get("/gamedata/v1/admin/creators", headers=w.page(cookie))
        assert response.status == 200 and await response.json() == {"creators": []}
        response = await w.client.get("/gamedata/v1/admin/creators", headers=w.page())
        assert response.status == 401
    run(tmp_path, steps, **ADMIN)
