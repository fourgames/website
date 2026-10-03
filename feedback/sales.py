"""Steam sales from IPartnerFinancialsService, summed per day and game into data/sales.json.

Needs STEAM_FINANCIAL_KEY: the key of a "Financial API Group" (Steamworks → Users & Permissions →
Manage Groups). It covers every app on the account. Valve lets partners share their own sales data
"as they see fit"; this repo is public, so this file is too.

Sync follows Valve's recipe: ask which dates changed since the last high-water mark (late
settlements restate old days), rebuild each of those days from scratch, then store the new mark.
"""

import os
import time
from decimal import Decimal

import steam

KEY = os.environ.get("STEAM_FINANCIAL_KEY", "").strip()
BASE = "https://partner.steam-api.com/IPartnerFinancialsService"


def _int(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _usd(v):
    try:
        return Decimal(str(v or "0"))
    except ArithmeticError:
        return Decimal(0)


def fetch_day(date):
    """{appId: totals} for one Pacific-time date, plus {appId: name}."""
    rows, names, discounts = [], {}, {}
    mark = "0"
    while True:
        res = steam.request(f"{BASE}/GetDetailedSales/v001/", params={"key": KEY, "date": date, "highwatermark_id": mark})
        res = res.get("response", {})
        rows += res.get("results") or []
        for a in res.get("app_info") or []:
            names[_int(a.get("appid"))] = a.get("app_name")
        for d in res.get("combined_discount_info") or []:
            discounts[_int(d.get("combined_discount_id"))] = _int(d.get("total_discount_percentage"))
        new_mark = str(res.get("max_id") or mark)
        if new_mark == mark or not res.get("results"):
            break
        mark = new_mark
        time.sleep(0.5)

    apps = {}
    for r in rows:
        if r.get("package_sale_type") == "Retail":
            app = _int(r.get("primary_appid")) or _int(r.get("appid"))
            if app:
                apps.setdefault(app, _empty())["activations"] += _int(r.get("gross_units_activated"))
            continue
        # Packages are credited to their primary app (the base game for a DLC, per Valve's revenue-share
        # mapping); in-game purchases carry their app directly.
        app = _int(r.get("primary_appid")) or _int(r.get("appid"))
        if not app:
            continue
        t = apps.setdefault(app, _empty())
        net = _usd(r.get("net_sales_usd"))
        t["gross"] += _usd(r.get("gross_sales_usd"))
        t["returns"] += -_usd(r.get("gross_returns_usd"))
        t["tax"] += _usd(r.get("net_tax_usd"))
        t["net"] += net
        t["units"] += _int(r.get("gross_units_sold"))
        t["returnedUnits"] += -_int(r.get("gross_units_returned"))
        cc = r.get("country_code") or "??"
        c = t["countries"].setdefault(cc, [Decimal(0), 0])
        c[0] += net
        c[1] += _int(r.get("net_units_sold"))
        discount = discounts.get(_int(r.get("combined_discount_id")), 0)
        if discount and _int(r.get("gross_units_sold")):
            t["discount"] = max(t["discount"], discount)
    return {app: _round(t) for app, t in apps.items()}, names


def _empty():
    return {"gross": Decimal(0), "returns": Decimal(0), "tax": Decimal(0), "net": Decimal(0), "units": 0,
            "returnedUnits": 0, "activations": 0, "discount": 0, "countries": {}}


def _round(t):
    out = {k: (round(float(v), 2) if isinstance(v, Decimal) else v) for k, v in t.items() if k != "countries"}
    out["countries"] = {cc: [round(float(n), 2), u] for cc, (n, u) in sorted(t["countries"].items())}
    return {k: v for k, v in out.items() if v not in (0, 0.0, {})}


def sync(sales):
    """Updates `sales` in place ({highwatermark, days: {date: {appId: totals}}, apps: {appId: name}})."""
    if not KEY:
        return False
    try:
        res = steam.request(f"{BASE}/GetChangedDatesForPartner/v001/", params={"key": KEY, "highwatermark": sales.get("highwatermark", "0")})
    except steam.HttpError as error:
        print(f"[sales] {error}")
        return False
    res = res.get("response", {})
    dates = res.get("dates") or []
    print(f"[sales] {len(dates)} changed day(s)")
    for date in dates:
        try:
            day, names = fetch_day(date)
        except steam.HttpError as error:
            print(f"[sales] {date}: {error}; trying again next run")
            return True
        key = date.replace("/", "-")
        if day:
            sales["days"][key] = {str(app): t for app, t in day.items()}
        else:
            sales["days"].pop(key, None)
        sales["apps"].update({str(app): name for app, name in names.items() if name})
        time.sleep(0.3)
    # Only move the mark once every changed day is rebuilt (an error above returns early), or a
    # failure would skip days for good.
    sales["highwatermark"] = str(res.get("result_highwatermark") or sales.get("highwatermark", "0"))
    sales["days"] = dict(sorted(sales["days"].items()))
    return True
