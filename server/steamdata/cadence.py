"""How often each thing is fetched. All times are unix seconds, days are UTC days.

The budget math behind these numbers is in the README.
"""

from __future__ import annotations

import random

HOUR = 3600
DAY = 86400

# The daily snapshot (GetItems) of every game runs once per UTC day, starting at 00:05.
SNAPSHOT_OFFSET = 5 * 60
# Apps the store doesn't show (removed, hidden): checked again after a week.
HIDDEN_RETRY = 7 * DAY
# The app list: only the changed apps every 6 hours, the full list once a day.
APPLIST_EVERY = 6 * HOUR
APPLIST_FULL_EVERY = DAY
APPLIST_OVERLAP = HOUR
TAGS_EVERY = 7 * DAY
PCGW_EVERY = 7 * DAY
# How long after a failed request (other than throttling) an item is tried again.
RETRY_LATER = HOUR

# Player counts: (at least this many players at the last sample, hours until the next one).
PLAYER_TIERS = [(100, 4), (10, 12), (1, 24)]
# The Godot set is ~10,000 games since SteamDB's list (most with nobody playing), so only the
# busy ones are hourly, and empty ones back off like the rest, to a week at most.
GODOT_TIERS = [(100, 1), (10, 2), (1, 4)]
GODOT_ZERO_HOURS = 6
GODOT_ZERO_MAX_DAYS = 7
# Just released (the first 14 days): at least every 4 hours (Godot set: every hour).
NEW_RELEASE_DAYS = 14
NEW_RELEASE_HOURS = 4
# Nobody playing: 2 days, then 4, 8, 16, and at most 30 days between samples.
ZERO_MAX_DAYS = 30


def day_number(ts: float) -> int:
    """Days since 1970-01-01 (UTC): the key of app_daily. date(day * 86400, 'unixepoch') in SQL."""
    return int(ts // DAY)


def next_snapshot(now: float) -> int:
    return (day_number(now) + 1) * DAY + SNAPSHOT_OFFSET


def jitter(seconds: float, rng: random.Random, spread: float = 0.1) -> int:
    """Spreads samples over the hours of the day instead of always hitting the same one."""
    return int(seconds * rng.uniform(1 - spread, 1 + spread))


def players_interval(count: int | None, zeros: int, godot: bool, released_days_ago: float | None,
                     rng: random.Random) -> int:
    """Seconds until the next player-count sample. count None means Steam had no count; zeros is
    how many samples in a row (this one included) had nobody."""
    players = count or 0
    new = released_days_ago is not None and 0 <= released_days_ago <= NEW_RELEASE_DAYS
    if godot:
        if new:
            return jitter(HOUR, rng)
        if players >= 1:
            return jitter(next(h for low, h in GODOT_TIERS if players >= low) * HOUR, rng)
        # Nobody: 6 hours, then 1, 2, 4 and at most 7 days.
        if zeros <= 1:
            return jitter(GODOT_ZERO_HOURS * HOUR, rng)
        return jitter(min(2 ** (zeros - 2), GODOT_ZERO_MAX_DAYS) * DAY, rng)
    if players >= 1:
        hours = next(h for low, h in PLAYER_TIERS if players >= low)
        if new:
            hours = min(hours, NEW_RELEASE_HOURS)
        return jitter(hours * HOUR, rng)
    if new:
        return jitter(DAY, rng)
    return jitter(min(2 ** max(zeros, 1), ZERO_MAX_DAYS) * DAY, rng)


def first_players_delay(reviews: int, godot: bool) -> int:
    """When a newly found game gets its first player-count sample, by how many reviews it has, so
    the first pass over ~150,000 games starts with the ones people play."""
    if godot or reviews >= 1000:
        return 0
    if reviews >= 100:
        return HOUR
    if reviews >= 10:
        return 6 * HOUR
    if reviews >= 1:
        return DAY
    return 3 * DAY


def next_details(now: float, days: int, rng: random.Random) -> int:
    return int(now) + jitter(days * DAY, rng)
