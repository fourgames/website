"""Sends approved outreach emails slowly and reads the inbox for replies: python -m creators.send
(creators-send.timer, every 15 minutes). See outreach.py for how campaigns work.

Each run:
  1. Reads new mail in the inbox over IMAP (read only; nothing is moved, deleted or marked read):
     a reply to one of our emails marks it replied; a reply that says no ("no", "no thanks", "not
     interested", "unsubscribe", "stop", "remove me") marks it opted out and the address is never
     emailed again; a bounce marks it bounced, with the same effect.
  2. In sending hours (SEND_HOURS, TIMEZONE) and under DAILY_MAX for the day across all campaigns
     (and each campaign's own daily limit), sends the next few queued messages of approved
     campaigns, oldest campaign first, a short random pause between them. A campaign with nothing
     left to send becomes done. An email with {key} gets its Steam key from the key bot's pool right
     before it goes out (keys.py); if it can't be sent or it bounces, the key goes back. A campaign
     whose game runs out of keys pauses itself.

Settings: /etc/fourgames/outreach.env (outreach.env.example). The mailbox password is the owner's
to put there; without MAIL_USER and MAIL_PASSWORD nothing is sent or read.
"""

from __future__ import annotations

import email
import email.policy
import imaplib
import logging
import math
import os
import random
import re
import smtplib
import ssl
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid, parseaddr
from typing import Callable
from zoneinfo import ZoneInfo

from . import dmarc, outreach
from . import keys as K
from .config import DEFAULT_DB_PATH

log = logging.getLogger("creators.send")

RUNS_PER_HOUR = 4
# A reply that says no: a bare "no" (the whole reply), or a clear phrase at its start. "No problem,
# send me a key!" is a yes.
OPT_OUT = re.compile(r"^\s*(?:no|nope|nah)\s*[.!]*\s*$|^\s*no,? thanks|^\s*no thank you|not interested|unsubscribe|"
                     r"stop emailing|please stop|remove me|take me off|no more emails?|don'?t (?:contact|email|write|send)|"
                     r"(?:don'?t|do not) want (?:any )?(?:more |future )?emails?|i'?d rather not|"
                     # The same in the languages emails go out in.
                     r"^\s*(?:nein|non|nej|nee|nie|não|nao|нет|いいえ)\s*[.!]*\s*$|nein,? danke|kein interesse|non merci|pas int[ée]ress[ée]|"
                     r"no,? gracias|no me interesa|n[ãa]o,? obrigad|n[ãa]o tenho interesse|nie,? dzi[eę]kuj[eę]|nie jestem zainteresowan|"
                     r"нет,? спасибо|не интересно|興味(?:が)?ありません|結構です|관심 없|아니요|不感兴趣|不用了|nej tack|inte intresserad|nee,? bedankt|geen interesse",
                     re.IGNORECASE)
QUOTE_START = re.compile(r"^(>|On .{5,200} wrote:|Am .{5,200} schrieb|Le .{5,200} a écrit|El .{5,200} escribió|-{2,}\s*Original)",
                         re.IGNORECASE | re.MULTILINE)


@dataclass(frozen=True)
class Settings:
    db_path: str = DEFAULT_DB_PATH
    smtp_host: str = "smtp.strato.com"
    smtp_port: int = 587
    imap_host: str = "imap.strato.com"
    imap_port: int = 993
    user: str = ""
    password: str = ""
    daily_max: int = 40
    hours: tuple[int, int] = (9, 18)     # local hours to send in: from 9:00 to before 18:00
    timezone: str = "Europe/Stockholm"
    pause: tuple[float, float] = (25.0, 90.0)

    @classmethod
    def from_env(cls, env=None) -> "Settings":
        env = os.environ if env is None else env
        get = lambda k, d="": (env.get(k, "") or "").strip() or d  # noqa: E731
        hours = get("SEND_HOURS", "9-18")
        m = re.fullmatch(r"(\d{1,2})-(\d{1,2})", hours)
        if not m or not 0 <= int(m[1]) < int(m[2]) <= 24:
            raise ValueError(f"SEND_HOURS must look like 9-18, not {hours!r}")
        daily = int(get("DAILY_MAX", "40"))
        if not 1 <= daily <= 500:
            raise ValueError("DAILY_MAX must be between 1 and 500")
        ZoneInfo(get("TIMEZONE", "Europe/Stockholm"))
        return cls(db_path=get("DB_PATH", DEFAULT_DB_PATH), smtp_host=get("SMTP_HOST", "smtp.strato.com"),
                   smtp_port=int(get("SMTP_PORT", "587")), imap_host=get("IMAP_HOST", "imap.strato.com"),
                   imap_port=int(get("IMAP_PORT", "993")), user=get("MAIL_USER"), password=get("MAIL_PASSWORD"),
                   daily_max=daily, hours=(int(m[1]), int(m[2])), timezone=get("TIMEZONE", "Europe/Stockholm"))


def build(msg: dict, campaign: dict, now: float, key: str | None = None) -> EmailMessage:
    """The email; key fills {key} (the stored message keeps the placeholder, so the key is only in the key bot)."""
    if key is not None:
        msg = {**msg, "subject": msg["subject"].replace(K.PLACEHOLDER, key), "body": msg["body"].replace(K.PLACEHOLDER, key)}
    mail = EmailMessage(policy=email.policy.SMTP)
    sender = campaign["from_email"]
    mail["From"] = formataddr((campaign["from_name"], sender))
    mail["To"] = formataddr((msg["name"] or "", msg["email"])) if msg["name"] and "@" not in (msg["name"] or "") else msg["email"]
    mail["Reply-To"] = sender
    mail["Subject"] = msg["subject"]
    mail["Date"] = formatdate(now, localtime=False)
    mail["Message-ID"] = make_msgid(domain=sender.rpartition("@")[2])
    mail["List-Unsubscribe"] = f"<mailto:{sender}?subject=unsubscribe>"
    mail.set_content(msg["body"])
    if campaign.get("gif"):  # plain text only unless the campaign asked for the GIF version
        mail.add_alternative(outreach.html_for(campaign, msg["body"]), subtype="html")
    return mail


def _text(message) -> str:
    """The plain text of a mail (its first text/plain part), or the HTML with tags removed."""
    part = message.get_body(preferencelist=("plain", "html")) if message.is_multipart() else message
    try:
        text = part.get_content() if part else ""
    except (KeyError, LookupError, AssertionError):
        text = ""
    if part is not None and part.get_content_type() == "text/html":
        text = re.sub(r"<[^>]+>", " ", text)
    return text if isinstance(text, str) else ""


def own_words(text: str) -> str:
    """What the person wrote above the quoted email."""
    m = QUOTE_START.search(text)
    return (text[:m.start()] if m else text).strip()


class Sender:
    def __init__(self, settings: Settings, store, smtp_factory: Callable | None = None,
                 imap_factory: Callable | None = None, clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep, keys_factory: Callable | None = None):
        self.s = settings
        self.store = store
        self.smtp_factory = smtp_factory or self._smtp
        self.imap_factory = imap_factory or self._imap
        self.clock = clock
        self.sleep = sleep
        self.keys_factory = keys_factory or K.open_keys
        self._keys = None

    @property
    def keys(self):
        """The key bot's database, opened the first time an email needs a key."""
        if self._keys is None:
            self._keys = self.keys_factory()
        return self._keys

    def close(self) -> None:
        if self._keys is not None:
            self._keys.close()
            self._keys = None

    def give_back(self, msg: dict, key_id: int | None) -> None:
        if key_id is not None:
            K.give_back(self.keys, key_id, K.holder(msg["target_kind"], msg["target_id"]))

    def _smtp(self):
        smtp = smtplib.SMTP(self.s.smtp_host, self.s.smtp_port, timeout=30)
        smtp.starttls(context=ssl.create_default_context())
        smtp.login(self.s.user, self.s.password)
        return smtp

    def _imap(self):
        imap = imaplib.IMAP4_SSL(self.s.imap_host, self.s.imap_port, ssl_context=ssl.create_default_context(), timeout=30)
        imap.login(self.s.user, self.s.password)
        return imap

    # Inbox
    def _state(self, key: str) -> str | None:
        row = self.store.db.execute("SELECT value FROM outreach_state WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def _set_state(self, key: str, value: str) -> None:
        with self.store.db:
            self.store.db.execute("INSERT INTO outreach_state (key, value) VALUES (?, ?) "
                                  "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))

    def check_inbox(self) -> dict[str, int]:
        counts = {"replied": 0, "opted_out": 0, "bounced": 0}
        # Reports come whether or not outreach has sent anything (the domain's other mail counts too).
        imap = self.imap_factory()
        try:
            imap.select("INBOX", readonly=True)
            validity = (imap.response("UIDVALIDITY")[1] or [b""])[0]
            validity = validity.decode() if isinstance(validity, bytes) else str(validity or "")
            last = int(self._state("imap_uid") or 0) if self._state("imap_validity") == validity else 0
            if last:
                typ, data = imap.uid("SEARCH", None, f"UID {last + 1}:*")
            else:  # first run (or the mailbox was rebuilt): the last two weeks
                since = (datetime.utcfromtimestamp(self.clock()) - timedelta(days=14)).strftime("%d-%b-%Y")
                typ, data = imap.uid("SEARCH", None, f"SINCE {since}")
            uids = [int(u) for u in (data[0] or b"").split() if int(u) > last] if typ == "OK" else []
            reports: list[str] = []
            for uid in uids[-500:]:
                typ, parts = imap.uid("FETCH", str(uid), "(BODY.PEEK[])")
                raw = next((p[1] for p in parts or [] if isinstance(p, tuple) and len(p) > 1), None)
                if not raw:
                    continue
                message = email.message_from_bytes(raw, policy=email.policy.default)
                if self.dmarc_report(message):
                    reports.append(str(uid))
                    continue
                kind = self.handle(message)
                if kind:
                    counts[kind] += 1
            if reports:
                counts["dmarc"] = len(reports)
                self.file_away(imap, reports)
            if uids:
                self._set_state("imap_uid", str(max(uids)))
            self._set_state("imap_validity", validity)
        finally:
            try:
                imap.logout()
            except Exception:  # noqa: BLE001
                pass
        return counts

    def dmarc_report(self, message) -> bool:
        """Saves a DMARC aggregate report sent to dmarc@ (True), else False. Only mail to dmarc@ counts."""
        to = " ".join(str(message.get(h, "")) for h in ("To", "Delivered-To", "X-Original-To")).lower()
        if "dmarc@" not in to:
            return False
        reports = dmarc.from_email(message)
        if reports:
            dmarc.save(self.store, reports, self.clock())
        return bool(reports)

    def file_away(self, imap, uids: list[str]) -> None:
        """Moves the read DMARC report emails into a DMARC folder (only those), so the inbox stays clean."""
        try:
            imap.select("INBOX")
            imap.create("DMARC")  # an error if it exists: fine
            uidset = ",".join(uids)
            typ, _ = imap.uid("MOVE", uidset, "DMARC")
            if typ != "OK":
                typ, _ = imap.uid("COPY", uidset, "DMARC")
                caps = b" ".join(imap.capabilities) if isinstance(imap.capabilities, tuple) else b""
                if typ == "OK" and b"UIDPLUS" in caps.upper():
                    imap.uid("STORE", uidset, "+FLAGS", "(\\Deleted)")
                    imap.uid("EXPUNGE", uidset)
        except imaplib.IMAP4.error as error:
            log.warning("couldn't move DMARC reports into their folder: %s", error)

    def handle(self, message) -> str | None:
        """Marks what this incoming mail says about our emails: 'replied', 'opted_out', 'bounced' or None."""
        db = self.store.db
        now = int(self.clock())
        sender = parseaddr(str(message.get("From", "")))[1].lower()
        refs = " ".join(str(message.get(h, "")) for h in ("In-Reply-To", "References"))
        text = _text(message)
        is_bounce = (sender.split("@")[0] in ("mailer-daemon", "postmaster")
                     or message.get_content_type() == "multipart/report")
        if is_bounce:
            body = text + " " + " ".join(str(p.get_payload()) for p in message.walk() if p.get_content_maintype() in ("message", "text"))
            for row in db.execute("SELECT id, email, key_id, target_kind, target_id FROM outreach_messages "
                                  "WHERE sent_at IS NOT NULL AND status IN ('sent', 'replied')").fetchall():
                mid, address = row["id"], row["email"]
                if address in body.lower():
                    with db:
                        db.execute("UPDATE outreach_messages SET status = 'bounced', error = 'bounced' WHERE id = ?", (mid,))
                    outreach.suppress(self.store, address, "bounced", now)
                    # Nobody got the email, so nobody got its key (unless another email to them carried it).
                    if row["key_id"] is not None and not db.execute(
                            "SELECT 1 FROM outreach_messages WHERE key_id = ? AND id != ? AND sent_at IS NOT NULL "
                            "AND status IN ('sent', 'replied', 'opted_out')", (row["key_id"], mid)).fetchone():
                        try:
                            self.give_back(dict(row), row["key_id"])
                        except Exception:  # noqa: BLE001 - the bounce still counts
                            log.exception("couldn't put the key of bounced message %s back", mid)
                    return "bounced"
            return None
        row = None
        for mid in re.findall(r"<[^>]+>", refs):
            row = db.execute("SELECT id, email FROM outreach_messages WHERE message_id = ?", (mid,)).fetchone()
            if row:
                break
        if row is None and sender:
            row = db.execute("SELECT id, email FROM outreach_messages WHERE email = ? AND sent_at IS NOT NULL "
                             "ORDER BY sent_at DESC LIMIT 1", (sender,)).fetchone()
        if row is None:
            return None
        said = own_words(text)
        no = bool(OPT_OUT.search(said)) or "unsubscribe" in str(message.get("Subject", "")).lower()
        with db:
            db.execute("UPDATE outreach_messages SET status = ?, replied_at = COALESCE(replied_at, ?) WHERE id = ?",
                       ("opted_out" if no else "replied", now, row[0]))
        if no:
            outreach.suppress(self.store, row[1], "opted_out", now)
            return "opted_out"
        return "replied"

    # Sending
    def in_hours(self) -> bool:
        local = datetime.fromtimestamp(self.clock(), ZoneInfo(self.s.timezone))
        return self.s.hours[0] <= local.hour < self.s.hours[1] and local.weekday() < 5

    def day_start(self) -> int:
        local = datetime.fromtimestamp(self.clock(), ZoneInfo(self.s.timezone))
        return int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())

    def send_due(self) -> dict[str, int]:
        counts = {"sent": 0, "failed": 0}
        if not self.in_hours():
            return counts
        db = self.store.db
        start = self.day_start()
        today = db.execute("SELECT COUNT(*) FROM outreach_messages WHERE sent_at >= ?", (start,)).fetchone()[0]
        runs_left = max(1, math.ceil((self.s.hours[1] * 3600 - (self.clock() - start)) / 3600 * RUNS_PER_HOUR))
        budget = min(self.s.daily_max - today, max(1, math.ceil((self.s.daily_max - today) / runs_left)))
        smtp = None
        try:
            for c in db.execute("SELECT * FROM outreach_campaigns WHERE status = 'approved' ORDER BY id").fetchall():
                c = dict(c)
                if budget <= 0:
                    break
                mine = db.execute("SELECT COUNT(*) FROM outreach_messages WHERE campaign_id = ? AND sent_at >= ?",
                                  (c["id"], start)).fetchone()[0]
                queue = db.execute("SELECT * FROM outreach_messages WHERE campaign_id = ? AND status = 'queued' ORDER BY id LIMIT ?",
                                   (c["id"], max(0, min(budget, c["daily_limit"] - mine)))).fetchall()
                for msg in queue:
                    msg = dict(msg)
                    # Checked again at sending time: an opt-out or another campaign may have come since the draft.
                    why = outreach.blocked(self.store, msg["email"], self.clock(), exclude=msg["id"], sent_only=True)
                    if why:
                        with db:
                            db.execute("UPDATE outreach_messages SET status = 'skipped', error = ? WHERE id = ?", (why, msg["id"]))
                        continue
                    if smtp is None:
                        smtp = self.smtp_factory()
                    elif counts["sent"] + counts["failed"]:
                        self.sleep(random.uniform(*self.s.pause))
                    key_id = key = None
                    new = False
                    if K.uses_key(msg["subject"] + msg["body"]):
                        who = K.holder(msg["target_kind"], msg["target_id"])
                        try:
                            key_id, key, new = K.take(self.keys, c["appid"], who, "press" if msg["target_kind"] == "press" else "creator")
                        except K.NoKeys as error:
                            reason = f"Out of keys: {error}. Add keys with /keys add, then resume."
                            with db:
                                db.execute("UPDATE outreach_campaigns SET status = 'paused', paused_reason = ? WHERE id = ?",
                                           (reason, c["id"]))
                            self._set_state("last_error", f"{c['game']}: {reason}")
                            log.warning("paused campaign %s: %s", c["id"], error)
                            break
                    mail = build(msg, c, self.clock(), key)
                    try:
                        smtp.send_message(mail)
                    except smtplib.SMTPSenderRefused as error:
                        self.give_back(msg, key_id if new else None)
                        # The from address isn't allowed for this mailbox (an alias missing in Strato): stop, keep queued.
                        log.error("Strato refused the from address %s (%s); add it as an alias of %s",
                                  c["from_email"], error.smtp_code, self.s.user)
                        self._set_state("last_error", f"Strato refused the from address {c['from_email']}: add it as an "
                                                      f"alias of {self.s.user} in Strato's mail settings. Nothing was sent.")
                        return counts
                    except smtplib.SMTPRecipientsRefused as error:
                        self.give_back(msg, key_id if new else None)
                        with db:
                            db.execute("UPDATE outreach_messages SET status = 'failed', error = ? WHERE id = ?",
                                       (f"refused: {list(error.recipients.values())[0][0]}"[:200], msg["id"]))
                        counts["failed"] += 1
                        continue
                    with db:
                        db.execute("UPDATE outreach_messages SET status = 'sent', sent_at = ?, message_id = ?, key_id = ? WHERE id = ?",
                                   (int(self.clock()), mail["Message-ID"], key_id, msg["id"]))
                        db.execute("DELETE FROM outreach_state WHERE key = 'last_error'")
                    counts["sent"] += 1
                    budget -= 1
                    if budget <= 0:
                        break
                left = db.execute("SELECT COUNT(*) FROM outreach_messages WHERE campaign_id = ? AND status = 'queued'",
                                  (c["id"],)).fetchone()[0]
                if not left:
                    with db:
                        db.execute("UPDATE outreach_campaigns SET status = 'done' WHERE id = ?", (c["id"],))
        finally:
            if smtp is not None:
                try:
                    smtp.quit()
                except Exception:  # noqa: BLE001
                    pass
        return counts

    def run(self) -> dict[str, int]:
        result: dict[str, int] = {}
        try:
            result.update(self.check_inbox())
        except (imaplib.IMAP4.error, OSError) as error:
            log.warning("reading the inbox failed: %s", type(error).__name__)
        # The safety brake first (bounces and no's arrive through the inbox), then sending.
        for what in outreach.apply_brake(self.store, self.clock()):
            log.warning("safety brake paused %s", what)
            result["paused"] = result.get("paused", 0) + 1
        result.update(self.send_due())
        return result


def main() -> int:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), format="%(levelname)s %(name)s: %(message)s")
    try:
        settings = Settings.from_env()
    except ValueError as error:
        print(f"creators.send: {error}", file=sys.stderr)
        return 2
    if not settings.user or not settings.password:
        log.info("no MAIL_USER / MAIL_PASSWORD in outreach.env: nothing sent or read")
        return 0
    store = outreach.open_store(settings.db_path)
    try:
        sender = Sender(settings, store)
        try:
            result = sender.run()
        finally:
            sender.close()
        with store.db:
            store.db.execute("INSERT OR REPLACE INTO outreach_state (key, value) VALUES ('last_run', ?)", (str(int(time.time())),))
    except smtplib.SMTPAuthenticationError:
        log.error("Strato refused the mailbox login (MAIL_USER / MAIL_PASSWORD in outreach.env)")
        with store.db:
            store.db.execute("INSERT OR REPLACE INTO outreach_state (key, value) VALUES ('last_error', ?)",
                             ("Strato refused the mailbox login: check MAIL_USER and MAIL_PASSWORD in /etc/fourgames/outreach.env.",))
        return 1
    finally:
        store.close()
    if any(result.values()):
        log.info("outreach: %s", ", ".join(f"{k} {v}" for k, v in result.items() if v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
