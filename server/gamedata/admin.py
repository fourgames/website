"""The owner's endpoints, /v1/admin/*, for the feedback dashboard (fourgames.se/fb-dash).

Signing in is the privacy page's Steam sign-in (web.auth_steam, ?return=/fb-dash): an admin is a
valid fg_privacy cookie whose pid is one of GAMEDATA_ADMIN_STEAMIDS' pids, worked out again at every
request, so taking a steamid out of the list (and restarting) ends its access at once. Every admin
request, GET included, must come from the site (Origin: SITE_ORIGIN); a PUT also needs a JSON body.
401 not_signed_in / 403 not_admin otherwise.

- GET /v1/admin/me: who's signed in (an admin, and until when).
- The GitHub proxy, /v1/admin/github/<repo>/<path>: the dashboard's reads and saves of
  fourgames/feedback-data (and its look at fourgames/website's workflow runs), with the server's
  token instead of one kept in the browser. Only the calls the dashboard makes are forwarded
  (ALLOWED below); anything else is 404 not_proxied. GitHub's answer comes back as it is (status,
  body, ETag, Link, rate-limit headers), except that its refusals of the token itself become
  502 github_token_refused / github_forbidden, so the dashboard never mistakes them for its own
  sign-in running out.
- GET /v1/admin/github-check: what the server's token can do.
- GET /v1/admin/sessions, /v1/admin/sessions/<id> and /v1/admin/sessions/<id>/summary: the
  players' sessions, one session in the shape the replay viewer reads, and its "Copy for Claude".

The logs show the first 8 characters of the admin's pid, paths and sizes; never the token.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any
from urllib.parse import urlencode

import aiohttp
from aiohttp import web

from . import export, summary
from . import web as W
from .limits import Refused, read_json
from .signing import short

log = logging.getLogger("gamedata.admin")

GITHUB_API = "https://api.github.com"
GITHUB_OWNER = "fourgames"
GITHUB = web.AppKey("github", object)

KB = 1024
MB = 1024 * 1024
# A contents answer for a file under 1 MB carries it in base64 (about 1.4 MB); bigger files come
# as a download_url the browser reads from GitHub itself.
GITHUB_MAX_BODY = 8 * MB
# A save: one of the dashboard's own files, in base64, inside a small JSON object.
PUT_CAPS = (2 * MB, 2 * MB)
GITHUB_TIMEOUT = aiohttp.ClientTimeout(total=20, connect=5)
GITHUB_PUT_TIMEOUT = aiohttp.ClientTimeout(total=30, connect=5)
# At most this many calls to GitHub at once (the box has one core).
GITHUB_PARALLEL = 6

# What the proxy forwards, from src/lib/feedback/dashboard.js:
#   feedback-data  GET contents/<file>.json?ref=<main or a commit>   (getJson, saveData's read)
#                  PUT contents/<one of the dashboard's own files>   (saveData)
#                  GET commits?per_page=1                            (apiBase: the newest data commit)
#   website        GET actions/workflows/{feedback,static}.yml/runs?per_page=1   (apiBase)
DATA_FILE = re.compile(r"^contents/(games/[0-9]{1,10}|[a-z0-9][a-z0-9_-]{0,63})\.json$")
WRITABLE = frozenset({"cleared", "credit", "bundles", "competitors", "research"})
WORKFLOW_RUNS = re.compile(r"^actions/workflows/(feedback|static)\.yml/runs$")
REF = re.compile(r"^(main|[0-9a-f]{7,40})$")
PER_PAGE = re.compile(r"^([1-9]|10)$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9_./-]{1,200}$")
ACCEPT = frozenset({"application/vnd.github+json", "application/vnd.github.object+json", "application/json"})
SHA = re.compile(r"^[0-9a-f]{40}$")
BASE64 = re.compile(r"^[A-Za-z0-9+/=\r\n]*$")
# GitHub's headers the dashboard may need (CORS exposes them, see web.on_prepare).
PASS_HEADERS = ("ETag", "Last-Modified", "Link", "Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining",
                "X-RateLimit-Reset", "X-RateLimit-Used", "X-RateLimit-Resource", "X-GitHub-Request-Id")
CONDITIONAL = ("If-None-Match", "If-Modified-Since")

SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
BEFORE = re.compile(r"^([0-9]{1,12})(?::([0-9a-f-]{36}))?$")
MAX_LIST = 200


class GitHub:
    def __init__(self, session: aiohttp.ClientSession, base: str, token: str):
        self.session = session
        self.base = base.rstrip("/")
        self.token = token
        self.parallel = asyncio.Semaphore(GITHUB_PARALLEL)


# Who may


def require_admin(request: web.Request) -> str:
    """The admin's pid. Every admin route goes through here first."""
    limits = request.app[W.LIMITS]
    W.check_rate(limits.admin_ip, W.ip_key(request), "admin per IP")
    if request.headers.get("Origin", "").rstrip("/") != request.app[W.CONFIG].site_origin:
        raise Refused(403, "bad_origin", "not allowed from this site")
    if request.method not in ("GET", "HEAD") and request.content_type != "application/json":
        raise Refused(415, "unsupported_media_type", "send JSON (Content-Type: application/json)")
    pid = W.signed_in_pid(request)
    if pid is None:
        raise Refused(401, "not_signed_in", "sign in with Steam first")
    if pid not in request.app[W.ADMIN_PIDS]:
        log.info("admin call from %s, who isn't an admin", short(pid))
        raise Refused(403, "not_admin", "this Steam account isn't one of the owner's")
    W.check_rate(limits.admin_pid, pid, f"admin calls for {short(pid)}")
    return pid


async def me(request: web.Request) -> web.Response:
    require_admin(request)
    claims = W.cookie_claims(request) or {}
    return W.ok({"admin": True, "until": claims.get("e")})


# The GitHub proxy


def allowed(method: str, repo: str, path: str, query) -> dict[str, str]:
    """The query to send on, if the dashboard makes this call; Refused otherwise."""
    def params(**rules: re.Pattern) -> dict[str, str]:
        out: dict[str, str] = {}
        for key in query:
            rule = rules.get(key)
            values = query.getall(key)
            if rule is None or len(values) != 1 or not rule.match(values[0]):
                raise Refused(400, "bad_query", f"the dashboard doesn't send {key}= like that here")
            out[key] = values[0]
        return out

    if repo == "feedback-data":
        file = DATA_FILE.match(path)
        if file and method == "GET":
            return params(ref=REF)
        if file and method == "PUT" and file.group(1) in WRITABLE:
            return params()
        if path == "commits" and method == "GET":
            return params(per_page=PER_PAGE)
    elif repo == "website":
        if WORKFLOW_RUNS.match(path) and method == "GET":
            return params(per_page=PER_PAGE)
    raise Refused(404, "not_proxied", "the dashboard's proxy doesn't forward that")


async def save_body(request: web.Request) -> dict[str, Any]:
    """A save (contents PUT) as the dashboard sends it, checked: {message, branch: "main", sha?, content}."""
    body = await read_json(request, *PUT_CAPS, require_json_type=True)
    if not set(body) <= {"message", "branch", "sha", "content"}:
        raise Refused(400, "bad_request", "a save is {message, branch, sha, content}")
    message, content, sha = body.get("message"), body.get("content"), body.get("sha")
    if not isinstance(message, str) or not 1 <= len(message) <= 500:
        raise Refused(400, "bad_request", "message must be a commit message")
    if body.get("branch") != "main":
        raise Refused(400, "bad_request", 'branch must be "main"')
    if sha is not None and (not isinstance(sha, str) or not SHA.match(sha)):
        raise Refused(400, "bad_request", "sha must be the file's blob sha")
    if not isinstance(content, str) or not BASE64.match(content):
        raise Refused(400, "bad_request", "content must be the file in base64")
    return {k: v for k, v in body.items() if v is not None}


def github_of(request: web.Request) -> GitHub:
    github: GitHub = request.app[GITHUB]
    if not github.token:
        raise Refused(503, "github_not_configured",
                      "the server has no GitHub token (GAMEDATA_GITHUB_TOKEN or GH_TOKEN in its environment)")
    return github


async def ask_github(github: GitHub, method: str, url: str, headers: dict[str, str],
                     body: dict[str, Any] | None = None) -> tuple[int, Any, bytes]:
    """(status, headers, body) of one call to GitHub, the body capped at GITHUB_MAX_BODY."""
    headers = {**headers, "Authorization": f"Bearer {github.token}", "X-GitHub-Api-Version": "2022-11-28",
               "User-Agent": "fourgames-gamedata"}
    timeout = GITHUB_PUT_TIMEOUT if method == "PUT" else GITHUB_TIMEOUT
    try:
        async with github.parallel, github.session.request(method, url, headers=headers, json=body,
                                                           timeout=timeout, allow_redirects=False) as response:
            data = bytearray()
            async for chunk in response.content.iter_chunked(64 * KB):
                data += chunk
                if len(data) > GITHUB_MAX_BODY:
                    raise Refused(502, "github_too_large", "GitHub's answer is too large to pass on")
            return response.status, response.headers, bytes(data)
    except TimeoutError:
        raise Refused(504, "github_timeout", "GitHub didn't answer in time; try again") from None
    except aiohttp.ClientError as error:
        log.warning("github %s: %s", method, type(error).__name__)
        raise Refused(502, "github_unavailable", "GitHub can't be reached; try again") from None


def github_message(body: bytes) -> str:
    try:
        message = json.loads(body).get("message")
    except (ValueError, AttributeError):
        return ""
    return message[:300] if isinstance(message, str) else ""


async def github_proxy(request: web.Request) -> web.StreamResponse:
    pid = require_admin(request)
    github = github_of(request)
    rest = W.bare_path(request.rel_url.raw_path)[len("/v1/admin/github/"):]
    repo, _, path = rest.partition("/")
    if not SAFE_PATH.match(rest) or ".." in rest or "//" in rest:
        raise Refused(404, "not_proxied", "the dashboard's proxy doesn't forward that")
    query = allowed(request.method, repo, path, request.rel_url.query)
    body = await save_body(request) if request.method == "PUT" else None

    accept = request.headers.get("Accept", "")
    headers = {"Accept": accept if accept in ACCEPT else "application/vnd.github+json"}
    if request.method == "GET":
        for name in CONDITIONAL:
            value = request.headers.get(name)
            if value and len(value) <= 200:
                headers[name] = value
    url = f"{github.base}/repos/{GITHUB_OWNER}/{repo}/{path}" + (f"?{urlencode(query)}" if query else "")
    status, upstream, data = await ask_github(github, request.method, url, headers, body)
    log.info("github %s %s/%s for %s: %d, %d bytes", request.method, repo, path, short(pid), status, len(data))

    reset = upstream.get("X-RateLimit-Reset")
    # The hourly limit (403 with none remaining) or a "secondary" one (403 or 429 with Retry-After).
    if status == 429 or (status == 403 and (upstream.get("X-RateLimit-Remaining") == "0" or "Retry-After" in upstream)):
        wait = upstream.get("Retry-After") or (str(max(1, int(reset) - int(time.time()))) if (reset or "").isdigit() else "60")
        raise Refused(429, "rate_limited", "GitHub's rate limit for the server's token is used up; try again later",
                      {"Retry-After": wait, **({"X-RateLimit-Reset": reset} if reset else {})})
    if status == 401:
        log.warning("github refused the token (401)")
        raise Refused(502, "github_token_refused",
                      "GitHub refused the server's token (GAMEDATA_GITHUB_TOKEN or GH_TOKEN): it's wrong, expired or revoked")
    if status == 403:
        needs = upstream.get("X-Accepted-GitHub-Permissions")
        log.warning("github said 403 to %s %s/%s", request.method, repo, path)
        raise Refused(502, "github_forbidden",
                      f"GitHub says the server's token can't do this ({github_message(data) or 'HTTP 403'})"
                      + (f"; it needs {needs}" if needs else ""))
    if status >= 500:
        raise Refused(502, "github_unavailable", f"GitHub had a problem (HTTP {status}); try again")

    response = web.Response(status=status, body=data if status != 304 else None)
    response.content_type = (upstream.get("Content-Type") or "application/json").split(";")[0]
    response.charset = "utf-8"
    for name in PASS_HEADERS:
        if name in upstream:
            response.headers[name] = upstream[name]
    # A commit's files never change: the browser may keep them as GitHub says (private, a minute).
    if request.method == "GET" and status in (200, 304) and "Cache-Control" in upstream:
        response.headers["Cache-Control"] = upstream["Cache-Control"]
    return response


async def github_check(request: web.Request) -> web.Response:
    """What the server's token can do for the dashboard: read feedback-data, read website's runs.
    Writing can't be tried without writing; a classic token's scopes (X-OAuth-Scopes) say it."""
    require_admin(request)
    github = github_of(request)
    repo = f"{github.base}/repos/{GITHUB_OWNER}"
    calls = {
        "feedback_data": f"{repo}/feedback-data",
        "feedback_data_contents": f"{repo}/feedback-data/contents/index.json?ref=main",
        "website_runs": f"{repo}/website/actions/workflows/feedback.yml/runs?per_page=1",
    }
    accept = {"Accept": "application/vnd.github.object+json"}
    answers = await asyncio.gather(*(ask_github(github, "GET", url, accept) for url in calls.values()),
                                   return_exceptions=True)
    statuses: dict[str, int | str] = {}
    scopes = None
    for name, answer in zip(calls, answers):
        if isinstance(answer, Refused):
            statuses[name] = answer.error
            continue
        if isinstance(answer, BaseException):
            raise answer
        status, headers, _ = answer
        statuses[name] = status
        scopes = headers.get("X-OAuth-Scopes", scopes)
    can = {"read_data": statuses["feedback_data_contents"] == 200, "read_runs": statuses["website_runs"] == 200,
           "write_data": ("repo" in [s.strip() for s in scopes.split(",")]) if scopes is not None else None}
    problems = []
    if 401 in statuses.values():
        problems.append("GitHub refuses the token")
    if not can["read_data"]:
        problems.append("it can't read fourgames/feedback-data (needs Contents: Read and write on it)")
    if not can["read_runs"]:
        problems.append("it can't read fourgames/website's workflow runs (needs Actions: Read on it)")
    if can["write_data"] is None and can["read_data"]:
        problems.append("whether it can save (Contents: Read and write on feedback-data) shows at the first save")
    return W.ok({"statuses": statuses, "scopes": scopes, "can": can,
                 "message": "; ".join(problems) if problems else "the token does everything the dashboard needs"})


# Sessions


def list_query(request: web.Request) -> dict[str, Any]:
    query = request.rel_url.query
    out: dict[str, Any] = {"app_id": None, "test": None, "limit": 50, "before": None}
    app_id = query.get("app_id", "")
    if app_id:
        if not app_id.isdigit() or len(app_id) > 10:
            raise Refused(400, "bad_request", "app_id must be a Steam app id")
        out["app_id"] = int(app_id)
    test = query.get("test", "").lower()
    if test in ("1", "true", "test"):
        out["test"] = True
    elif test in ("0", "false", "real"):
        out["test"] = False
    elif test not in ("", "all"):
        raise Refused(400, "bad_request", "test must be 1 (test sessions), 0 (real ones) or left out (both)")
    limit = query.get("limit", "")
    if limit:
        if not limit.isdigit() or not 1 <= int(limit) <= MAX_LIST:
            raise Refused(400, "bad_request", f"limit must be 1 to {MAX_LIST}")
        out["limit"] = int(limit)
    before = query.get("before", "")
    if before:
        match = BEFORE.match(before)
        if not match:
            raise Refused(400, "bad_request", "before must be the next value of the previous page")
        out["before"] = (int(match.group(1)), match.group(2) or "")
    return out


async def sessions(request: web.Request) -> web.Response:
    pid = require_admin(request)
    store = request.app[W.STORE]
    rows, more = store.list_sessions(**list_query(request))
    log.info("sessions list for %s: %d", short(pid), len(rows))
    return W.ok({"sessions": rows, "next": f"{more[0]}:{more[1]}" if more else None,
                 "apps": store.session_apps()})


async def one_session(request: web.Request) -> dict[str, Any]:
    session_id = request.match_info["session_id"]
    if not SESSION_ID.match(session_id):
        raise Refused(404, "not_found", "no session with that id")
    try:
        found = await asyncio.to_thread(export.session, request.app[W.CONFIG].data_dir, session_id)
    except export.SessionTooLarge:
        raise Refused(413, "too_large", "this session's events are too large to put together here") from None
    if found is None:
        raise Refused(404, "not_found", "no session with that id")
    return found


async def session_detail(request: web.Request) -> web.Response:
    pid = require_admin(request)
    found = await one_session(request)
    log.info("session %s for %s: %d events", found["session_id"][:8], short(pid), len(found["events"]))
    response = W.ok({"session": found})
    response.enable_compression()
    return response


async def session_summary(request: web.Request) -> web.Response:
    pid = require_admin(request)
    found = await one_session(request)
    text = await asyncio.to_thread(summary.build, found)
    log.info("session summary %s for %s: %d bytes", found["session_id"][:8], short(pid), len(text))
    return web.Response(text=text, content_type="text/plain", charset="utf-8")


# Plumbing


def github_context(base: str):
    async def context(app: web.Application):
        session = aiohttp.ClientSession()
        app[GITHUB] = GitHub(session, base, app[W.CONFIG].github_token)
        yield
        await session.close()
    return context


def add_routes(app: web.Application, prefix: str) -> None:
    v1 = f"{prefix}/v1/admin"
    add = app.router.add_route
    add("GET", f"{v1}/me", me)
    add("GET", f"{v1}/github-check", github_check)
    add("GET", f"{v1}/github/{{repo}}/{{path:.+}}", github_proxy)
    add("PUT", f"{v1}/github/{{repo}}/{{path:.+}}", github_proxy)
    add("GET", f"{v1}/sessions", sessions)
    add("GET", f"{v1}/sessions/{{session_id}}", session_detail)
    add("GET", f"{v1}/sessions/{{session_id}}/summary", session_summary)
    add("OPTIONS", f"{v1}/{{rest:.*}}", W.preflight)
