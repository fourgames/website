"""Sending: the email over SMTP with STARTTLS, and the optional Discord notice."""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

import aiohttp

from .checks import Submission
from .config import Config


def build_email(config: Config, sub: Submission, ip_hash: str) -> EmailMessage:
    mail = EmailMessage()
    mail["From"] = config.mail_from
    mail["To"] = config.mail_to
    # Replying in the mail app answers the person who wrote.
    mail["Reply-To"] = sub.email
    mail["Subject"] = sub.subject
    mail["Date"] = formatdate(localtime=False)
    mail["Message-ID"] = make_msgid(domain=config.mail_from.rpartition("@")[2] or None)
    mail.set_content(f"From: {sub.email}\n\n{sub.message}\n\n--\nSent with the contact form on fourgames.se (sender {ip_hash}).\n")
    return mail


def send_email(config: Config, mail: EmailMessage) -> None:
    """Blocking; web.py runs it in a thread. Raises on any failure."""
    context = ssl.create_default_context()
    with smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=20) as smtp:
        smtp.starttls(context=context)
        smtp.login(config.smtp_user, config.smtp_password)
        smtp.send_message(mail)


def mask_email(email: str) -> str:
    """Only the domain, for Discord: the channel shouldn't collect people's addresses."""
    return f"someone at {email.rpartition('@')[2]}"


async def notify_discord(session: aiohttp.ClientSession, url: str, sub: Submission) -> None:
    # No message text and no address: just that there's something in the inbox.
    content = f"New contact form message from {mask_email(sub.email)}, subject: {sub.subject}"
    payload = {"content": content[:1900], "allowed_mentions": {"parse": []}}
    async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as response:
        response.raise_for_status()
