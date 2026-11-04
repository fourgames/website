"""Steam's official endpoints, and turning their replies into plain values.

- api.steampowered.com/IStoreService/GetAppList: every game on the store (needs a Web API key).
- api.steampowered.com/IStoreBrowseService/GetItems: the store's own batch lookup, up to 100 apps
  per call: review count and score, price and discount, user tags, release date, platforms and Steam
  Deck rating, developers and publishers. Keyless. This is the daily snapshot.
- api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers: one app's players right now.
- api.steampowered.com/IStoreService/GetTagList: the user tags' names.
- store.steampowered.com/api/appdetails: one app's full store data (genres, languages, legal notice,
  description...). Strictly rate limited, so only for the monthly metadata refresh.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field
from typing import Any

from .net import Http, HttpError, Transient

API = "https://api.steampowered.com"
STORE = "https://store.steampowered.com"
LANGUAGE = "english"
ITEMS_PER_CALL = 100
TAGS_PER_APP = 20

# IStoreBrowseService's EStoreAppType. Only 0 (game) is collected.
STORE_TYPES = {0: "game", 1: "demo", 2: "mod", 3: "movie", 4: "dlc", 5: "guide", 6: "software",
               7: "video", 8: "series", 9: "episode", 10: "hardware", 11: "music", 12: "beta",
               13: "tool", 14: "advertising"}


@dataclass(frozen=True)
class ListApp:
    appid: int
    name: str
    last_modified: int | None
    price_change: int | None


@dataclass(frozen=True)
class Snapshot:
    """One app in a GetItems reply. Prices in the country's currency, in cents."""

    appid: int
    type: str
    name: str = ""
    visible: bool = True
    unlisted: bool = False
    reviews: int = 0
    positive_pct: int | None = None
    review_score: int | None = None
    price: int | None = None
    price_original: int | None = None  # only when discounted
    discount: int = 0
    is_free: bool = False
    release_ts: int | None = None
    original_release_ts: int | None = None
    coming_soon: bool = False
    early_access: bool = False
    release_display: str | None = None
    developers: tuple[str, ...] = ()
    publishers: tuple[str, ...] = ()
    tags: tuple[int, ...] = ()
    categories: tuple[int, ...] = ()
    windows: bool = False
    mac: bool = False
    linux: bool = False
    deck: int | None = None  # 0 unknown, 1 unsupported, 2 playable, 3 verified
    short_description: str = ""
    parent_appid: int | None = None
    content_descriptors: tuple[int, ...] = ()


@dataclass(frozen=True)
class Details:
    """The parts of appdetails the snapshot doesn't have. The raw text for engine signals is kept
    in memory only (see engine.py), never stored."""

    type: str
    name: str
    genres: tuple[tuple[int, str], ...] = ()
    categories: tuple[tuple[int, str], ...] = ()
    languages: str = ""
    required_age: int | None = None
    controller_support: str | None = None
    metacritic: int | None = None
    achievements: int | None = None
    dlc_count: int = 0
    demos: tuple[int, ...] = ()
    release_text: str | None = None
    texts: dict[str, str] = field(default_factory=dict, repr=False, compare=False)


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _names(people: Any) -> tuple[str, ...]:
    out = []
    for p in people or []:
        name = p.get("name") if isinstance(p, dict) else p
        if isinstance(name, str) and name.strip():
            out.append(name.strip())
    return tuple(out)


# The app list


def app_list_page(http: Http, key: str, last_appid: int = 0, since: int | None = None,
                  max_results: int = 10000) -> tuple[list[ListApp], bool, int]:
    """One page of the store's games: (apps, more to come, the last appid for the next page).
    With `since`, only the apps whose store data changed after that unix time."""
    params = {"key": key, "include_games": "true", "include_dlc": "false",
              "include_software": "false", "include_videos": "false", "include_hardware": "false",
              "max_results": max_results, "last_appid": last_appid}
    if since:
        params["if_modified_since"] = int(since)
    data = http.get_json(f"{API}/IStoreService/GetAppList/v1/", params)
    res = (data.get("response") or {}) if isinstance(data, dict) else {}
    apps = []
    for a in res.get("apps") or []:
        appid = _int(a.get("appid"))
        if appid:
            apps.append(ListApp(appid, str(a.get("name") or ""), _int(a.get("last_modified")),
                                _int(a.get("price_change_number"))))
    last = _int(res.get("last_appid")) or (apps[-1].appid if apps else last_appid)
    return apps, bool(res.get("have_more_results")) and bool(apps), last


# The daily snapshot


def get_items(http: Http, appids: list[int], country: str) -> dict[int, Snapshot | None]:
    """The snapshot of each app; None for apps the store doesn't show (removed, hidden, invalid)."""
    request = {
        "ids": [{"appid": a} for a in appids],
        "context": {"language": LANGUAGE, "country_code": country, "steam_realm": 1},
        "data_request": {"include_basic_info": True, "include_release": True,
                         "include_platforms": True, "include_reviews": True,
                         "include_tag_count": TAGS_PER_APP},
    }
    data = http.get_json(f"{API}/IStoreBrowseService/GetItems/v1/",
                         {"input_json": json.dumps(request, separators=(",", ":"))})
    items = ((data.get("response") or {}).get("store_items") or []) if isinstance(data, dict) else []
    out: dict[int, Snapshot | None] = {a: None for a in appids}
    for item in items:
        appid = _int(item.get("id")) or _int(item.get("appid"))
        if appid in out:
            out[appid] = parse_item(item)
    return out


def parse_item(item: dict) -> Snapshot | None:
    if item.get("success") != 1 or not _int(item.get("appid")):
        return None
    appid = _int(item["appid"])
    kind = _int(item.get("type"))
    reviews = ((item.get("reviews") or {}).get("summary_filtered")) or {}
    release = item.get("release") or {}
    platforms = item.get("platforms") or {}
    basic = item.get("basic_info") or {}
    option = item.get("best_purchase_option") or {}
    categories = item.get("categories") or {}
    is_free = bool(item.get("is_free"))

    price = _int(option.get("final_price_in_cents"))
    original = _int(option.get("original_price_in_cents"))
    discount = _int(option.get("discount_pct")) or 0
    if price is None and is_free:
        price = 0
    if original is not None and (price is None or original <= price):
        original = None

    tags = item.get("tags")
    if tags:
        tag_ids = [t.get("tagid") for t in sorted(tags, key=lambda t: -(t.get("weight") or 0))]
    else:
        tag_ids = item.get("tagids") or []
    category_ids = sorted({c for key in ("supported_player_categoryids", "feature_categoryids",
                                         "controller_categoryids")
                           for c in categories.get(key) or [] if isinstance(c, int)})
    display = release.get("custom_release_date_message") or (
        release.get("coming_soon_display") if release.get("is_coming_soon") else None)

    return Snapshot(
        appid=appid,
        type=STORE_TYPES.get(kind, f"type{kind}") if kind is not None else "game",
        name=str(item.get("name") or ""),
        visible=bool(item.get("visible", True)),
        unlisted=bool(item.get("unlisted")),
        reviews=_int(reviews.get("review_count")) or 0,
        positive_pct=_int(reviews.get("percent_positive")),
        review_score=_int(reviews.get("review_score")),
        price=price,
        price_original=original,
        discount=discount,
        is_free=is_free,
        release_ts=_int(release.get("steam_release_date")),
        original_release_ts=_int(release.get("original_steam_release_date")
                                 or release.get("original_release_date")),
        coming_soon=bool(release.get("is_coming_soon")),
        early_access=bool(item.get("is_early_access") or release.get("is_early_access")),
        release_display=str(display) if display else None,
        developers=_names(basic.get("developers")),
        publishers=_names(basic.get("publishers")),
        tags=tuple(t for t in tag_ids if isinstance(t, int))[:TAGS_PER_APP],
        categories=tuple(category_ids),
        windows=bool(platforms.get("windows")),
        mac=bool(platforms.get("mac")),
        linux=bool(platforms.get("steamos_linux") or platforms.get("linux")),
        deck=_int(platforms.get("steam_deck_compat_category")),
        short_description=str(basic.get("short_description") or "")[:1000],
        parent_appid=_int((item.get("related_items") or {}).get("parent_appid")),
        content_descriptors=tuple(sorted(c for c in item.get("content_descriptorids") or []
                                         if isinstance(c, int))),
    )


# Player counts


def current_players(http: Http, appid: int) -> int | None:
    """Players in the game right now, or None when Steam has no count for it."""
    try:
        data = http.get_json(f"{API}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/", {"appid": appid})
    except HttpError as error:
        if error.status == 404:  # Steam's "no such app" (result 42)
            return None
        raise
    res = (data.get("response") or {}) if isinstance(data, dict) else {}
    if res.get("result") != 1:
        return None
    return _int(res.get("player_count"))


# Tags


def tag_list(http: Http) -> list[tuple[int, str]]:
    data = http.get_json(f"{API}/IStoreService/GetTagList/v1/", {"language": LANGUAGE})
    tags = ((data.get("response") or {}).get("tags") or []) if isinstance(data, dict) else []
    return [(t["tagid"], str(t.get("name") or "")) for t in tags if isinstance(t.get("tagid"), int)]


# The full metadata


def app_details(http: Http, appid: int, country: str) -> dict | None:
    """appdetails' data for one app, or None when the store has none for it (success false)."""
    data = http.get_json(f"{STORE}/api/appdetails",
                         {"appids": appid, "cc": country.lower(), "l": LANGUAGE},
                         throttle_codes=(429, 403))
    entry = data.get(str(appid)) if isinstance(data, dict) else None
    if not isinstance(entry, dict):
        # A null in place of the app: Steam does this when it's busy.
        raise Transient("empty appdetails reply", "store.steampowered.com/api/appdetails")
    if not entry.get("success") or not isinstance(entry.get("data"), dict):
        return None
    return entry["data"]


_TAGS = re.compile(r"<[^>]+>")


def strip_html(text: Any) -> str:
    if not isinstance(text, str):
        return ""
    return re.sub(r"\s+", " ", html.unescape(_TAGS.sub(" ", text))).strip()


def clean_languages(raw: Any) -> str:
    """"English<strong>*</strong>, French<br><strong>*</strong>languages with full audio support"
    -> "English*,French" (* = full audio)."""
    if not isinstance(raw, str):
        return ""
    raw = re.split(r"<br\s*/?>", raw, maxsplit=1)[0]
    raw = re.sub(r"<strong>\s*\*\s*</strong>", "*", raw)
    names = [strip_html(part).replace(" *", "*") for part in raw.split(",")]
    return ",".join(n for n in names if n)[:2000]


def parse_details(data: dict) -> Details:
    def pairs(items: Any) -> tuple[tuple[int, str], ...]:
        out = []
        for g in items or []:
            gid = _int(g.get("id")) if isinstance(g, dict) else None
            if gid is not None:
                out.append((gid, str(g.get("description") or "")))
        return tuple(sorted(set(out)))

    requirements = data.get("pc_requirements")
    if isinstance(requirements, dict):
        requirements = " ".join(str(v) for v in requirements.values())
    release = data.get("release_date") or {}
    return Details(
        type=str(data.get("type") or "game"),
        name=str(data.get("name") or ""),
        genres=pairs(data.get("genres")),
        categories=pairs(data.get("categories")),
        languages=clean_languages(data.get("supported_languages")),
        required_age=_int(data.get("required_age")),
        controller_support=data.get("controller_support") if isinstance(data.get("controller_support"), str) else None,
        metacritic=_int((data.get("metacritic") or {}).get("score")),
        achievements=_int((data.get("achievements") or {}).get("total")),
        dlc_count=len(data.get("dlc") or []),
        demos=tuple(sorted(d for d in (_int(x.get("appid")) for x in data.get("demos") or []
                                       if isinstance(x, dict)) if d)),
        release_text=str(release.get("date")) if release.get("date") else None,
        texts={
            "legal_notice": strip_html(data.get("legal_notice")),
            "description": strip_html(data.get("detailed_description") or data.get("about_the_game")),
            "short_description": strip_html(data.get("short_description")),
            "requirements": strip_html(requirements),
        },
    )
