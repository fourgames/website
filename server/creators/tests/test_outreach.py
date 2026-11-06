"""Outreach: drafts, the sending rules and reading replies, with a fake mail server."""

import smtplib
from datetime import datetime
from email.message import EmailMessage
from zoneinfo import ZoneInfo

import pytest

from creators import outreach
from creators.send import Sender, Settings, own_words

STOCKHOLM = ZoneInfo("Europe/Stockholm")
# Tuesday 2026-11-10 10:00 in Stockholm: a sending hour on a weekday.
NOW = datetime(2026, 11, 10, 10, tzinfo=STOCKHOLM).timestamp()


@pytest.fixture
def store(tmp_path):
    s = outreach.open_store(str(tmp_path / "c.db"))
    rows = [("UCa", "Alpha Plays", '["alpha@mail.com"]'), ("UCb", "Beta", "[]"), ("UCc", "Gamma", '["shared@mail.com"]'),
            ("UCd", "Delta", '["shared@mail.com"]'), ("UCe", "Eps", "[]")]
    for cid, title, emails in rows:
        s.db.execute("INSERT INTO youtube_channels (channel_id, title, emails, first_seen) VALUES (?, ?, ?, 0)", (cid, title, emails))
    s.db.execute("INSERT INTO youtube_videos (video_id, appid, channel_id, found_at) VALUES ('v1', 99, 'UCa', 0)")
    s.db.execute("INSERT INTO youtube_videos (video_id, appid, channel_id, found_at) VALUES ('v2', 5, 'UCa', 0)")
    s.db.execute("INSERT INTO channel_links VALUES ('UCe', 'https://e.com', 'about')")
    s.db.execute("INSERT INTO sites VALUES ('https://e.com', 0, 'ok', '[\"eps@e.com\"]')")
    s.db.execute("INSERT INTO press (key, name, url, kind, email, added_at, updated_at) VALUES "
                 "('site.jp', 'Site JP', 'https://site.jp', 'press', 'News@Site.jp', 0, 0)")
    s.db.commit()
    yield s
    s.close()


SPEC = {"appid": 1, "game": "Pomo Valley", "audience": "creators", "from_name": "Danny from Pomo Valley",
        "from_email": "pomovalley@fourgames.se", "subject": "{game} for {name}?",
        "body": "Hi {name},\nI saw your {their_game} video. {game}: {steam}\nDanny", "daily_limit": 10,
        "recipients": ["UCa", "UCb", "UCc", "UCd", "UCe", "UCnope"]}
GAMES = {1: "Pomo Valley", 99: "Our Old Game", 5: "Other Game"}


def make(store, spec=SPEC, now=NOW):
    return outreach.create_campaign(store, dict(spec), GAMES, own={1, 99}, now=now)


def test_draft_fills_in_each_message_and_skips_the_unusable(store):
    out = make(store)
    assert out["counts"] == {"queued": 3} and out["campaign"]["status"] == "draft"
    assert out["skipped"] == {"no email": 2, "listed twice": 1}
    msgs = {m["target_id"]: m for m in outreach.messages(store, out["id"])}
    assert set(msgs) == {"UCa", "UCc", "UCe"} and msgs["UCe"]["email"] == "eps@e.com"
    a = msgs["UCa"]
    assert a["subject"] == "Pomo Valley for Alpha Plays?"
    assert "I saw your Our Old Game video" in a["body"]  # ours first
    assert "https://store.steampowered.com/app/1/" in a["body"] and a["body"].endswith(outreach.OPT_OUT_LINE)
    with pytest.raises(outreach.OutreachError):
        make(store, {**SPEC, "from_email": "nope"})
    with pytest.raises(outreach.OutreachError):
        make(store, {**SPEC, "recipients": []})


def test_never_twice_and_never_after_an_opt_out(store):
    make(store)
    again = make(store, {**SPEC, "recipients": ["UCa"]})
    assert again["counts"] == {} and again["skipped"] == {"contacted recently": 1}
    outreach.suppress(store, "eps@e.com", "opted_out", NOW)
    assert outreach.blocked(store, "eps@e.com", NOW) == "opted_out"
    press = make(store, {**SPEC, "audience": "press", "recipients": ["site.jp"], "body": "Hello {name} team"})
    assert outreach.messages(store, press["id"])[0]["email"] == "news@site.jp"


class FakeSMTP:
    def __init__(self, refuse=()):
        self.sent, self.refuse = [], set(refuse)

    def send_message(self, mail):
        to = str(mail["To"])
        if any(r in to for r in self.refuse):
            raise smtplib.SMTPRecipientsRefused({to: (550, b"no such user")})
        self.sent.append(mail)

    def quit(self):
        pass


def sender(store, smtp, now=NOW, imap=None, **kw):
    settings = Settings(user="danny@fourgames.se", password="x", daily_max=kw.pop("daily_max", 40), pause=(0, 0))
    return Sender(settings, store, smtp_factory=lambda: smtp, imap_factory=imap, clock=lambda: now, sleep=lambda s: None)


def test_nothing_goes_before_approval_and_then_slowly(store):
    out = make(store)
    smtp = FakeSMTP()
    assert sender(store, smtp).send_due() == {"sent": 0, "failed": 0}  # still a draft
    outreach.set_status(store, out["id"], "approved", NOW)
    first = sender(store, smtp, daily_max=4).send_due()
    assert first["sent"] == 1  # 4 a day spread over the day's remaining runs
    mail = smtp.sent[0]
    assert str(mail["From"]) == "Danny from Pomo Valley <pomovalley@fourgames.se>"
    assert str(mail["List-Unsubscribe"]) == "<mailto:pomovalley@fourgames.se?subject=unsubscribe>"
    rest = sender(store, smtp, daily_max=40).send_due()
    assert rest["sent"] == 2 and outreach.summary(store, out["id"])["campaign"]["status"] == "done"
    night = datetime(2026, 11, 10, 22, tzinfo=STOCKHOLM).timestamp()
    saturday = datetime(2026, 11, 14, 10, tzinfo=STOCKHOLM).timestamp()
    s2 = make(store, {**SPEC, "recipients": ["UCb"]})  # no usable recipient: nothing queued anyway
    assert not sender(store, smtp, night).in_hours() and not sender(store, smtp, saturday).in_hours()
    assert s2["counts"] == {}


def test_refused_recipient_and_opt_out_before_sending(store):
    out = make(store)
    outreach.set_status(store, out["id"], "approved", NOW)
    outreach.suppress(store, "eps@e.com", "opted_out", NOW)  # after the draft: skipped, not sent
    smtp = FakeSMTP(refuse={"shared@mail.com"})
    result = sender(store, smtp).send_due()
    assert result == {"sent": 1, "failed": 1}
    statuses = {m["target_id"]: m["status"] for m in outreach.messages(store, out["id"])}
    assert statuses == {"UCa": "sent", "UCc": "failed", "UCe": "skipped"}


def test_replies_opt_outs_and_bounces(store):
    out = make(store)
    outreach.set_status(store, out["id"], "approved", NOW)
    smtp = FakeSMTP()
    sender(store, smtp).send_due()
    sender(store, smtp).send_due()  # the drip sends a couple per run
    assert len(smtp.sent) == 3
    by = {str(m["To"]).split("<")[-1].rstrip(">"): m for m in smtp.sent}
    s = sender(store, smtp)

    def mail(frm, body, refs=None, subject="Re: hi", ctype=None):
        m = EmailMessage()
        m["From"], m["Subject"] = frm, subject
        if refs:
            m["In-Reply-To"] = refs
        m.set_content(body)
        return m

    assert s.handle(mail("Alpha <alpha@mail.com>", "Sounds fun, send a key!\n\nOn Tue Danny wrote:\n> no", by["alpha@mail.com"]["Message-ID"])) == "replied"
    assert s.handle(mail("x@other.com", "No thanks.\n> Hi Gamma", by["shared@mail.com"]["Message-ID"])) == "opted_out"
    assert outreach.blocked(store, "shared@mail.com", NOW) == "opted_out"
    assert s.handle(mail("MAILER-DAEMON@strato.de", "Delivery failed for eps@e.com: user unknown")) == "bounced"
    assert outreach.blocked(store, "eps@e.com", NOW) == "bounced"
    assert s.handle(mail("random@x.com", "hello")) is None
    statuses = {m["email"]: m["status"] for m in outreach.messages(store, out["id"])}
    assert statuses == {"alpha@mail.com": "replied", "shared@mail.com": "opted_out", "eps@e.com": "bounced"}


def test_own_words_cuts_the_quote():
    assert own_words("Sure!\n\nOn Mon, 9 Nov 2026 Danny <d@x.se> wrote:\n> Not interested? reply no") == "Sure!"
    assert own_words("> quoted only") == ""


def test_status_changes(store):
    out = make(store)
    with pytest.raises(outreach.OutreachError):
        outreach.set_status(store, out["id"], "paused", NOW)  # a draft can't be paused
    outreach.set_status(store, out["id"], "approved", NOW)
    with pytest.raises(outreach.OutreachError):
        outreach.set_status(store, out["id"], "deleted", NOW)  # only drafts can be deleted
    msg = outreach.messages(store, out["id"])[0]
    outreach.skip_message(store, msg["id"])
    assert outreach.summary(store, out["id"])["counts"]["skipped"] == 1
    assert Settings.from_env({"SEND_HOURS": "8-20", "DAILY_MAX": "25"}).hours == (8, 20)
    with pytest.raises(ValueError):
        Settings.from_env({"SEND_HOURS": "20-8"})
