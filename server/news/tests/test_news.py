"""The fan mailing list, end to end through aiohttp's test client. No network: SMTP is a fake."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import smtplib

import pytest
from aiohttp.test_utils import TestClient, TestServer

from news.config import Config, ConfigError
from news.store import PENDING_DAYS, RESEND_AFTER, Store
from news.web import make_app

ORIGIN = "https://fourgames.se"
ENV = {"MAIL_USER": "danny@fourgames.se", "MAIL_PASSWORD": "pw", "NEWS_FROM": "news@fourgames.se"}
GOOD = {"email": "Fan@Example.com", "lang": "en", "_gotcha": "", "_elapsed": "4000"}


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


class Outbox:
    def __init__(self, fail: bool = False):
        self.sent = []
        self.fail = fail

    def __call__(self, cfg, message):
        if self.fail:
            raise smtplib.SMTPRecipientsRefused({"fan@example.com": (550, b"no")})
        self.sent.append(message)

    def link(self, kind: str, i: int = -1) -> str:
        """The path and query of the confirm or unsubscribe link in email i."""
        body = self.sent[i].get_content()
        return re.search(rf"https://api\.fourgames\.se(/news/{kind}\?t=\S+)", body).group(1)


@pytest.fixture
def env(tmp_path):
    clock = Clock()
    cfg = Config.from_env({**ENV, "NEWS_DIR": str(tmp_path)})
    return cfg, Store(str(tmp_path), clock=clock), clock, tmp_path


def run(env, outbox, steps, **overrides):
    cfg, store, clock, _ = env
    if overrides:
        cfg = Config.from_env({**ENV, "NEWS_DIR": cfg.data_dir, **overrides})

    async def go():
        client = TestClient(TestServer(make_app(cfg, send=outbox, store=store)))
        await client.start_server()
        try:
            return await steps(client)
        finally:
            await client.close()
    return asyncio.run(go())


async def signup(client, fields=None, origin=ORIGIN, as_json=True):
    fields = GOOD if fields is None else fields
    headers = {"Origin": origin} if origin else {}
    if as_json:
        response = await client.post("/news/subscribe", json=fields, headers=headers)
    else:
        response = await client.post("/news/subscribe", data=fields, headers=headers)
    return response.status, await response.json()


def stats(env):
    return json.loads((env[3] / "stats.json").read_text())


# Config

def test_config_defaults():
    cfg = Config.from_env(ENV)
    assert (cfg.smtp_host, cfg.smtp_port, cfg.port, cfg.host) == ("smtp.strato.com", 587, 8104, "127.0.0.1")
    assert cfg.mail_from == "news@fourgames.se" and cfg.from_name == "Four Games"
    assert cfg.public_url == "https://api.fourgames.se/news"
    assert Config.from_env({"MAIL_USER": "a@b.se", "MAIL_PASSWORD": "x"}).mail_from == "a@b.se"


def test_config_needs_the_mailbox():
    with pytest.raises(ConfigError):
        Config.from_env({})


# The whole way: sign up, confirm, unsubscribe

def test_signup_confirm_unsubscribe(env):
    outbox = Outbox()

    async def steps(client):
        assert await signup(client) == (200, {"ok": True})
        assert len(outbox.sent) == 1
        mail = outbox.sent[0]
        assert mail["To"] == "fan@example.com"
        assert mail["From"] == "Four Games <news@fourgames.se>"
        assert mail["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"
        assert mail["List-Unsubscribe"].startswith("<https://api.fourgames.se/news/unsubscribe?t=")
        assert stats(env)["confirmed"] == 0 and stats(env)["pending"] == 1

        # Opening the link only shows the button: a mail scanner can't confirm.
        response = await client.get(outbox.link("confirm"))
        page = await response.text()
        assert response.status == 200 and "Yes, add me" in page and 'method="post"' in page
        assert env[1].confirmed_emails() == []

        token = outbox.link("confirm").split("t=")[1]
        response = await client.post("/news/confirm", data={"t": token})
        assert response.status == 200 and "on the list" in await response.text()
        assert [e for e, _, _ in env[1].confirmed_emails()] == ["fan@example.com"]
        assert stats(env)["confirmed"] == 1 and stats(env)["pending"] == 0

        # The link works once.
        response = await client.post("/news/confirm", data={"t": token})
        assert response.status == 404 and "work any more" in await response.text()

        # Unsubscribe: the page has one button, pressing it deletes the address.
        response = await client.get(outbox.link("unsubscribe"))
        assert "Unsubscribe" in await response.text()
        unsub = outbox.link("unsubscribe").split("t=")[1]
        response = await client.post("/news/unsubscribe", data={"t": unsub})
        assert response.status == 200 and "unsubscribed" in await response.text()
        assert env[1].confirmed_emails() == []
        s = stats(env)
        assert s["confirmed"] == 0 and s["pending"] == 0
        day = next(iter(s["days"].values()))
        assert day == {"signup": 1, "confirmed": 1, "unsubscribed": 1}
        assert "fan@" not in (env[3] / "stats.json").read_text()
    run(env, outbox, steps)


def test_one_click_unsubscribe_from_the_mail_app(env):
    outbox = Outbox()

    async def steps(client):
        await signup(client)
        await client.post("/news/confirm", data={"t": outbox.link("confirm").split("t=")[1]})
        response = await client.post(outbox.link("unsubscribe"), data="List-Unsubscribe=One-Click",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        assert response.status == 200
        assert env[1].confirmed_emails() == []
    run(env, outbox, steps)


def test_signup_in_another_language(env):
    outbox = Outbox()

    async def steps(client):
        await signup(client, {**GOOD, "lang": "ja"}, as_json=False)
        assert "確認" in outbox.sent[0]["Subject"]
        response = await client.get(outbox.link("confirm"))
        page = await response.text()
        assert 'lang="ja"' in page and "https://fourgames.se/ja/" in page
        await signup(client, {**GOOD, "email": "b@example.com", "lang": "xx"})
        assert outbox.sent[1]["Subject"] == "Confirm your email for Four Games news"
    run(env, outbox, steps)


# Nothing that tells who's on the list, and no flooding anyone

def test_already_confirmed_gets_the_same_answer_and_no_email(env):
    outbox = Outbox()

    async def steps(client):
        await signup(client)
        await client.post("/news/confirm", data={"t": outbox.link("confirm").split("t=")[1]})
        env[2].now += RESEND_AFTER + 1
        assert await signup(client, {**GOOD, "email": "FAN@example.com"}) == (200, {"ok": True})
        assert len(outbox.sent) == 1
    run(env, outbox, steps)


def test_resends_are_spaced_and_capped(env):
    outbox = Outbox()
    clock = env[2]

    async def steps(client):
        await signup(client)
        assert await signup(client) == (200, {"ok": True})
        assert len(outbox.sent) == 1  # too soon
        clock.now += RESEND_AFTER + 1
        await signup(client)
        assert len(outbox.sent) == 2
        # The new link replaces the old one.
        old = outbox.link("confirm", 0).split("t=")[1]
        response = await client.post("/news/confirm", data={"t": old})
        assert response.status == 404
        clock.now += RESEND_AFTER + 1
        await signup(client)
        clock.now += RESEND_AFTER + 1
        await signup(client)
        assert len(outbox.sent) == 3  # at most three
        # The unsubscribe link stays the same.
        assert outbox.link("unsubscribe", 0) == outbox.link("unsubscribe", 2)
    run(env, outbox, steps, NEWS_RATE_LIMIT="50")


def test_unconfirmed_signups_are_forgotten(env):
    outbox = Outbox()

    async def steps(client):
        await signup(client)
        env[2].now += PENDING_DAYS * 86400 + 1
        response = await client.post("/news/confirm", data={"t": outbox.link("confirm").split("t=")[1]})
        assert response.status == 404
        assert env[1].db.execute("SELECT COUNT(*) FROM subscribers").fetchone()[0] == 0
    run(env, outbox, steps)


def test_daily_cap(env):
    outbox = Outbox()

    async def steps(client):
        for i in range(3):
            await signup(client, {**GOOD, "email": f"f{i}@example.com"})
        assert len(outbox.sent) == 2
        assert (await signup(client, {**GOOD, "email": "z@example.com"}))[0] == 429
    run(env, outbox, steps, NEWS_DAILY_MAX="2", NEWS_RATE_LIMIT="50")


# The checks

def test_rejections(env):
    outbox = Outbox()

    async def steps(client):
        assert (await signup(client, origin="https://evil.example"))[0] == 403
        assert (await signup(client, origin=None))[0] == 403
        assert (await signup(client, {**GOOD, "email": "not-an-email"}))[0] == 400
        assert (await signup(client, {**GOOD, "email": "a" * 250 + "@x.se"}))[0] == 400
        assert (await signup(client, {**GOOD, "_elapsed": "300"}))[0] == 400
        assert (await signup(client, {**GOOD, "_elapsed": ""}))[0] == 400
        # The honeypot looks like a success and sends nothing.
        assert await signup(client, {**GOOD, "_gotcha": "x"}) == (200, {"ok": True})
        assert outbox.sent == []
    run(env, outbox, steps, NEWS_RATE_LIMIT="50")


def test_rate_limit(env):
    outbox = Outbox()

    async def steps(client):
        for i in range(2):
            assert (await signup(client, {**GOOD, "email": f"f{i}@example.com"}))[0] == 200
        assert (await signup(client, {**GOOD, "email": "f9@example.com"}))[0] == 429
    run(env, outbox, steps, NEWS_RATE_LIMIT="2")


def test_cors_and_preflight(env):
    async def steps(client):
        response = await client.options("/news/subscribe", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST"})
        assert response.status == 204 and response.headers["Access-Control-Allow-Origin"] == ORIGIN
        response = await client.options("/subscribe", headers={"Origin": "https://evil.example"})
        assert "Access-Control-Allow-Origin" not in response.headers
        response = await client.get("/news/health")
        assert await response.json() == {"ok": True}
    run(env, Outbox(), steps)


def test_send_failure_keeps_nothing_and_logs_no_address(env, caplog):
    outbox = Outbox(fail=True)
    caplog.set_level(logging.INFO)

    async def steps(client):
        assert (await signup(client))[0] == 502
        assert env[1].db.execute("SELECT COUNT(*) FROM subscribers").fetchone()[0] == 0
        outbox.fail = False
        assert (await signup(client))[0] == 200  # a retry works at once
        assert len(outbox.sent) == 1
    run(env, outbox, steps)
    assert "example.com" not in caplog.text.lower()


def test_bad_links(env):
    async def steps(client):
        for path in ("/news/confirm", "/news/confirm?t=nope", "/news/confirm?t=" + "x" * 500):
            response = await client.get(path)
            assert response.status == 404
        response = await client.get("/news/unsubscribe?t=nope")
        assert response.status == 200 and "unsubscribed" in await response.text()
        response = await client.post("/news/unsubscribe", data={"t": "nope"})
        assert response.status == 200
    run(env, Outbox(), steps)


def test_pages_escape_the_token(env):
    outbox = Outbox()

    async def steps(client):
        await signup(client)
        response = await client.get(outbox.link("confirm"))
        assert "<script" not in await response.text()
        assert response.headers["Content-Security-Policy"].startswith("default-src 'none'")
    run(env, outbox, steps)
