"""DMARC aggregate reports: once a day Gmail, Outlook, Yahoo and others report how many emails from
fourgames.se they got and whether each passed DKIM or SPF. send.py reads them from the inbox (sent to
dmarc@fourgames.se, an alias of the outreach mailbox), saves the numbers here, and moves the report
emails into a "DMARC" folder so they never clutter the inbox. The dashboard's Outreach tab shows the
last 30 days: if any receiver saw mail from us that failed, something in the setup broke.

The DNS side (owner's, at Strato): _dmarc.fourgames.se TXT "v=DMARC1;p=reject;rua=mailto:dmarc@fourgames.se".
"""

from __future__ import annotations

import gzip
import io
import json
import xml.etree.ElementTree as ET
import zipfile
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS dmarc_reports (
    report_id   TEXT PRIMARY KEY,       -- the reporter's id, with its name (ids aren't unique across reporters)
    org         TEXT NOT NULL,          -- who reported: google.com, Outlook.com, Yahoo...
    begin       INTEGER NOT NULL,       -- the day it covers (unix)
    end         INTEGER NOT NULL,
    messages    INTEGER NOT NULL,       -- emails from our domain it saw
    passed      INTEGER NOT NULL,       -- of those, passed DMARC (DKIM or SPF aligned)
    failed_from TEXT,                   -- JSON {source ip: count} of the ones that failed
    received_at INTEGER NOT NULL
);
"""

ATTACHMENT = (".xml", ".xml.gz", ".zip", ".gz")


def xml_of(name: str, data: bytes) -> bytes | None:
    """The report XML from an attachment (.zip, .gz or plain .xml), or None."""
    try:
        if name.endswith(".zip") or data[:2] == b"PK":
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                inner = next((n for n in z.namelist() if n.endswith(".xml")), None)
                return z.read(inner)[:5_000_000] if inner else None
        if name.endswith(".gz") or data[:2] == b"\x1f\x8b":
            return gzip.decompress(data)[:5_000_000]
        return data if data.lstrip()[:1] == b"<" else None
    except (zipfile.BadZipFile, OSError, EOFError, KeyError):
        return None


def parse(xml: bytes) -> dict[str, Any] | None:
    """One aggregate report: org, id, the day, and per source the count and whether it passed."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    if root.tag != "feedback":
        return None
    t = lambda path: (root.findtext(path) or "").strip()  # noqa: E731
    org, rid = t("report_metadata/org_name"), t("report_metadata/report_id")
    try:
        begin, end = int(t("report_metadata/date_range/begin")), int(t("report_metadata/date_range/end"))
    except ValueError:
        return None
    if not org or not rid:
        return None
    messages = passed = 0
    failed: dict[str, int] = {}
    for rec in root.findall("record"):
        try:
            count = int(rec.findtext("row/count") or 0)
        except ValueError:
            continue
        ok = "pass" in ((rec.findtext("row/policy_evaluated/dkim") or "").lower(),
                        (rec.findtext("row/policy_evaluated/spf") or "").lower())
        messages += count
        if ok:
            passed += count
        else:
            ip = (rec.findtext("row/source_ip") or "?").strip()
            failed[ip] = failed.get(ip, 0) + count
    return {"report_id": f"{org}:{rid}", "org": org, "begin": begin, "end": end, "messages": messages,
            "passed": passed, "failed_from": failed}


def from_email(message) -> list[dict[str, Any]]:
    """The reports in one incoming email (usually one attachment)."""
    out = []
    for part in message.walk():
        name = (part.get_filename() or "").lower()
        if part.get_content_maintype() == "multipart" or not (name.endswith(ATTACHMENT) or
                                                              part.get_content_type() in ("application/zip", "application/gzip", "application/x-gzip")):
            continue
        data = part.get_payload(decode=True) or b""
        xml = xml_of(name, data)
        report = parse(xml) if xml else None
        if report:
            out.append(report)
    return out


def save(store, reports: list[dict[str, Any]], now: float) -> int:
    store.db.executescript(SCHEMA)
    added = 0
    with store.db:
        for r in reports:
            added += store.db.execute(
                """INSERT OR IGNORE INTO dmarc_reports (report_id, org, begin, end, messages, passed, failed_from, received_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (r["report_id"], r["org"], r["begin"], r["end"], r["messages"], r["passed"],
                 json.dumps(r["failed_from"]), int(now))).rowcount
    return added


def summary(store, now: float, days: int = 30) -> dict[str, Any]:
    """Per reporter over the last `days`: emails seen, passed, and where failures came from."""
    store.db.executescript(SCHEMA)
    rows = store.db.execute(
        "SELECT org, SUM(messages), SUM(passed), COUNT(*), MAX(end) FROM dmarc_reports WHERE end >= ? GROUP BY org ORDER BY 2 DESC",
        (now - days * 86400,)).fetchall()
    failed: dict[str, int] = {}
    for (f,) in store.db.execute("SELECT failed_from FROM dmarc_reports WHERE end >= ? AND passed < messages",
                                 (now - days * 86400,)):
        for ip, n in json.loads(f or "{}").items():
            failed[ip] = failed.get(ip, 0) + n
    return {"days": days, "by": [{"org": o, "messages": m or 0, "passed": p or 0, "reports": n, "last": last}
                                 for o, m, p, n, last in rows],
            "failed_from": failed,
            "ever": store.db.execute("SELECT COUNT(*) FROM dmarc_reports").fetchone()[0]}
