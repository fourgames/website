"""The press list: games press, aggregators (press-release and trailer reposters, newsletters) and
trailer channels, worldwide, for launch announcements. Researched from each outlet's own contact
page (the source is kept per outlet), stored in the creators database, shown on the dashboard's
Creators page (Press & trailers) and in the export.

The list itself isn't in this public repository (it's contact data); it lives on the server. Import or
update it from a JSON array (python -m creators.press import < press.json), one object per outlet:

  {"name", "url", "kind": press|aggregator|trailer-channel, "country": ISO alpha-2 or INT,
   "language": ISO 639-1, "email" or null, "contact_url" or null, "focus", "reach": big|mid|small,
   "notes", "source"}

An outlet is matched by its address (host and path, without www or a trailing slash): importing again
updates it and keeps when it was added. Entries without an email or a contact page are skipped.

  python -m creators.press import < press.json
  python -m creators.press stats
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse

from .config import Config, ConfigError
from .db import Store

KINDS = {"press", "aggregator", "trailer-channel"}
REACH = {"big", "mid", "small"}
EMAIL = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")


def key(url: str) -> str:
    parts = urllib.parse.urlsplit(url.strip())
    host = parts.netloc.lower()
    host = host[4:] if host.startswith("www.") else host
    return host + parts.path.rstrip("/").lower()


def clean(item: dict) -> dict | None:
    """The fields to store, or None when the entry can't be used."""
    if not isinstance(item, dict):
        return None
    url = str(item.get("url") or "").strip()
    if not url.lower().startswith(("http://", "https://")) or not item.get("name"):
        return None
    email = str(item.get("email") or "").strip().lower() or None
    if email and not EMAIL.match(email):
        email = None
    contact = str(item.get("contact_url") or "").strip() or None
    if contact and not contact.lower().startswith(("http://", "https://")):
        contact = None
    if not email and not contact:
        return None
    kind = str(item.get("kind") or "press").strip().lower()
    reach = str(item.get("reach") or "").strip().lower()
    return {
        "key": key(url), "name": str(item["name"]).strip()[:120], "url": url,
        "kind": kind if kind in KINDS else "press",
        "country": (str(item.get("country") or "").strip().upper() or None),
        "language": (str(item.get("language") or "").strip().lower()[:5] or None),
        "email": email, "contact_url": contact,
        "focus": (str(item.get("focus") or "").strip().lower()[:20] or None),
        "reach": reach if reach in REACH else None,
        "notes": (str(item.get("notes") or "").strip()[:300] or None),
        "source": (str(item.get("source") or "").strip() or None),
    }


def import_list(store: Store, items: list, now: float) -> dict[str, int]:
    counts = {"added": 0, "updated": 0, "skipped": 0}
    with store.db:
        for item in items:
            row = clean(item)
            if not row:
                counts["skipped"] += 1
                continue
            exists = store.db.execute("SELECT 1 FROM press WHERE key = ?", (row["key"],)).fetchone()
            store.db.execute(
                """INSERT INTO press (key, name, url, kind, country, language, email, contact_url, focus, reach,
                                      notes, source, added_at, updated_at)
                   VALUES (:key, :name, :url, :kind, :country, :language, :email, :contact_url, :focus, :reach,
                           :notes, :source, :now, :now)
                   ON CONFLICT(key) DO UPDATE SET name = excluded.name, url = excluded.url, kind = excluded.kind,
                       country = excluded.country, language = excluded.language, email = excluded.email,
                       contact_url = excluded.contact_url, focus = excluded.focus, reach = excluded.reach,
                       notes = excluded.notes, source = excluded.source, updated_at = excluded.updated_at""",
                {**row, "now": int(now)})
            counts["updated" if exists else "added"] += 1
    return counts


def rows(store: Store) -> list[dict]:
    return [dict(r) for r in store.db.execute(
        "SELECT name, url, kind, country, language, email, contact_url, focus, reach, notes, source, added_at "
        "FROM press ORDER BY country, kind, name")]


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in ("import", "stats"):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"creators: {error}", file=sys.stderr)
        return 2
    store = Store(config.db_path)
    try:
        if argv[0] == "import":
            try:
                items = json.load(sys.stdin)
            except ValueError as error:
                print(f"creators: not a JSON array: {error}", file=sys.stderr)
                return 2
            print(", ".join(f"{k}: {v}" for k, v in import_list(store, items if isinstance(items, list) else [], time.time()).items()))
        else:
            for label, sql in (("outlets", "SELECT COUNT(*) FROM press"),
                               ("with an email", "SELECT COUNT(*) FROM press WHERE email IS NOT NULL")):
                print(f"{label}: {store.db.execute(sql).fetchone()[0]}")
            for kind, n in store.db.execute("SELECT kind, COUNT(*) FROM press GROUP BY kind ORDER BY 2 DESC"):
                print(f"  {kind}: {n}")
            print("by country: " + ", ".join(f"{c or '?'} {n}" for c, n in store.db.execute(
                "SELECT country, COUNT(*) FROM press GROUP BY country ORDER BY 2 DESC")))
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
