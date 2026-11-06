"""How big the creator list is: python -m creators.stats (from the server/ folder)."""

from __future__ import annotations

import sys
import time

from .collector import quota_day
from .config import Config, ConfigError
from .db import Store


def report(store: Store, now: float, daily_units: int) -> str:
    q = lambda sql, *a: store.db.execute(sql, a).fetchone()[0]  # noqa: E731
    month_ago = now - 30 * 86400
    day, _ = quota_day(now)
    spent, exhausted = store.units_spent(day)
    live = "FROM youtube_channels WHERE gone = 0"
    counts = [
        ("Channels", q(f"SELECT COUNT(*) {live}")),
        ("  details read", q(f"SELECT COUNT(*) {live} AND refreshed_at IS NOT NULL")),
        ("  with a public email", q(f"SELECT COUNT(*) {live} AND emails IS NOT NULL AND emails != '[]'")),
        ("  email revealed by hand", q("SELECT COUNT(*) FROM youtube_channels WHERE revealed_email IS NOT NULL")),
        ("  with a Twitch link", q(f"SELECT COUNT(*) {live} AND links LIKE '%twitch%'")),
        ("  a video in 30 days", q("SELECT COUNT(DISTINCT channel_id) FROM youtube_videos WHERE published >= ?", month_ago)),
        ("Videos", q("SELECT COUNT(*) FROM youtube_videos")),
        ("Games searched", q("SELECT COUNT(*) FROM searches")),
    ]
    lines = [f"{label + ':':<26} {value:,}" for label, value in counts]
    lines += [
        f"Units today ({day}):  {spent:,} of {daily_units:,}" + (" (YouTube said the quota is used up)" if exhausted else ""),
        "",
        "Channels by size:",
    ]
    for label, low, high in (("1M+", 1_000_000, None), ("100k-1M", 100_000, 1_000_000), ("10k-100k", 10_000, 100_000),
                             ("1k-10k", 1_000, 10_000), ("under 1k", 0, 1_000)):
        count = q("SELECT COUNT(*) FROM youtube_channels WHERE subscribers >= ? AND subscribers < ?",
                  low, high or 10 ** 12)
        lines.append(f"  {label:<9} {count:,}")
    lines.append("")
    lines.append("Languages (channel or video setting):")
    for lang, count in store.db.execute(
            """SELECT lang, COUNT(*) FROM (
                   SELECT c.channel_id, COALESCE(c.language,
                       (SELECT v.language FROM youtube_videos v WHERE v.channel_id = c.channel_id
                        AND v.language IS NOT NULL LIMIT 1), '?') AS lang
                   FROM youtube_channels c WHERE c.gone = 0)
               GROUP BY substr(lang, 1, 2) ORDER BY 2 DESC LIMIT 12"""):
        lines.append(f"  {lang[:2]:<4} {count:,}")
    return "\n".join(lines)


def main() -> int:
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"creators: {error}", file=sys.stderr)
        return 2
    store = Store(config.db_path)
    try:
        print(report(store, time.time(), config.daily_units))
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
