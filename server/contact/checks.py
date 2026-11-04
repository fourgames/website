"""Checking a submission: the fields, and the anti-spam rules. No I/O here, so it's easy to test."""

from __future__ import annotations

import re
import time
import unicodedata
from collections import defaultdict, deque
from dataclasses import dataclass

MAX_EMAIL = 254
MAX_SUBJECT = 200
MIN_MESSAGE = 2
MAX_MESSAGE = 5000
# More links than this reads as advertising, not a message to a game studio.
MAX_LINKS = 3

EMAIL = re.compile(r"^[^@\s<>\"',;]+@[^@\s<>\"',;]+\.[^@\s<>\"',;.]{2,}$")
LINK = re.compile(r"https?://|www\.", re.IGNORECASE)
# Forum and HTML link markup: no person writes that in a contact form.
MARKUP = re.compile(r"\[url[=\]]|<a\s+href", re.IGNORECASE)

# Field names the form sends. _gotcha is the honeypot (hidden; people leave it empty) and
# _elapsed the milliseconds between the form appearing and being sent (set by the page's script).
HONEYPOT = "_gotcha"
ELAPSED = "_elapsed"
# The optional PDF (a CV or portfolio).
ATTACHMENT = "attachment"
PDF_MAGIC = b"%PDF-"
MAX_FILENAME = 80
FALLBACK_FILENAME = "attachment.pdf"


class Rejected(Exception):
    """A submission we don't send. `silent` ones get a fake success, so bots learn nothing."""

    def __init__(self, reason: str, status: int = 400, silent: bool = False):
        super().__init__(reason)
        self.reason = reason
        self.status = status
        self.silent = silent


@dataclass(frozen=True)
class Attachment:
    filename: str  # already made safe for the email
    data: bytes


@dataclass(frozen=True)
class Submission:
    email: str
    message: str
    subject: str
    attachment: Attachment | None = None


def one_line(text: str) -> str:
    return " ".join(text.split())


def check(fields: dict[str, str], min_seconds: float) -> Submission:
    """The cleaned submission, or Rejected with the reason."""
    if (fields.get(HONEYPOT) or "").strip():
        raise Rejected("honeypot", silent=True)

    # Elapsed time instead of a timestamp: it doesn't depend on the visitor's clock being right.
    raw = (fields.get(ELAPSED) or "").strip()
    try:
        elapsed = float(raw) / 1000
    except ValueError:
        raise Rejected("missing or bad time field") from None
    if elapsed < min_seconds:
        raise Rejected("sent too fast")

    email = (fields.get("email") or "").strip()
    message = (fields.get("message") or "").strip()
    subject = one_line(fields.get("_subject") or "") or "New message from fourgames.se"

    if not email or not message:
        raise Rejected("email and message are required")
    if len(email) > MAX_EMAIL or not EMAIL.match(email):
        raise Rejected("that email address doesn't look right")
    if len(message) < MIN_MESSAGE:
        raise Rejected("the message is too short")
    if len(message) > MAX_MESSAGE:
        raise Rejected(f"the message is too long (at most {MAX_MESSAGE} characters)")
    if len(LINK.findall(message)) > MAX_LINKS or MARKUP.search(message):
        raise Rejected("too many links")
    return Submission(email=email, message=message, subject=subject[:MAX_SUBJECT])


def safe_filename(name: str) -> str:
    """The file's name for the email: no folders, ASCII only, at most MAX_FILENAME characters,
    ending in .pdf. Falls back to attachment.pdf when nothing usable is left."""
    name = re.split(r"[\\/]", name)[-1]
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name)
    name = re.sub(r"\s+", " ", name)
    stem = name[:-4] if name.lower().endswith(".pdf") else name
    stem = stem.strip(" ._-")
    if not stem.strip("_"):
        return FALLBACK_FILENAME
    return stem[:MAX_FILENAME - 4].rstrip(" ._-") + ".pdf"


def check_attachment(filename: str, data: bytes, max_bytes: int) -> Attachment:
    """A PDF by its name and its first bytes (the browser's content type isn't trusted). The
    reasons never quote the file's name."""
    if len(data) > max_bytes:
        raise Rejected(f"the file is too big (at most {max_bytes // (1024 * 1024)} MB)", status=413)
    if not filename.strip().lower().endswith(".pdf"):
        raise Rejected("only PDF files can be attached")
    if not data.startswith(PDF_MAGIC):
        raise Rejected("the attached file isn't a PDF")
    return Attachment(filename=safe_filename(filename.strip()), data=data)


class RateLimiter:
    """At most `limit` hits per `window` seconds for each key (a hashed IP). In memory: a restart
    forgets, which is fine for a contact form."""

    def __init__(self, limit: int, window: float, clock=time.monotonic):
        self.limit = limit
        self.window = window
        self.clock = clock
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = self.clock()
        hits = self.hits[key]
        while hits and hits[0] <= now - self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(now)
        # Keep the dict from growing with every IP ever seen.
        if len(self.hits) > 10_000:
            for k in [k for k, v in self.hits.items() if not v or v[-1] <= now - self.window]:
                del self.hits[k]
        return True
