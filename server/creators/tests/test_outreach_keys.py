"""Steam keys in outreach emails ({key}): taken from the key bot when sent, given back on failure,
and the same key again for the same channel (also on Discord)."""

import asyncio
from email.message import EmailMessage
from types import SimpleNamespace

import pytest

from creators import keys as K
from creators import outreach
from creators.send import Sender, Settings
from keybot.db import Store as KeyStore
from creators.tests.test_outreach import GAMES, NOW, SPEC, FakeSMTP, store  # noqa: F401 - store is a fixture

BODY = "Hi {name},\n\nI made {game}.\n\nFree key: {key}\n\nThanks,\nDanny\nFour Games"


@pytest.fixture
def keystore(tmp_path, monkeypatch):
    path = str(tmp_path / "keys.db")
    monkeypatch.setenv("KEYBOT_DB", path)
    ks = KeyStore(path)
    game, _ = ks.add_game("Pomo Valley", steam_app_id=1)
    ks.add_keys(game["id"], ["AAAAA-BBBBB-CCCC1", "AAAAA-BBBBB-CCCC2", "AAAAA-BBBBB-CCCC3"])
    yield ks
    ks.close()


def make(store, **over):
    return outreach.create_campaign(store, {**SPEC, "body": BODY, **over}, GAMES, own={1, 99}, now=NOW)


def send(store, smtp, path):
    s = Sender(Settings(user="u", password="p", pause=(0, 0)), store, smtp_factory=lambda: smtp,
               clock=lambda: NOW, sleep=lambda _: None, keys_factory=lambda: KeyStore(path))
    try:
        total = {"sent": 0, "failed": 0}
        for _ in range(5):  # the drip sends a few per run
            for k, v in s.send_due().items():
                total[k] += v
        return s, total
    finally:
        s.close()


def given(ks):
    return {r["given_to"]: r["value"] for r in ks.db.execute("SELECT given_to, value FROM keys WHERE status = 'given'")}


def test_key_goes_in_when_sent_and_is_recorded_for_the_channel(store, keystore, tmp_path):
    out = make(store)
    msgs = outreach.messages(store, out["id"])
    assert all("Free key: {key}" in m["body"] for m in msgs)  # the draft keeps the placeholder
    assert keystore.available_count(1) == 3  # nothing taken for a draft
    outreach.set_status(store, out["id"], "approved", NOW)
    smtp = FakeSMTP(refuse={"shared@mail.com"})
    send(store, smtp, str(tmp_path / "keys.db"))
    assert len(smtp.sent) == 2
    bodies = {str(m["To"]).split("<")[-1].rstrip(">"): m.get_content() for m in smtp.sent}
    holders = given(keystore)
    assert set(holders) == {"yt:UCa", "yt:UCe"}  # the refused one gave its key back
    assert f"Free key: {holders['yt:UCa']}" in bodies["alpha@mail.com"]
    assert "{key}" not in bodies["alpha@mail.com"]
    assert "AAAAA" not in "".join(m["body"] for m in outreach.messages(store, out["id"]))  # keys only in the key bot


def test_same_channel_gets_the_same_key_again(store, keystore):
    who = K.holder("youtube", "UCa")
    first = K.take(keystore, 1, who, "creator")
    again = K.take(keystore, 1, who, "creator")
    assert first[:2] == again[:2] and first[2] and not again[2]


def test_bounce_gives_the_key_back(store, keystore, tmp_path):
    out = make(store, recipients=["UCe"])
    outreach.set_status(store, out["id"], "approved", NOW)
    s, _ = send(store, FakeSMTP(), str(tmp_path / "keys.db"))
    assert set(given(keystore)) == {"yt:UCe"}
    bounce = EmailMessage()
    bounce["From"], bounce["Subject"] = "MAILER-DAEMON@strato.de", "Undelivered"
    bounce.set_content("Delivery failed for eps@e.com: user unknown")
    assert s.handle(bounce) == "bounced"
    s.close()
    assert given(keystore) == {} and keystore.available_count(1) == 3


def test_approving_needs_enough_keys_and_the_game_in_the_bot(store, keystore):
    with pytest.raises(outreach.OutreachError, match="Steam app id"):
        make(store, appid=5)
    out = make(store)  # 3 emails, 3 keys: fine
    keystore.give_key(1, 42, "member")  # now 2 left
    with pytest.raises(outreach.OutreachError, match="needs 3 keys"):
        outreach.set_status(store, out["id"], "approved", NOW)
    K.take(keystore, 1, "yt:UCa", "creator")  # UCa already got one by email: it needs none now
    keystore.add_keys(1, ["AAAAA-BBBBB-CCCC4"])
    outreach.set_status(store, out["id"], "approved", NOW)


def test_out_of_keys_pauses_the_campaign(store, keystore, tmp_path):
    out = make(store)
    outreach.set_status(store, out["id"], "approved", NOW)
    keystore.give_key(1, 1, "member")
    keystore.give_key(1, 2, "member")
    smtp = FakeSMTP()
    send(store, smtp, str(tmp_path / "keys.db"))
    assert len(smtp.sent) == 1
    c = outreach.summary(store, out["id"])["campaign"]
    assert c["status"] == "paused" and "Out of keys" in c["paused_reason"]


def test_translations_keep_the_key(store, keystore):
    good = {"de": {"subject": "{game}", "body": "Hallo {name}, {game}. Schlüssel: {key}", "opt_out": "x"}}
    outreach.check_translations(good, "{game}", "Hi {name}, {game}. Key: {key}")
    with pytest.raises(outreach.OutreachError):
        outreach.check_translations({"de": {**good["de"], "body": "Hallo {name}, {game}."}}, "{game}", "Hi {name}, {game}. Key: {key}")


@pytest.mark.parametrize("raw, clean", [
    ("Bob Plays | Indie Games Every Day", "Bob Plays"), ("Sarah - Let's Plays", "Sarah"), ("GamerX Official", "GamerX"),
    ("Mike TV", "Mike"), ("Jean-Luc Games", "Jean-Luc Games"), ("Official", "Official"), ("", ""), ("Splattercat Gaming", "Splattercat Gaming"),
])
def test_greeting_name(raw, clean):
    assert outreach.greeting_name(raw) == clean


def test_discord_request_hands_out_the_emailed_key(keystore):
    pytest.importorskip("discord")
    from keybot.bot import KeyBot
    from keybot.eligibility import Channel
    K.take(keystore, 1, "yt:UCa", "creator")
    sent = []

    async def dm(text):
        sent.append(text)

    user = SimpleNamespace(id=777, send=dm)
    bot = SimpleNamespace(store=keystore, config=SimpleNamespace(thresholds=None))

    async def user_by_id(_):
        return user
    bot.user_by_id = user_by_id
    title, text = asyncio.run(KeyBot.creator_verified(bot, 777, 1, [Channel("youtube", "UCa", "Alpha", "u")]))
    assert title == "You already have a key" and "DMs" in text
    assert keystore.user_key(1, 777) is not None and "yt:UCa" not in given(keystore)
    assert sent and "AAAAA-BBBBB-CCCC1" in str(sent[0])


def test_claim_emailed_moves_the_key_to_the_discord_user(keystore):
    K.take(keystore, 1, "tw:555", "creator")
    assert keystore.claim_emailed(1, ["yt:UCzzz"], 9) is None
    got = keystore.claim_emailed(1, ["yt:UCzzz", "tw:555"], 9)
    assert got.status == "given" and got.value == "AAAAA-BBBBB-CCCC1"
    assert keystore.user_key(1, 9)["value"] == got.value and "tw:555" not in given(keystore)
