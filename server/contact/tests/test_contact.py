"""The contact backend, end to end through aiohttp's test client. No network: SMTP is a fake."""

from __future__ import annotations

import asyncio
import logging
import smtplib

import aiohttp
import pytest
from aiohttp.test_utils import TestClient, TestServer

from contact import mail
from contact.checks import RateLimiter, Rejected, check, safe_filename
from contact.config import Config, ConfigError
from contact.web import make_app

ORIGIN = "https://fourgames.se"
ENV = {"SMTP_USER": "support@fourgames.se", "SMTP_PASSWORD": "pw"}
GOOD = {"email": "ana@studio.com", "message": "Hi Four Games, we'd love to work with you.",
        "_subject": "New message from fourgames.se (en)", "_gotcha": "", "_elapsed": "12000"}


def config(**overrides) -> Config:
    return Config.from_env({**ENV, **overrides})


class Outbox:
    def __init__(self, fail: bool = False):
        self.sent = []
        self.fail = fail

    def __call__(self, cfg, message):
        if self.fail:
            raise smtplib.SMTPServerDisconnected("ana@studio.com went away")
        self.sent.append(message)


def run(cfg: Config, outbox: Outbox, steps):
    async def go():
        client = TestClient(TestServer(make_app(cfg, send=outbox)))
        await client.start_server()
        try:
            return await steps(client)
        finally:
            await client.close()
    return asyncio.run(go())


def post(fields=None, *, json=False, origin=ORIGIN, path="/contact", headers=None):
    fields = GOOD if fields is None else fields
    async def steps(client):
        h = {"Accept": "application/json", **({"Origin": origin} if origin else {}), **(headers or {})}
        if json:
            response = await client.post(path, json=fields, headers=h)
        else:
            response = await client.post(path, data=fields, headers=h)
        return response.status, await response.json(), dict(response.headers)
    return steps


# Config

def test_config_defaults():
    cfg = config()
    assert (cfg.smtp_host, cfg.smtp_port, cfg.port, cfg.host) == ("smtp.strato.com", 587, 8101, "127.0.0.1")
    assert cfg.mail_to == "support@fourgames.se"
    assert cfg.mail_from == "support@fourgames.se"
    assert cfg.allowed_origins == (ORIGIN,)


def test_config_needs_smtp_login():
    with pytest.raises(ConfigError):
        Config.from_env({})


def test_config_dev_origins():
    cfg = config(CONTACT_ALLOWED_ORIGINS="https://fourgames.se, http://localhost:5173,http://localhost:4173/")
    assert cfg.allowed_origins == (ORIGIN, "http://localhost:5173", "http://localhost:4173")


# The checks on their own

def test_check_cleans_fields():
    sub = check({**GOOD, "_subject": "Line\r\nBcc: x@y.z"}, 3)
    assert sub.email == "ana@studio.com"
    assert "\n" not in sub.subject


@pytest.mark.parametrize("fields, reason", [
    ({**GOOD, "_elapsed": "800"}, "too fast"),
    ({k: v for k, v in GOOD.items() if k != "_elapsed"}, "time field"),
    ({**GOOD, "_elapsed": "soon"}, "time field"),
    ({**GOOD, "email": ""}, "required"),
    ({**GOOD, "message": "   "}, "required"),
    ({**GOOD, "email": "not-an-email"}, "email"),
    ({**GOOD, "email": "a@b"}, "email"),
    ({**GOOD, "email": "a@b.com\r\nBcc: x@y.com"}, "email"),
    ({**GOOD, "email": "a" * 250 + "@b.com"}, "email"),
    ({**GOOD, "message": "x" * 5001}, "too long"),
    ({**GOOD, "message": "buy http://a.com http://b.com www.c.com https://d.com"}, "links"),
    ({**GOOD, "message": "cheap [url=http://a.com]pills[/url]"}, "links"),
    ({**GOOD, "message": 'see <a href="http://a.com">this</a>'}, "links"),
])
def test_check_rejects(fields, reason):
    with pytest.raises(Rejected) as info:
        check(fields, 3)
    assert reason in info.value.reason
    assert not info.value.silent


def test_a_few_links_are_fine():
    check({**GOOD, "message": "Our game: https://store.steampowered.com/app/1 and www.studio.com"}, 3)


def test_honeypot_is_silent():
    with pytest.raises(Rejected) as info:
        check({**GOOD, "_gotcha": "http://spam"}, 3)
    assert info.value.silent


def test_rate_limiter_window():
    now = [0.0]
    limiter = RateLimiter(2, 60, clock=lambda: now[0])
    assert limiter.allow("a") and limiter.allow("a")
    assert not limiter.allow("a")
    assert limiter.allow("b")
    now[0] = 61
    assert limiter.allow("a")


# The endpoint

def test_form_post_sends_mail():
    outbox = Outbox()
    status, body, headers = run(config(), outbox, post())
    assert (status, body) == (200, {"ok": True})
    assert headers["Access-Control-Allow-Origin"] == ORIGIN
    [message] = outbox.sent
    assert message["To"] == "support@fourgames.se"
    assert message["From"] == "support@fourgames.se"
    assert message["Reply-To"] == "ana@studio.com"
    assert message["Subject"] == "New message from fourgames.se (en)"
    assert "we'd love to work with you" in message.get_content()


def test_json_post_and_root_path():
    outbox = Outbox()
    status, body, _ = run(config(CONTACT_TO="team@fourgames.se", CONTACT_FROM="web@fourgames.se"),
                          outbox, post({**GOOD, "_elapsed": 12000}, json=True, path="/"))
    assert (status, body) == (200, {"ok": True})
    assert outbox.sent[0]["To"] == "team@fourgames.se"
    assert outbox.sent[0]["From"] == "web@fourgames.se"


def test_honeypot_fakes_success_and_sends_nothing():
    outbox = Outbox()
    status, body, _ = run(config(), outbox, post({**GOOD, "_gotcha": "x"}))
    assert (status, body) == (200, {"ok": True})
    assert outbox.sent == []


def test_invalid_fields_400():
    outbox = Outbox()
    status, body, _ = run(config(), outbox, post({**GOOD, "email": "nope"}))
    assert status == 400 and body["ok"] is False and "email" in body["error"]
    assert outbox.sent == []


def test_too_fast_400():
    status, body, _ = run(config(), Outbox(), post({**GOOD, "_elapsed": "500"}))
    assert status == 400 and "fast" in body["error"]


@pytest.mark.parametrize("origin", [None, "https://evil.example", "http://localhost:5173"])
def test_other_origins_403(origin):
    outbox = Outbox()
    status, body, headers = run(config(), outbox, post(origin=origin))
    assert status == 403 and body["ok"] is False
    assert "Access-Control-Allow-Origin" not in headers
    assert outbox.sent == []


def test_dev_origin_when_allowed():
    cfg = config(CONTACT_ALLOWED_ORIGINS="https://fourgames.se,http://localhost:5173")
    status, _, headers = run(cfg, Outbox(), post(origin="http://localhost:5173"))
    assert status == 200 and headers["Access-Control-Allow-Origin"] == "http://localhost:5173"


def test_preflight():
    async def steps(client):
        response = await client.options("/contact", headers={
            "Origin": ORIGIN, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type"})
        return response.status, dict(response.headers)
    status, headers = run(config(), Outbox(), steps)
    assert status == 204
    assert headers["Access-Control-Allow-Origin"] == ORIGIN
    assert "POST" in headers["Access-Control-Allow-Methods"]


def test_rate_limit_per_forwarded_ip():
    cfg = config(CONTACT_RATE_LIMIT="2")
    outbox = Outbox()

    async def steps(client):
        statuses = []
        for ip in ["1.1.1.1", "1.1.1.1", "1.1.1.1", "2.2.2.2"]:
            response = await client.post("/contact", data=GOOD, headers={
                "Origin": ORIGIN, "X-Forwarded-For": ip})
            statuses.append(response.status)
        return statuses
    assert run(cfg, outbox, steps) == [200, 200, 429, 200]
    assert len(outbox.sent) == 3


def test_smtp_failure_502_without_leaking(caplog):
    caplog.set_level(logging.INFO)
    status, body, _ = run(config(), Outbox(fail=True), post())
    assert status == 502 and body["ok"] is False
    assert "ana@studio.com" not in caplog.text


def test_logs_have_no_email_or_message(caplog):
    caplog.set_level(logging.INFO)
    run(config(), Outbox(), post(headers={"X-Forwarded-For": "9.8.7.6"}))
    run(config(), Outbox(), post({**GOOD, "email": "bad"}))
    assert "sent for" in caplog.text
    for secret in ("ana@studio.com", "love to work", "9.8.7.6"):
        assert secret not in caplog.text


def test_unsupported_body_415():
    async def steps(client):
        response = await client.post("/contact", data=b"hi", headers={
            "Origin": ORIGIN, "Content-Type": "text/plain"})
        return response.status, await response.json()
    status, body = run(config(), Outbox(), steps)
    assert status == 415 and body["ok"] is False


def test_too_big_body_413():
    status, body, _ = run(config(), Outbox(), post({**GOOD, "message": "x" * 70_000}))
    assert status == 413 and body["ok"] is False


@pytest.mark.parametrize("path", ["/health", "/contact/health"])
def test_health(path):
    async def steps(client):
        response = await client.get(path)
        return response.status, await response.json()
    assert run(config(), Outbox(), steps) == (200, {"ok": True})


def test_discord_notice_has_no_address_or_body(monkeypatch):
    seen = []

    async def fake_notify(session, url, sub):
        seen.append(f"{mail.mask_email(sub.email)} {sub.subject}")
    monkeypatch.setattr(mail, "notify_discord", fake_notify)
    cfg = config(CONTACT_DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/1/x")
    status, _, _ = run(cfg, Outbox(), post())
    assert status == 200
    assert seen == ["someone at studio.com New message from fourgames.se (en)"]


def test_discord_failure_still_ok(monkeypatch):
    async def broken(session, url, sub):
        raise RuntimeError("down")
    monkeypatch.setattr(mail, "notify_discord", broken)
    cfg = config(CONTACT_DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/1/x")
    outbox = Outbox()
    status, body, _ = run(cfg, outbox, post())
    assert (status, body) == (200, {"ok": True}) and len(outbox.sent) == 1


def test_send_email_uses_starttls(monkeypatch):
    calls = []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            calls.append(("connect", host, port))
        def __enter__(self):
            return self
        def __exit__(self, *exc):
            return False
        def starttls(self, context):
            calls.append(("starttls",))
        def login(self, user, password):
            calls.append(("login", user))
        def send_message(self, message):
            calls.append(("send", message["Reply-To"]))
    monkeypatch.setattr(mail.smtplib, "SMTP", FakeSMTP)
    cfg = config()
    sub = check(GOOD, 3)
    mail.send_email(cfg, mail.build_email(cfg, sub, "abc"))
    assert calls == [("connect", "smtp.strato.com", 587), ("starttls",),
                     ("login", "support@fourgames.se"), ("send", "ana@studio.com")]


# The PDF attachment

PDF = b"%PDF-1.7\n" + b"x" * 2000 + b"\n%%EOF\n"


def upload(data: bytes, filename: str, content_type: str = "application/pdf", fields=None, name="attachment"):
    """A multipart post like the browser's FormData, with one file."""
    async def steps(client):
        form = aiohttp.FormData()
        for key, value in (GOOD if fields is None else fields).items():
            form.add_field(key, value)
        form.add_field(name, data, filename=filename, content_type=content_type)
        response = await client.post("/contact", data=form, headers={"Origin": ORIGIN, "Accept": "application/json"})
        return response.status, await response.json(), dict(response.headers)
    return steps


def test_config_attachment_limit():
    assert config().max_attachment == 5 * 1024 * 1024
    assert config(CONTACT_MAX_ATTACHMENT_MB="2").max_attachment == 2 * 1024 * 1024


def test_pdf_is_attached_to_the_email():
    outbox = Outbox()
    # The browser's content type doesn't matter; the name and the bytes do.
    status, body, _ = run(config(), outbox, upload(PDF, "Ana CV.PDF", content_type="application/octet-stream"))
    assert (status, body) == (200, {"ok": True})
    [message] = outbox.sent
    [part] = list(message.iter_attachments())
    assert part.get_content_type() == "application/pdf"
    assert part.get_filename() == "Ana CV.pdf"
    assert part.get_content() == PDF
    assert "we'd love to work with you" in message.get_body(("plain",)).get_content()


def test_no_attachment_multipart_still_works():
    async def steps(client):
        form = aiohttp.FormData()
        for key, value in GOOD.items():
            form.add_field(key, value)
        # What a browser sends for a file input with nothing chosen.
        form.add_field("attachment", b"", filename="", content_type="application/octet-stream")
        response = await client.post("/contact", data=form, headers={"Origin": ORIGIN})
        return response.status, await response.json()
    outbox = Outbox()
    assert run(config(), outbox, steps) == (200, {"ok": True})
    [message] = outbox.sent
    assert not message.is_multipart()
    assert list(message.iter_attachments()) == []


def test_non_pdf_rejected():
    outbox = Outbox()
    status, body, _ = run(config(), outbox, upload(b"MZ\x90\x00 not a pdf", "setup.exe", content_type="application/pdf"))
    assert status == 400 and body["ok"] is False and "PDF" in body["error"]
    assert outbox.sent == []


def test_fake_pdf_without_magic_bytes_rejected():
    outbox = Outbox()
    status, body, _ = run(config(), outbox, upload(b"<html>hello</html>", "cv.pdf"))
    assert status == 400 and "isn't a PDF" in body["error"]
    assert outbox.sent == []


def test_too_big_pdf_413():
    outbox = Outbox()
    big = PDF + b"x" * (1024 * 1024)
    status, body, _ = run(config(CONTACT_MAX_ATTACHMENT_MB="1"), outbox, upload(big, "cv.pdf"))
    assert status == 413 and body["ok"] is False
    assert outbox.sent == []


def test_way_too_big_request_413():
    # Over the whole request's limit (PDF limit + 64 KB): stopped while reading.
    status, body, _ = run(config(CONTACT_MAX_ATTACHMENT_MB="1"), Outbox(), upload(PDF + b"x" * (3 * 1024 * 1024), "cv.pdf"))
    assert status == 413 and body["ok"] is False


def test_big_text_fields_in_multipart_413():
    status, body, _ = run(config(), Outbox(), upload(PDF, "cv.pdf", fields={**GOOD, "message": "x" * 70_000}))
    assert status == 413 and body["ok"] is False


def test_other_file_fields_are_ignored():
    outbox = Outbox()
    status, _, _ = run(config(), outbox, upload(b"whatever", "x.exe", name="other"))
    assert status == 200
    assert list(outbox.sent[0].iter_attachments()) == []


def test_honeypot_with_pdf_sends_nothing():
    outbox = Outbox()
    status, body, _ = run(config(), outbox, upload(PDF, "cv.pdf", fields={**GOOD, "_gotcha": "x"}))
    assert (status, body) == (200, {"ok": True}) and outbox.sent == []


@pytest.mark.parametrize("name, safe", [
    ("CV.PDF", "CV.pdf"),
    ("../../etc/passwd.pdf", "passwd.pdf"),
    ("C:\\Users\\ana\\Mörk Åsa CV.pdf", "Mork Asa CV.pdf"),
    ("履歴書.pdf", "attachment.pdf"),
    (".pdf", "attachment.pdf"),
    ("my<cv>\r\nBcc: x.pdf", "my_cv_Bcc_ x.pdf"),
    ("a" * 200 + ".pdf", "a" * 76 + ".pdf"),
])
def test_safe_filename(name, safe):
    assert safe_filename(name) == safe


def test_logs_and_discord_never_show_the_file(monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    seen = []

    async def fake_notify(session, url, sub):
        seen.append(sub)
    monkeypatch.setattr(mail, "notify_discord", fake_notify)
    cfg = config(CONTACT_DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/1/x")
    run(cfg, Outbox(), upload(PDF, "Secret Name CV.pdf"))
    run(cfg, Outbox(), upload(b"nope", "Secret Name CV.pdf"))
    assert "Secret Name" not in caplog.text and "%PDF" not in caplog.text
    assert "sent for" in caplog.text
    assert seen and seen[0].attachment is not None


def test_discord_text_mentions_the_pdf_only():
    posted = []

    class FakeResponse:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *exc):
            return False
        def raise_for_status(self):
            pass

    class FakeSession:
        def post(self, url, json, timeout):
            posted.append(json["content"])
            return FakeResponse()
    sub = check(GOOD, 3)
    from dataclasses import replace
    from contact.checks import check_attachment
    sub = replace(sub, attachment=check_attachment("Secret Name CV.pdf", PDF, 5 * 1024 * 1024))
    asyncio.run(mail.notify_discord(FakeSession(), "https://x", sub))
    assert posted == ["New contact form message from someone at studio.com, subject: "
                      "New message from fourgames.se (en), with a PDF attached"]
