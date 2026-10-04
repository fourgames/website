"""The game's community around the reviews: followers on Steam, how far players get (achievement
percentages) and the studio's Discord server. None of it needs a key. Stdlib only.

- Followers: the member count of the game's Steam community hub, which is what "follow" on the store
  page joins (it moves with wishlists), hourly. Stored as [time, count] on change.
- Achievements: name, description, icon and the share of players who unlocked each, from the game's
  public achievement stats page, daily.
- Discord: members and members online, from the site's invite link (src/data/site.js), hourly.
  Studio-wide, so it's kept in index.json rather than a game's file.
"""

import html
import re
import time

import media
import steam

HOUR = 3600
ONLINE_DAYS = 90  # how long the online count is kept (it changes all the time)


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
