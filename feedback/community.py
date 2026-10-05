"""The game's community around the reviews: followers on Steam, how far players get (achievement
percentages) and the studio's Discord server. None of it needs a key. Stdlib only.

- Followers: the member count of the game's Steam community hub, which is what "follow" on the store
  page joins (it moves with wishlists), hourly. Stored as [time, count] on change.
- Achievements: name, description, icon and the share of players who unlocked each, from the game's
  public achievement stats page, daily.
- Discord: members and members online, from the site's invite link (src/data/site.js), hourly.
  Studio-wide, so it's kept in index.json rather than a game's file.
- Bundles: the Steam bundles the game is in (from its store page), daily, and the store details of
  the games you want to bundle it with (data/bundles.json, which only the dashboard writes): a game
  you just added on the next run, all of them daily.
- Competitors: the games you compare this one with (data/competitors.json, which only the dashboard
  writes): each one's player count hourly (kept as the day's peak), its review totals per day and
  its update posts, so the dashboard can tell "everyone dropped" from "only we dropped".
- Curators: the Steam curators who reviewed the game, each with their follower count and what they
  said, every 6 hours. Steam has no official API for it: this reads the same list the store's "Curators
  reviewing this game" page loads, so it may break if Steam changes that page.
"""

import html
import json
import re
import time

import media
import steam

HOUR = 3600
ONLINE_DAYS = 90  # how long the online count is kept (it changes all the time)
COMPETITOR_DAYS = 400  # how long a competitor's daily peaks and review totals are kept
CURATOR_STATES = {0: "recommended", 1: "not_recommended", 2: "informative"}


def _series_add(series, value):
    """Appends [now, value] when the value changed. Returns True when it did."""
    if value is None or (series and series[-1][1] == value):
        return False
    series.append([int(time.time()), value])
    return True


def record_followers(state, game):
    app_id = game["appId"]
    if not media._due("followers", app_id, HOUR):
        return
    try:
        xml = steam.request(f"https://steamcommunity.com/games/{app_id}/memberslistxml/", params={"xml": 1}, as_json=False)
    except steam.HttpError as error:
        print(f"[community] {game['name']} followers: {error}")
        return
    # The hub's own count, inside <groupDetails> (the list's total below it can lag by a few).
    m = re.search(r"<groupDetails>.*?<memberCount>(\d+)</memberCount>", xml, re.S)
    if m:
        _series_add(state.setdefault("followers", []), int(m.group(1)))
    media._ran("followers", app_id)


def record_achievements(state, game):
    app_id = game["appId"]
    if not media._due("achievements", app_id, 24 * HOUR):
        return
    try:
        page = steam.request(f"https://steamcommunity.com/stats/{app_id}/achievements/", params={"l": "english"}, as_json=False)
    except steam.HttpError as error:
        print(f"[community] {game['name']} achievements: {error}")
        return
    found = []
    for row in re.findall(r'<div class="achieveRow[^>]*>(.*?)<div style="clear: both;"></div>', page, re.S):
        icon = re.search(r'<img src="([^"]+)"', row)
        pct = re.search(r'class="achievePercent">([\d.]+)%', row)
        name = re.search(r"<h3>(.*?)</h3>", row, re.S)
        desc = re.search(r"<h5>(.*?)</h5>", row, re.S)
        if not (pct and name):
            continue
        found.append({
            "name": html.unescape(name.group(1)).strip(),
            "desc": html.unescape(desc.group(1)).strip() if desc else "",
            "icon": icon.group(1) if icon else None,
            "percent": float(pct.group(1)),
        })
    # A game without achievements (or not out yet) has none: nothing to keep.
    if found and found != (state.get("achievements") or {}).get("list"):
        state["achievements"] = {"at": int(time.time()), "list": found}
    media._ran("achievements", app_id)


def record_discord(index, invite):
    """Members and members online in the studio's Discord server, from its invite link."""
    code = (invite or "").rstrip("/").rsplit("/", 1)[-1]
    if not code or not media._due("discord", 0, HOUR):
        return
    try:
        res = steam.request(f"https://discord.com/api/v10/invites/{code}", params={"with_counts": "true"})
    except steam.HttpError as error:
        print(f"[community] Discord: {error}")
        return
    d = index.setdefault("discord", {"members": [], "online": []})
    d["name"] = (res.get("guild") or {}).get("name")
    d["invite"] = invite
    _series_add(d["members"], res.get("approximate_member_count"))
    _series_add(d["online"], res.get("approximate_presence_count"))
    cutoff = time.time() - ONLINE_DAYS * 86400
    d["online"] = [p for p in d["online"] if p[0] >= cutoff]
    media._ran("discord", 0)


def record_bundles(state, game, wanted):
    """The bundles the game is in, and the games in `wanted` (app ids you'd like to bundle with)."""
    app_id = game["appId"]
    partners = state.setdefault("partners", {})
    for key in [k for k in partners if k not in wanted]:
        del partners[key]
    due = media._due("bundles", app_id, 24 * HOUR)
    for key in wanted:
        if due or key not in partners:
            info = _partner(int(key))
            if info:
                partners[key] = info
    if not partners:
        state.pop("partners")
    if not due:
        return
    try:
        page = steam.request(f"https://store.steampowered.com/app/{app_id}/", params={"l": "english", "cc": "us"}, as_json=False)
        ids = list(dict.fromkeys(re.findall(r'data-ds-bundleid="(\d+)"', page)))
        resolved = steam.request("https://store.steampowered.com/actions/ajaxresolvebundles",
                                 params={"bundleids": ",".join(ids), "cc": "US", "l": "english"}) if ids else []
    except steam.HttpError as error:
        print(f"[community] {game['name']} bundles: {error}")
        return
    found = []
    for b in resolved or []:
        # The apps' names, from the bundle's "Includes" line on the store page.
        block = page.split(f'data-ds-bundleid="{b["bundleid"]}"', 1)[-1].split("game_purchase_action", 1)[0]
        names = {int(i): html.unescape(n).strip() for i, n in re.findall(r'/app/(\d+)/[^"]*">([^<]+)</a>', block)}
        found.append({
            "id": b["bundleid"],
            "name": b.get("name"),
            "image": b.get("header_image_url") or b.get("main_capsule"),
            "apps": [{"appId": a, "name": names.get(a)} for a in b.get("appids") or []],
            "bundleDiscount": b.get("bundle_base_discount", 0),
            "price": b.get("formatted_final_price"),
            "fullPrice": b.get("formatted_orig_price"),
        })
    old = (state.get("bundles") or {}).get("list")
    if found != old:
        state["bundles"] = {"at": int(time.time()), "list": found}
    media._ran("bundles", app_id)


def _partner(app_id):
    """A game's name, makers, capsule, price and reviews, from its store page's data."""
    try:
        entry = (steam.request("https://store.steampowered.com/api/appdetails", params={"appids": app_id, "cc": "us", "l": "english"}) or {}).get(str(app_id)) or {}
        reviews = steam.request(f"https://store.steampowered.com/appreviews/{app_id}",
                                params={"json": 1, "language": "all", "purchase_type": "all", "num_per_page": 0}).get("query_summary") or {}
    except steam.HttpError as error:
        print(f"[community] app {app_id} for bundles: {error}")
        return None
    if not entry.get("success"):
        return {"at": int(time.time()), "missing": True}
    d = entry["data"]
    price = d.get("price_overview") or {}
    release = d.get("release_date") or {}
    return {
        "at": int(time.time()),
        "name": d.get("name"),
        "developers": d.get("developers") or [],
        "publishers": d.get("publishers") or [],
        "capsule": d.get("header_image"),
        "released": None if release.get("coming_soon") else release.get("date"),
        "comingSoon": bool(release.get("coming_soon")),
        "price": "Free" if d.get("is_free") else price.get("initial_formatted") or price.get("final_formatted"),
        "reviews": {"desc": reviews.get("review_score_desc"), "total": reviews.get("total_reviews", 0), "positive": reviews.get("total_positive", 0)},
    }


def record_competitors(state, game, wanted):
    """Players, reviews and updates of the games in `wanted` (app ids you compare this game with).
    Stored per competitor: `peaks` {day: most players seen that day (UTC)}, `reviews` {day:
    {positive, negative}} like the game's own reviewTotals, and its latest `updates`."""
    app_id = game["appId"]
    found = state.setdefault("competitors", {})
    for key in [k for k in found if k not in wanted]:
        del found[key]
    if not wanted:
        state.pop("competitors")
        return
    # Hourly, and at once for a game you just added.
    due = media._due("competitors", app_id, HOUR)
    if not due:
        wanted = [k for k in wanted if k not in found or not found[k]]
        if not wanted:
            return
    day = time.strftime("%Y-%m-%d", time.gmtime())
    cutoff = time.strftime("%Y-%m-%d", time.gmtime(time.time() - COMPETITOR_DAYS * 86400))
    daily = due and media._due("competitors-daily", app_id, 24 * HOUR)
    for key in wanted:
        c = found.setdefault(key, {})
        other = int(key)
        try:
            # The store details (name, capsule, release) and update posts change rarely: daily, and
            # at once for a game you just added.
            if daily or "name" not in c:
                entry = (steam.request("https://store.steampowered.com/api/appdetails", params={"appids": other, "cc": "us", "l": "english"}) or {}).get(key) or {}
                if not entry.get("success"):
                    found[key] = {"missing": True}
                    continue
                d = entry["data"]
                release = d.get("release_date") or {}
                c.update(name=d.get("name"), capsule=d.get("header_image"),
                         released=steam.parse_release_date(release.get("date")), comingSoon=bool(release.get("coming_soon")))
                c.pop("missing", None)
                c["updates"] = [{"time": e["time"], "name": e["name"], "version": e["version"], "url": e["url"]}
                                for e in steam.update_events(other)[:10]]
            players = steam.player_count(other)
            if players is not None:
                peaks = c.setdefault("peaks", {})
                peaks[day] = max(players, peaks.get(day, 0))
            summary = steam.request(f"https://store.steampowered.com/appreviews/{other}",
                                    params={"json": 1, "language": "all", "purchase_type": "all", "num_per_page": 0}).get("query_summary") or {}
            if summary.get("total_reviews") is not None:
                c.setdefault("reviews", {})[day] = {"positive": summary.get("total_positive", 0), "negative": summary.get("total_negative", 0)}
        except steam.HttpError as error:
            print(f"[community] {game['name']} competitor {other}: {error}")
            continue
        for series in ("peaks", "reviews"):
            if c.get(series):
                c[series] = {d: v for d, v in sorted(c[series].items()) if d >= cutoff}
        time.sleep(0.3)
    if due:
        media._ran("competitors", app_id)
    if daily:
        media._ran("competitors-daily", app_id)


def record_curators(state, game):
    """The curators who reviewed the game, most followers first. Returns the ones new since the last
    look (none on the first look, which only records who's already there)."""
    app_id = game["appId"]
    if not media._due("curators", app_id, 6 * HOUR):
        return []
    found, start, total = [], 0, None
    try:
        while total is None or start < total:
            res = steam.request("https://store.steampowered.com/curators/ajaxgetcurators/",
                                params={"query": "", "start": start, "count": 50, "filter": "top_curators_reviewing", "appid": app_id, "l": "english"})
            total = res.get("total_count") or 0
            m = re.search(r"g_rgTopCurators = (\[.*?\]);\s*\n", res.get("results_html") or "", re.S)
            page = json.loads(m.group(1)) if m else []
            if not page:
                break
            for c in page:
                review = next((r for r in c.get("m_rgAppRecommendations") or [] if r.get("appid") == app_id), {})
                found.append({
                    "id": int(c["clanID"]),
                    "name": html.unescape(c.get("name") or ""),
                    "url": c.get("link"),
                    "group": c.get("communityLink"),
                    "avatar": f"https://avatars.akamai.steamstatic.com/{c['strAvatarHash']}_medium.jpg" if c.get("strAvatarHash") else None,
                    "followers": c.get("total_followers") or 0,
                    "state": CURATOR_STATES.get(review.get("recommendation_state"), "recommended"),
                    "blurb": (review.get("blurb") or "").strip(),
                    "link": review.get("link_url") or None,
                    "time": review.get("time_recommended"),
                    "free": bool(review.get("received_for_free")),
                    "paid": bool(review.get("received_compensation")),
                })
            start += len(page)
            time.sleep(0.3)
    except (steam.HttpError, ValueError) as error:
        print(f"[community] {game['name']} curators: {error}")
        return []
    old = state.get("curators")
    seen = {c["id"]: c.get("seen") for c in (old or {}).get("list") or []}
    for c in found:
        # When it first showed up here (on the first look, when the curator posted it).
        c["seen"] = seen.get(c["id"]) or (c["time"] if old is None and c["time"] else int(time.time()))
    found.sort(key=lambda c: -c["followers"])
    if old is None or found != old.get("list"):
        state["curators"] = {"at": int(time.time()), "list": found}
    media._ran("curators", app_id)
    return [] if old is None else [c for c in found if c["id"] not in seen]
