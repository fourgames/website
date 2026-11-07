"""The confirm email, sent over SMTP with STARTTLS through the Strato mailbox."""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from urllib.parse import quote

from .config import Config
from .store import Pending
from .texts import text


def confirm_url(config: Config, token: str) -> str:
    return f"{config.public_url}/confirm?t={quote(token)}"


def unsubscribe_url(config: Config, token: str) -> str:
    return f"{config.public_url}/unsubscribe?t={quote(token)}"


def build_confirm_email(config: Config, p: Pending) -> EmailMessage:
    unsub = unsubscribe_url(config, p.unsub_token)
    mail = EmailMessage()
    mail["From"] = formataddr((config.from_name, config.mail_from))
    mail["To"] = p.email
    mail["Subject"] = text(p.lang, "subject")
    mail["Date"] = formatdate(localtime=False)
    mail["Message-ID"] = make_msgid(domain=config.mail_from.rpartition("@")[2] or None)
    # One-click unsubscribe in the mail app (RFC 8058): it POSTs to this link.
    mail["List-Unsubscribe"] = f"<{unsub}>"
    mail["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    body = text(p.lang, "body").format(confirm=confirm_url(config, p.confirm_token))
    footer = text(p.lang, "footer").format(unsub=unsub)
    # 8bit, not quoted-printable: the links stay whole and readable in the raw email.
    mail.set_content(f"{body}\n\n--\n{footer}\n", cte="8bit")
    return mail


def send_email(config: Config, mail: EmailMessage) -> None:
    """Blocking; web.py runs it in a thread. Raises on any failure."""
    with smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=20) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        smtp.login(config.smtp_user, config.smtp_password)
        smtp.send_message(mail)
