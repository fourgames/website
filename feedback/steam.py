"""Steam data: our games, reviews, player counts and update events. Stdlib only."""

import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USER_AGENT = "fourgames-feedback/1.0 (+https://fourgames.se)"
# Steamworks publisher key. Without one (local testing) reviews come from the public host instead.
STEAM_KEY = os.environ.get("STEAM_PUBLISHER_KEY", "").strip()
REVIEWS_URL = (
    "https://partner.steam-api.com/IUserReviewsService/GetAppReviews/v1/"
    if STEAM_KEY
    else "https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/"
)
# Steam event types that mean a new build: 10 game release, 12 small update / patch notes, 13 regular
# update, 14 major update.
UPDATE_EVENT_TYPES = {10, 12, 13, 14}


class HttpError(Exception):
    def __init__(self, status, host):
        super().__init__(f"HTTP {status} from {host}")
        self.status = status


def request(url, *, params=None, data=None, retries=6, as_json=True, timeout=30):
    """GET (or POST with form `data`), retrying 429 and 5xx with backoff. Errors name only the host,
    never the URL, so the publisher key in a query string can't end up in a log."""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    host = urllib.parse.urlsplit(url).netloc
    delay = 5
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT, "Accept-Language": "en"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read().decode("utf-8", errors="replace")
                return json.loads(raw) if as_json else raw
        except urllib.error.HTTPError as error:
            if attempt < retries and (error.code == 429 or error.code >= 500):
                retry_after = error.headers.get("Retry-After")
                wait = int(retry_after) if retry_after and retry_after.isdigit() else delay
                print(f"[steam] HTTP {error.code} from {host}, retrying in {wait}s")
                time.sleep(min(wait, 120))
                delay = min(delay * 2, 120)
                continue
            raise HttpError(error.code, host) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt < retries:
                time.sleep(delay)
                delay = min(delay * 2, 120)
                continue
            raise HttpError(f"network error ({type(error).__name__})", host) from None


# ---------------------------------------------------------------------------
# Games
# ---------------------------------------------------------------------------


def site_config():
    """The publisher/developer names and hand-listed app IDs from src/data (via node, since they're ESM)."""
    out = subprocess.run(["node", str(Path(__file__).parent / "games.mjs")], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def discover_app_ids(config):
    """Same store search the site's build uses (scripts/fetch-data.mjs → discoverAppIds)."""
    ids = set()
    for filt in ("publisher", "developer"):
        name = config.get(filt)
        if not name:
            continue
        for start in range(0, 200, 50):
            page = request(
                "https://store.steampowered.com/search/results/",
                params={"term": "", filt: name, "infinite": 1, "start": start, "count": 50, "cc": "us", "l": "english"},
            )
            ids.update(int(i) for i in re.findall(r'data-ds-appid="(\d+)"', str(page.get("results_html", ""))))
            if start + 50 >= int(page.get("total_count") or 0):
                break
            time.sleep(0.3)
    return ids


def store_fingerprint(d):
    """A short hash of the English store data the website shows (scripts/fetch-data.mjs), so a change
    to any of it can start a site rebuild. Images compare by file, not by their ?t= cache-buster."""
    file = lambda url: (url or "").split("?")[0]
    price = d.get("price_overview") or {}
    shown = [
        d.get("name"), d.get("short_description"), file(d.get("header_image")), bool(d.get("is_free")),
        price.get("final_formatted"), price.get("initial_formatted"), price.get("discount_percent"),
        (d.get("release_date") or {}).get("date"), sorted(k for k, v in (d.get("platforms") or {}).items() if v),
        [g.get("description") for g in d.get("genres") or []][:3], [file(s.get("path_full")) for s in d.get("screenshots") or []],
    ]
    return hashlib.sha1(json.dumps(shown).encode()).hexdigest()[:12]


def store_extras(d):
    """The store details not used elsewhere, for the dashboard's More data: what's on the store page
    besides the text and images (recommendations, Metacritic, DLC, features, languages, price)."""
    price = d.get("price_overview") or {}
    meta = d.get("metacritic") or {}
    languages = re.sub(r"<[^>]+>|\*", "", d.get("supported_languages") or "")
    return {
        "recommendations": (d.get("recommendations") or {}).get("total"),
        "metacritic": meta.get("score"),
        "metacriticUrl": meta.get("url"),
        "dlc": len(d.get("dlc") or []),
        "achievements": (d.get("achievements") or {}).get("total"),
        "categories": [c.get("description") for c in d.get("categories") or []],
        "genres": [g.get("description") for g in d.get("genres") or []],
        "platforms": sorted(k for k, v in (d.get("platforms") or {}).items() if v),
        "languages": [l.strip() for l in languages.split("languages with full audio")[0].split(",") if l.strip()],
        "controller": d.get("controller_support"),
        "age": int(d.get("required_age") or 0) or None,
        "price": price.get("initial"),  # US cents, before any discount
        "free": bool(d.get("is_free")),
        "developers": d.get("developers") or [],
        "publishers": d.get("publishers") or [],
        "website": d.get("website") or None,
    }


def fetch_games(previous):
    """[{appId, name, status, type, capsule}] for every game on our publisher page plus games.js.
    Falls back to the previous list if Steam can't be reached, so a hiccup never drops a game."""
    known = {g["appId"]: g for g in previous}
    try:
        config = site_config()
        manual = [int(i) for i in config.get("appIds", [])]
        app_ids = list(dict.fromkeys(manual + sorted(discover_app_ids(config) - set(manual), reverse=True)))
    except Exception as error:  # noqa: BLE001 - discovery is best effort
        print(f"[steam] game discovery failed ({error}); keeping {len(known)} known games")
        return previous
    games = []
    for app_id in app_ids:
        try:
            entry = request("https://store.steampowered.com/api/appdetails", params={"appids": app_id, "cc": "us", "l": "english"})
            entry = entry.get(str(app_id)) or {}
        except HttpError as error:
            print(f"[steam] app {app_id}: {error}")
            if app_id in known:
                games.append(known[app_id])
            continue
        if not entry.get("success"):
            continue  # unannounced or unlisted: no reviews or forums to read
        d = entry["data"]
        if d.get("type", "game") != "game" and app_id not in manual:
            continue  # a discovered DLC, demo or soundtrack
        games.append(
            {
                "appId": app_id,
                "name": d.get("name") or known.get(app_id, {}).get("name") or str(app_id),
                "status": "upcoming" if (d.get("release_date") or {}).get("coming_soon") else "released",
                # For ordering the dashboard's game list; Steam gives a display string ("Sep 30, 2026").
                "released": parse_release_date((d.get("release_date") or {}).get("date")),
                "capsule": d.get("header_image"),
                # The store's current discount; each run records it, so sale periods build up over time.
                "discount": (d.get("price_overview") or {}).get("discount_percent", 0),
                "store": store_fingerprint(d),
                "details": store_extras(d),
                "demo": public_demo(d, known.get(app_id, {}).get("demo")),
            }
        )
        time.sleep(0.3)
    return games or previous


def public_demo(d, previous):
    """{appId, name} of the game's demo once it's out on Steam, else None. Its players are recorded
    with the game's (run.py → record_players). Keeps the previous one if Steam can't be reached."""
    for demo in d.get("demos") or []:
        try:
            entry = request("https://store.steampowered.com/api/appdetails", params={"appids": demo["appid"], "cc": "us", "l": "english"})
        except HttpError as error:
            print(f"[steam] demo {demo['appid']}: {error}")
            return previous
        entry = entry.get(str(demo["appid"])) or {}
        if entry.get("success") and not (entry["data"].get("release_date") or {}).get("coming_soon"):
            return {"appId": int(demo["appid"]), "name": entry["data"].get("name") or "Demo"}
    return None


# ---------------------------------------------------------------------------
# Reviews, players, events
# ---------------------------------------------------------------------------


def review_pages(app_id):
    """Yields pages of reviews, most recently created-or-edited first (the Updated filter)."""
    cursor = "*"
    while True:
        params = {
            "appid": app_id,
            "filter": 2,  # Updated: new reviews and edits to old ones
            "languages[0]": "all",
            "purchase_type": 1,  # Steam and non-Steam keys alike
            "filter_offtopic_activity": "false",
            "num_per_page": 100,
            "cursor": cursor,
        }
        if STEAM_KEY:
            params["key"] = STEAM_KEY
        res = request(REVIEWS_URL, params=params).get("response", {})
        reviews = res.get("reviews") or []
        yield res, reviews
        next_cursor = res.get("cursor")
        if not reviews or not next_cursor or next_cursor == cursor:
            return
        cursor = next_cursor
        time.sleep(1)


def player_count(app_id):
    res = request("https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/", params={"appid": app_id})
    res = res.get("response", {})
    return res.get("player_count") if res.get("result") == 1 else None


def update_events(app_id):
    """The game's published update / patch-notes events, newest first."""
    res = request(
        "https://store.steampowered.com/events/ajaxgetadjacentpartnerevents/",
        params={"appid": app_id, "count_before": 0, "count_after": 50},
    )
    events = []
    for e in res.get("events") or []:
        if e.get("event_type") not in UPDATE_EVENT_TYPES or e.get("hidden") or not e.get("published", 1):
            continue
        body = e.get("announcement_body") or {}
        name = e.get("event_name") or body.get("headline") or "Update"
        version = re.search(r"\b(\d+(?:\.\d+)+)\b", name)
        events.append(
            {
                "gid": str(e.get("gid")),
                "name": name,
                "version": version.group(1) if version else None,
                "launch": e.get("event_type") == 10,  # the "game released" post
                "time": int(e.get("rtime32_start_time") or body.get("posttime") or 0),
                "url": f"https://store.steampowered.com/news/app/{app_id}/view/{e.get('gid')}",
                "body": bbcode_to_text(body.get("body") or ""),
                # The build it shipped and how players took the post; votes and comments keep changing.
                "stats": {
                    "buildId": e.get("build_id") or None,
                    "branch": e.get("build_branch") or None,
                    "votesUp": e.get("votes_up", 0),
                    "votesDown": e.get("votes_down", 0),
                    "comments": e.get("comment_count", 0),
                    "tags": [t for t in body.get("tags") or [] if not t.startswith("ModAct_")],
                },
            }
        )
    return sorted(events, key=lambda e: e["time"], reverse=True)


def parse_release_date(text):
    """Unix time for Steam's release date string ("Sep 30, 2026", "30 Sep, 2026", "Q4 2026"…), or None."""
    for fmt in ("%b %d, %Y", "%d %b, %Y", "%B %d, %Y", "%b %Y", "%B %Y", "%Y"):
        try:
            return int(datetime.strptime((text or "").strip(), fmt).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
    return None


def games_owned(steamid):
    """How many games a reviewer owns (as Steam shows on reviews), or None for a private library.
    Needs the publisher key; this isn't part of the review data itself."""
    if not STEAM_KEY:
        return None
    try:
        res = request("https://partner.steam-api.com/IPlayerService/GetOwnedGames/v1/",
                      params={"key": STEAM_KEY, "steamid": steamid, "include_played_free_games": 1}, retries=2)
    except HttpError:
        return None
    return (res.get("response") or {}).get("game_count")


STEAM64_BASE = 76561197960265728
_profiles = {}


def profile(author_id):
    """{name, avatar, url} from a player's public Steam profile (no key needed), or None. Reviews
    carry a 64-bit Steam ID, forum posts an account ID or a profile URL."""
    if not author_id:
        return None
    author_id = str(author_id)
    if author_id.startswith("http"):
        url = author_id.rstrip("/")
    elif author_id.isdigit():
        n = int(author_id)
        url = f"https://steamcommunity.com/profiles/{n if n >= STEAM64_BASE else n + STEAM64_BASE}"
    else:
        return None
    if url not in _profiles:
        try:
            xml = request(f"{url}/", params={"xml": 1}, as_json=False, retries=2)
            name = re.search(r"<steamID><!\[CDATA\[(.*?)\]\]></steamID>", xml, re.S)
            avatar = re.search(r"<avatarMedium><!\[CDATA\[(.*?)\]\]></avatarMedium>", xml)
            _profiles[url] = {"name": name.group(1), "avatar": avatar.group(1) if avatar else None, "url": url} if name else None
        except HttpError:
            _profiles[url] = None
    return _profiles[url]


def bbcode_to_text(text):
    text = re.sub(r"\[\*\]", "\n- ", text)
    text = re.sub(r"\[/?(?:p|h\d|list|olist|br)\]", "\n", text)
    text = re.sub(r"\[[^\]]{1,40}\]", "", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()
