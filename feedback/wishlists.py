"""Steam wishlists from IPartnerFinancialsService/GetAppWishlistReporting, per game and day, into
data/wishlists.json. The same STEAM_FINANCIAL_KEY as sales.py (a Financial API Group's key). Public
like sales.json, on purpose. Synced hourly from run.py.

Steam has a day once it's over (GMT), and updates it at least daily, so the last few days are read
again each sync. A game's history goes back to its store page (`app_min_date`) and is filled in
BACKFILL days per sync, newest first, so the first syncs don't make hundreds of calls at once.

Stored per game: {minDate, days: {date: {adds, deletes, purchases, gifts, windows, mac, linux,
countries: {cc: [adds, deletes, purchases, gifts]}, languages: {name: [same]}}}}. Zero values are
left out; a day with nothing at all is kept as {}, so it isn't asked for again.
"""

import time
from datetime import date, timedelta

import status
import steam
from sales import BASE, KEY, _int

REFRESH = 3  # the newest days are read again: Steam may still add to them
BACKFILL = 30  # older days filled in per game per sync


def _actions(s):
    s = s or {}
    return [_int(s.get(k)) for k in ("wishlist_adds", "wishlist_deletes", "wishlist_purchases", "wishlist_gifts")]


def fetch_day(app_id, day):
    """(totals for one GMT day, the earliest day Steam has for the game)."""
    res = steam.request(f"{BASE}/GetAppWishlistReporting/v001/", params={"key": KEY, "appid": app_id, "date": day}, retries=3)
    res = res.get("response", {})
    s = res.get("wishlist_summary") or {}
    adds, deletes, purchases, gifts = _actions(s)
    out = {"adds": adds, "deletes": deletes, "purchases": purchases, "gifts": gifts,
           # Adds only: which platform the player was browsing the store for.
           "windows": _int(s.get("wishlist_adds_windows")), "mac": _int(s.get("wishlist_adds_mac")), "linux": _int(s.get("wishlist_adds_linux")),
           "countries": {c.get("country_code") or "??": a for c in res.get("country_summary") or [] if any(a := _actions(c.get("summary_actions")))},
           "languages": {l.get("language_name") or str(l.get("language")): a for l in res.get("language_summary") or [] if any(a := _actions(l.get("summary_actions")))}}
    return {k: v for k, v in out.items() if v not in (0, {})}, (res.get("app_min_date") or "").replace("/", "-") or None


def sync(wishlists, app_ids):
    """Updates `wishlists` in place ({apps: {appId: {minDate, days}}}). True if Steam answered."""
    if not KEY:
        return False  # sales.py already reports the missing key
    yesterday = date.today() - timedelta(days=1)
    for app_id in app_ids:
        w = wishlists.setdefault("apps", {}).setdefault(str(app_id), {"days": {}})
        known = w["days"]
        recent = [yesterday - timedelta(days=n) for n in range(REFRESH)]
        start = date.fromisoformat(w["minDate"]) if w.get("minDate") else yesterday
        missing = [d for d in (yesterday - timedelta(days=n) for n in range((yesterday - start).days + 1))
                   if d.isoformat() not in known and d not in recent][:BACKFILL]
        for d in recent + missing:
            if d < start and w.get("minDate"):
                continue
            try:
                totals, min_date = fetch_day(app_id, d.isoformat())
            except steam.HttpError as error:
                print(f"[wishlists] {app_id} {d}: {error}")
                status.fail("wishlists", f"Steam's wishlist API failed ({error}). STEAM_FINANCIAL_KEY must be a Financial API Group's key.")
                return False
            if min_date:
                w["minDate"] = min_date
            # An empty day is kept as {} so it isn't asked for again.
            known[d.isoformat()] = totals
            time.sleep(0.3)
        w["days"] = dict(sorted(known.items()))
    status.ok("wishlists")
    return True
