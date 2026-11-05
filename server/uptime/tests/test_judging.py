"""Each part is judged the way status.js judges it, through fake answers and files (no network)."""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from uptime import check
from uptime.check import DEGRADED, DOWN, UP, Checker, Response

NOW = 1_800_000_000.0


def fake_get(answers: dict, calls: list | None = None):
    """A `get` answering from `answers` (url -> Response, or an exception to raise)."""
    def get(url, timeout=check.TIMEOUT, follow_redirects=True):
        if calls is not None:
            calls.append((url, timeout, follow_redirects))
        answer = answers[url]
        if isinstance(answer, Exception):
            raise answer
        return answer
    return get


def health(body: dict, status: int = 200) -> Response:
    return Response(status, json.dumps(body).encode())


def checker(answers=None, files=None, calls=None) -> Checker:
    files = files or {}

    def read(path):
        name = path.rsplit("/", 1)[-1]
        value = files.get(name)
        if isinstance(value, Exception):
            raise value
        return value

    return Checker(get=fake_get(answers or {}, calls), read=read, now=lambda: NOW, status_dir="/status")


# --- website ---

def test_website_up_on_200_with_its_own_timeout():
    calls = []
    assert checker({"https://fourgames.se/": Response(200, b"<html>")}, calls=calls).website() == UP
    assert calls == [("https://fourgames.se/", 10, True)]


@pytest.mark.parametrize("answer", [Response(404, b""), Response(503, b""), TimeoutError(), OSError("no route")])
def test_website_down_otherwise(answer):
    assert checker({"https://fourgames.se/": answer}).website() == DOWN


# --- feedback loop (own, research) ---

@pytest.mark.parametrize("part,age,ok,expected", [
    ("own", 60, True, UP),
    ("own", 15 * 60, True, UP),
    ("own", 15 * 60 + 1, True, DEGRADED),     # later than usual
    ("own", 60, False, DEGRADED),             # the last run didn't finish
    ("own", 60 * 60, False, DEGRADED),
    ("own", 60 * 60 + 1, True, DOWN),         # none since
    ("research", 70 * 60, True, UP),          # research gets more room
    ("research", 75 * 60 + 1, True, DEGRADED),
    ("research", 2 * 60 * 60 + 1, True, DOWN),
])
def test_feedback_limits(part, age, ok, expected):
    files = {f"{part}.json": {"lastRunAt": NOW - age, "lastRunOk": ok}}
    assert checker(files=files).feedback(part) == expected


@pytest.mark.parametrize("report", [None, {}, {"lastRunAt": "soon"}, {"lastRunAt": 0, "lastRunOk": True}, [1, 2]])
def test_feedback_without_a_usable_report_is_down(report):
    assert checker(files={"own.json": report}).feedback("own") == DOWN


def test_feedback_unreadable_report_is_down():
    assert checker(files={"own.json": ValueError("broken json")}).feedback("own") == DOWN


def test_feedback_reads_the_part_s_file():
    seen = []
    c = Checker(read=lambda p: seen.append(p) or None, now=lambda: NOW, status_dir="/srv/fourgames/status")
    c.feedback("research")
    assert seen == ["/srv/fourgames/status/research.json"]


# --- health endpoints ---

ALERTS = "https://api.fourgames.se/alerts/health"
GAMEDATA = "https://api.fourgames.se/gamedata/health"
KEYBOT = "https://api.fourgames.se/keybot/health"
CONNECTED = {"ok": True, "youtube": {"subscribed": True}, "twitch": {"subscription": "enabled"}}


def test_health_up_on_ok_true():
    assert checker({KEYBOT: health({"ok": True})}).checks()["keybot"]() == UP


@pytest.mark.parametrize("answer", [
    health({"ok": True}, status=502),           # Caddy: the service is stopped
    health({"ok": False}),
    health({"status": "fine"}),
    Response(200, b"not json"),
    Response(200, b"[true]"),
    TimeoutError(),
    OSError("connection refused"),
])
def test_health_down_otherwise(answer):
    assert checker({KEYBOT: answer}).health("/keybot/health") == DOWN


def test_every_health_part_uses_its_own_url():
    calls = []
    answers = {f"https://api.fourgames.se/{x}/health": health(CONNECTED) for x in ("keybot", "contact", "alerts", "gamedata")}
    checks = checker(answers, calls=calls).checks()
    assert [checks[x]() for x in ("keybot", "contact", "alerts", "gamedata")] == [UP] * 4
    assert [c[0] for c in calls] == list(answers)


def test_alerts_up_with_youtube_and_twitch():
    assert checker({ALERTS: health(CONNECTED)}).checks()["alerts"]() == UP


@pytest.mark.parametrize("body", [
    {"ok": True, "youtube": {"subscribed": False}, "twitch": {"subscription": "enabled"}},
    {"ok": True, "youtube": {"subscribed": True}, "twitch": {"subscription": "webhook_callback_verification_failed"}},
    {"ok": True},
])
def test_alerts_degraded_without_youtube_or_twitch(body):
    assert checker({ALERTS: health(body)}).checks()["alerts"]() == DEGRADED


def test_alerts_down_beats_degraded():
    assert checker({ALERTS: health({"ok": False})}).checks()["alerts"]() == DOWN


def test_gamedata_degraded_on_low_disk():
    body = {"ok": True, "disk": {"low_space": True, "free_bytes": 1}}
    assert checker({GAMEDATA: health(body)}).checks()["gamedata"]() == DEGRADED
    body["disk"]["low_space"] = False
    assert checker({GAMEDATA: health(body)}).checks()["gamedata"]() == UP


# --- Steam broadcasts ---

def stream(name, sending=True):
    return {"name": name, "sending": sending, "upForSeconds": 100}


@pytest.mark.parametrize("report", [
    None,                                                        # never set up
    {"checkedAt": NOW, "streams": []},                           # no stream: the row is hidden
    {"checkedAt": NOW - 11 * 60, "streams": [stream("a")]},      # its own status is stale
    {"streams": [stream("a")]},
    "nonsense",
])
def test_broadcast_not_counted(report):
    assert checker(files={"broadcast.json": report}).broadcast() is None


def test_broadcast_unreadable_report_not_counted():
    assert checker(files={"broadcast.json": ValueError("half a file")}).broadcast() is None


@pytest.mark.parametrize("streams,expected", [
    ([stream("a")], UP),
    ([stream("a"), stream("b")], UP),
    ([stream("a"), stream("b", False)], DEGRADED),
    ([stream("a", False), stream("b", False)], DOWN),
])
def test_broadcast_streams(streams, expected):
    files = {"broadcast.json": {"checkedAt": NOW - 60, "streams": streams}}
    assert checker(files=files).broadcast() == expected


# --- short links ---

@pytest.mark.parametrize("status,expected", [(301, UP), (302, UP), (308, UP), (200, DOWN), (404, DOWN), (502, DOWN)])
def test_links(status, expected):
    calls = []
    assert checker({"https://discord.fourgames.se/": Response(status, b"")}, calls=calls).links() == expected
    assert calls[0][2] is False  # the redirect isn't followed


def test_links_down_when_unreachable():
    assert checker({"https://discord.fourgames.se/": OSError("tls")}).links() == DOWN


# --- running them together ---

def test_checks_cover_every_part():
    assert list(Checker().checks()) == list(check.PARTS)


def test_run_checks_runs_them_at_once():
    def slow(state):
        def run():
            time.sleep(0.4)
            return state
        return run
    started = time.monotonic()
    results = check.run_checks({f"p{n}": slow(UP) for n in range(9)})
    assert time.monotonic() - started < 1.5
    assert results == {f"p{n}": UP for n in range(9)}


def test_run_checks_raising_is_down_none_is_left_out_and_slow_is_down():
    def boom():
        raise RuntimeError("bug")

    def hang():
        time.sleep(1.0)
        return UP
    results = check.run_checks({"a": boom, "b": lambda: None, "c": lambda: DEGRADED, "d": hang}, deadline=0.2)
    assert results == {"a": DOWN, "c": DEGRADED, "d": DOWN}


# --- http_get against a local server (no network) ---

class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/moved":
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()
        elif self.path == "/broken":
            self.send_response(502)
            self.end_headers()
        else:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok": true}')

    def log_message(self, *args):
        pass


@pytest.fixture
def local_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def test_http_get(local_server):
    assert check.http_get(f"{local_server}/") == Response(200, b'{"ok": true}')
    assert check.http_get(f"{local_server}/broken").status == 502
    assert check.http_get(f"{local_server}/moved").status == 200
    assert check.http_get(f"{local_server}/moved", follow_redirects=False).status == 302


def test_http_get_raises_when_nothing_answers():
    with pytest.raises(OSError):
        check.http_get("http://127.0.0.1:9/", timeout=2)
