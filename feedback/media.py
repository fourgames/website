"""Who's talking about each game outside Steam: Twitch streams live right now, new YouTube videos, news
articles (Google News, plus any Google Alerts feeds you add). From the alerts, links to Reddit are
listed as Reddit posts (Reddit's own API needs its approval), other pages not on a news site as web
pages, and copies of the game on download sites as copies, all without alerts. Saved in the game's
file under `media`, so the dashboard can list them, mark them on the player and review charts and
show who's live; new ones are sent to Discord (run.py send_media_alerts).

Each source runs on its own schedule (YouTube's daily quota only allows a search about once an hour
per game) and reports to the status bar on its own. A source with no keys reports what to add.

Env (GitHub secrets): TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, YOUTUBE_API_KEY, GOOGLE_ALERTS_FEEDS (RSS
feed URLs, one per line). Stdlib only.
"""

import calendar
import hashlib
import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import status

USER_AGENT = "fourgames-feedback/1.0 (+https://fourgames.se)"
CACHE = Path(__file__).resolve().parent / ".cache" / "media.json"  # when each source last ran (not committed)

TWITCH_ID = os.environ.get("TWITCH_CLIENT_ID", "").strip()
TWITCH_SECRET = os.environ.get("TWITCH_CLIENT_SECRET", "").strip()
YOUTUBE_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
ALERT_FEEDS = [u.strip() for u in os.environ.get("GOOGLE_ALERTS_FEEDS", "").split() if u.strip()]

MINUTE = 60
# How often each source is searched per game. Twitch is checked every run: a stream is worth catching early.
EVERY = {"news": 30 * MINUTE, "news-local": 120 * MINUTE}
# YouTube's free quota is 10,000 units a day and a search costs 100 (the video and channel details 1
# each), so all games together get about 75 searches a day: hourly with up to 3 games, less often with more.
YOUTUBE_DAILY_SEARCHES = 75
REFRESH_DAYS = 14  # views, likes and scores are kept current this long after something is posted
STREAM_GONE = 15 * MINUTE
ALERT_DAYS = 3  # only things posted this recently are sent to Discord  # a stream not seen live for this long has ended


class HttpError(Exception):
    def __init__(self, code, host):
        super().__init__(f"HTTP {code} from {host}")
        self.code = code


def request(url, *, params=None, data=None, headers=None, as_json=True, retries=2):
    """GET (or POST form `data`). Errors name only the host, never the URL, so a key in a query string
    can't end up in a log."""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    host = urllib.parse.urlsplit(url).netloc
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    delay = 3
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                raw = res.read().decode("utf-8", errors="replace")
                return json.loads(raw) if as_json else raw
        except urllib.error.HTTPError as error:
            if attempt < retries and (error.code == 429 or error.code >= 500):
                time.sleep(delay)
                delay *= 3
                continue
            raise HttpError(error.code, host) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt < retries:
                time.sleep(delay)
                delay *= 3
                continue
            raise HttpError(f"network error ({type(error).__name__})", host) from None


def now():
    return int(time.time())


def norm(text):
    """Lowercase letters and digits only (any script), so "Reforge: Front!" matches "reforge front"."""
    return re.sub(r"[\W_]+", " ", (text or "").lower()).strip()


# Scripts written without spaces between words (Chinese, Japanese, Thai), and Korean, whose words
# take endings: a name in them is matched anywhere, not only as whole words.
UNSPACED = re.compile(r"[\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")


def mentions(names, *texts):
    """Any of the game's names (one, or a list) in any of the texts."""
    for name in [names] if isinstance(names, str) else names:
        needle = norm(name)
        if not needle:
            continue
        for t in texts:
            hay = norm(t)
            if hay and (needle in hay if UNSPACED.search(needle) else f" {needle} " in f" {hay} "):
                return True
    return False


# A game's name can also be a place, a product or a phrase ("Pomo Valley" is a valley in India): a
# video, article or post has to be about a game too. YouTube's Gaming category counts as that.
# Also "game" in the languages the games are localized into, since a localized name can be a plain
# phrase too ("Gräva ett hål i isen med motorsåg" is also what an ice-fishing video is about).
GAME_WORDS = re.compile(
    r"\b(games?|gaming|gamer|gameplay|play(s|ing|ed|through|test)?|let s play|walkthrough|steam|indie|trailer|demo|"
    r"early access|wishlists?|roguelike|roguelite|sim|simulator|strategy|tower defen[cs]e|rpg|pc|switch|xbox|"
    r"playstation|ps[45]|nintendo|godot|unity|speedrun|dlc|patch|update|devlog|achievements?|boss|"
    r"spiel(e|en|s)?|videospiel\w*|jeux?|juegos?|videojuegos?|gioco|giochi|videogioc\w*|jogos?|gr(a|y|ze|ę)|"
    r"hr(a|y|u|ou)|spil(let|lene)?|spel(et|en)?|spill(et)?|peli(n|ä|t)?|joc(ul|uri)?|játék\w*|permainan|"
    r"trò chơi|oyun\w*|игр\w*|гр(а|и|у|і)|παιχνίδι\w*)\b")
GAME_CHARS = re.compile(r"게임|ゲーム|游戏|遊戲|游戲|遊戏|เกม")
YOUTUBE_GAMING = "20"


def about_games(*texts):
    return any(GAME_WORDS.search(norm(t)) or GAME_CHARS.search(t) for t in texts if t)


# ---------------------------------------------------------------------------
# The game's names: English and every localized name it has (or had) on Steam
# ---------------------------------------------------------------------------

# Steam's languages and the Google News edition for each (hl, gl, ceid). Danish gets Norway's.
LANGS = {
    "english": ("en-US", "US", "US:en"), "bulgarian": ("bg", "BG", "BG:bg"), "czech": ("cs", "CZ", "CZ:cs"),
    "danish": ("da", "DK", "DK:da"), "dutch": ("nl", "NL", "NL:nl"), "finnish": ("fi", "FI", "FI:fi"),
    "french": ("fr", "FR", "FR:fr"), "german": ("de", "DE", "DE:de"), "greek": ("el", "GR", "GR:el"),
    "hungarian": ("hu", "HU", "HU:hu"), "indonesian": ("id", "ID", "ID:id"), "italian": ("it", "IT", "IT:it"),
    "japanese": ("ja", "JP", "JP:ja"), "koreana": ("ko", "KR", "KR:ko"), "malay": ("ms", "MY", "MY:ms"),
    "norwegian": ("no", "NO", "NO:no"), "polish": ("pl", "PL", "PL:pl"), "portuguese": ("pt-PT", "PT", "PT:pt-150"),
    "brazilian": ("pt-BR", "BR", "BR:pt-419"), "romanian": ("ro", "RO", "RO:ro"), "russian": ("ru", "RU", "RU:ru"),
    "spanish": ("es", "ES", "ES:es"), "latam": ("es-419", "MX", "MX:es-419"), "swedish": ("sv", "SE", "SE:sv"),
    "thai": ("th", "TH", "TH:th"), "turkish": ("tr", "TR", "TR:tr"), "ukrainian": ("uk", "UA", "UA:uk"),
    "vietnamese": ("vi", "VN", "VN:vi"), "schinese": ("zh-CN", "CN", "CN:zh-Hans"), "tchinese": ("zh-TW", "TW", "TW:zh-Hant"),
}


def update_names(media, game):
    """Once a day, the game's name in each language from its Steam store page. Every name it has ever
    had is kept (a renamed translation still finds what was written under the old one)."""
    app_id = game["appId"]
    if not _due("names", app_id, 86400):
        return
    names = media.setdefault("names", {})
    for lang in LANGS:
        if lang == "english":
            continue
        try:
            res = request("https://store.steampowered.com/api/appdetails", params={"appids": app_id, "l": lang, "filters": "basic"})
        except HttpError as error:
            print(f"[names] {game['name']} {lang}: {error}")
            return  # try again next run
        name = (((res or {}).get(str(app_id)) or {}).get("data") or {}).get("name")
        # Without a localized name Steam shows the English one.
        if name and norm(name) != norm(game["name"]) and name not in names.get(lang, []):
            names.setdefault(lang, []).append(name)
        time.sleep(0.3)
    _ran("names", app_id)


def all_names(media, game):
    """[(language, name)]: English first, then every localized name."""
    return [("english", game["name"])] + [(lang, n) for lang, ns in sorted((media.get("names") or {}).items()) for n in ns]


_own = None


def own(author):
    """Our own channel or account (the site's Steam publisher or developer name), never an alert."""
    global _own
    if _own is None:
        import steam

        try:
            config = steam.site_config()
            _own = {norm(config.get("publisher")), norm(config.get("developer"))} - {""}
        except Exception:  # node missing (local runs): just don't recognise our own
            _own = set()
    return norm(author) in _own


def iso_time(text):
    return calendar.timegm(time.strptime(text[:19], "%Y-%m-%dT%H:%M:%S")) if text else None


def _clip(text, limit):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _id(prefix, key):
    return prefix + hashlib.sha1(key.encode()).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Schedule (kept in feedback/.cache: a fresh checkout every few hours just searches once more)
# ---------------------------------------------------------------------------

_cache = None


def _due(source, app_id, every):
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(CACHE.read_text())
        except (FileNotFoundError, ValueError):
            _cache = {}
    return now() - _cache.get(f"{source}:{app_id}", 0) >= every


def _ran(source, app_id):
    _cache[f"{source}:{app_id}"] = now()
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps(_cache))


# ---------------------------------------------------------------------------
# Twitch: streams in the game's category, live right now
# ---------------------------------------------------------------------------

_twitch_token = None


def twitch(path, params=None):
    global _twitch_token
    if _twitch_token is None:
        res = request("https://id.twitch.tv/oauth2/token",
                      data={"client_id": TWITCH_ID, "client_secret": TWITCH_SECRET, "grant_type": "client_credentials"})
        _twitch_token = res["access_token"]
    headers = {"Client-Id": TWITCH_ID, "Authorization": f"Bearer {_twitch_token}"}
    if path.startswith("igdb:"):
        # IGDB (Twitch's game database, same keys) takes a query in the body.
        req = urllib.request.Request(f"https://api.igdb.com/v4/{path[5:]}", data=params.encode(),
                                     headers={**headers, "User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as error:
            raise HttpError(error.code, "api.igdb.com") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            raise HttpError(f"network error ({type(error).__name__})", "api.igdb.com") from None
    return request(f"https://api.twitch.tv/helix/{path}", params=params, headers=headers)


def twitch_category(game):
    """The game's Twitch category: through IGDB by its Steam app id (exact, whatever the name), else by
    name. None when Twitch has none yet (it adds them from IGDB once someone asks)."""
    app_id = game["appId"]
    for source in ("external_game_source", "category"):  # IGDB's newer and older name for the field
        try:
            rows = twitch("igdb:external_games", f'fields game; where uid = "{app_id}" & {source} = 1; limit 1;')
        except HttpError:
            continue
        if rows and rows[0].get("game"):
            found = twitch("games", {"igdb_id": rows[0]["game"]}).get("data") or []
            if found:
                return {"id": found[0]["id"], "name": found[0]["name"]}
            break
    found = twitch("games", {"name": game["name"]}).get("data") or []
    if not found:
        found = [c for c in twitch("search/categories", {"query": game["name"], "first": 20}).get("data") or []
                 if norm(c["name"]) == norm(game["name"])]
    return {"id": found[0]["id"], "name": found[0]["name"]} if found else None


def collect_twitch(media, game, found):
    if not (TWITCH_ID and TWITCH_SECRET):
        status.fail("twitch", "Add the TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET secrets to see who's streaming.")
        return False
    app_id = game["appId"]
    tw = media.setdefault("twitch", {})
    # The category is looked up once, and again every 6 hours while Twitch has none.
    if not tw.get("category") and _due("twitch-category", app_id, 6 * 3600):
        tw["category"] = twitch_category(game)
        _ran("twitch-category", app_id)
    category = tw.get("category")
    if not category:
        status.ok("twitch")
        return False
    streams = twitch("streams", {"game_id": category["id"], "first": 100}).get("data") or []
    status.ok("twitch")
    t = now()
    items = media["items"]
    for s in streams:
        key = f"tw{s['id']}"
        item = items.get(key)
        if item is None:
            item = items[key] = {
                "id": key, "source": "twitch",
                "url": f"https://www.twitch.tv/{s['user_login']}",
                "author": s["user_name"], "authorUrl": f"https://www.twitch.tv/{s['user_login']}",
                "userId": s["user_id"],
                "at": iso_time(s.get("started_at")) or t,
                "lang": s.get("language"),
                "peak": 0,
            }
            try:
                item["followers"] = twitch("channels/followers", {"broadcaster_id": s["user_id"], "first": 1}).get("total")
            except HttpError:
                pass
            found.append(key)
            status.active("twitch", "stream went live")
        item["title"] = _clip(s.get("title"), 300)
        item["viewers"] = s.get("viewer_count", 0)
        item["peak"] = max(item.get("peak", 0), item["viewers"])
        item["thumb"] = (s.get("thumbnail_url") or "").replace("{width}", "440").replace("{height}", "248") or None
        item["live"] = True
        item["end"] = t
    live = {f"tw{s['id']}" for s in streams}
    for item in items.values():
        if item["source"] == "twitch" and item.get("live") and item["id"] not in live and t - item["end"] >= STREAM_GONE:
            item["live"] = False
            item.pop("viewers", None)
    return True


# ---------------------------------------------------------------------------
# YouTube: new videos that name the game
# ---------------------------------------------------------------------------


def youtube(path, params):
    return request(f"https://www.googleapis.com/youtube/v3/{path}", params={**params, "key": YOUTUBE_KEY})


def _duration(text):
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", text or "")
    return sum(int(v or 0) * s for v, s in zip(m.groups(), (86400, 3600, 60, 1))) if m else None


def _video_stats(item, v):
    stats = v.get("statistics") or {}
    item["views"] = int(stats.get("viewCount", 0))
    item["likes"] = int(stats["likeCount"]) if "likeCount" in stats else None
    item["comments"] = int(stats["commentCount"]) if "commentCount" in stats else None
    live = (v.get("snippet") or {}).get("liveBroadcastContent")
    item["live"] = live == "live"
    item["upcoming"] = live == "upcoming"
    details = v.get("liveStreamingDetails") or {}
    if details.get("concurrentViewers"):
        item["viewers"] = int(details["concurrentViewers"])
        item["peak"] = max(item.get("peak", 0), item["viewers"])
    else:
        item.pop("viewers", None)


def relevant_video(names, v):
    """It names the game (the search matches loosely) and is about a game."""
    sn = v.get("snippet") or {}
    tags = " ".join(sn.get("tags") or [])
    return mentions(names, sn.get("title"), sn.get("description"), tags) and (
        sn.get("categoryId") == YOUTUBE_GAMING or about_games(sn.get("title"), sn.get("description"), tags))


def collect_youtube(media, game, found, games):
    if not YOUTUBE_KEY:
        status.fail("youtube", "Add the YOUTUBE_API_KEY secret to find new videos.")
        return False
    app_id = game["appId"]
    every = max(3600, round(games * 86400 / YOUTUBE_DAILY_SEARCHES))
    if not _due("youtube", app_id, every):
        return False
    items = media["items"]
    marks = media.setdefault("watermarks", {})
    # The English name every time, and the localized ones a few at a time, in turn (a search costs
    # the same however many names it has, but a long one finds less).
    names = [n for _, n in all_names(media, game)]
    local = names[1:]
    turn = _cache.get(f"youtube-turn:{app_id}", 0) if _cache else 0
    batch = local[turn * 4 % len(local):][:4] if local else []
    _cache[f"youtube-turn:{app_id}"] = turn + 1
    params = {"part": "snippet", "q": " | ".join(f'"{n}"' for n in [names[0], *batch]), "type": "video", "order": "date", "maxResults": 25}
    if marks.get("youtube"):
        # A day back: YouTube's search lists some videos hours after they're published.
        params["publishedAfter"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(marks["youtube"] - 86400))
    results = youtube("search", params).get("items") or []
    new_ids = [r["id"]["videoId"] for r in results if r.get("id", {}).get("videoId") and f"yt{r['id']['videoId']}" not in items]
    # Fresh numbers for the newest videos too, at no search cost (50 videos per call, 1 unit). Videos
    # saved before the game check existed (no `category`) are checked again.
    recent = [i["id"][2:] for i in items.values() if i["source"] == "youtube" and (now() - i["at"] < REFRESH_DAYS * 86400 or "category" not in i)]
    videos = {}
    ids = new_ids + [v for v in recent if v not in new_ids]
    for start in range(0, len(ids), 50):
        for v in youtube("videos", {"part": "snippet,statistics,contentDetails,liveStreamingDetails", "id": ",".join(ids[start:start + 50])}).get("items") or []:
            videos[v["id"]] = v
    new = []
    for vid in new_ids:
        v = videos.get(vid)
        if not v:
            continue
        if not relevant_video(names, v):
            continue
        sn = v["snippet"]
        key = f"yt{vid}"
        items[key] = {
            "id": key, "source": "youtube",
            "url": f"https://www.youtube.com/watch?v={vid}",
            "title": _clip(html.unescape(sn.get("title", "")), 300),
            "text": _clip(sn.get("description"), 400),
            "author": sn.get("channelTitle"), "authorUrl": f"https://www.youtube.com/channel/{sn.get('channelId')}",
            "channelId": sn.get("channelId"),
            "at": iso_time(sn.get("publishedAt")) or now(),
            "thumb": ((sn.get("thumbnails") or {}).get("medium") or {}).get("url"),
            "lang": sn.get("defaultAudioLanguage") or sn.get("defaultLanguage"),
            "duration": _duration((v.get("contentDetails") or {}).get("duration")),
            "own": own(sn.get("channelTitle")) or None,
        }
        new.append(key)
    for vid, v in videos.items():
        item = items.get(f"yt{vid}")
        if not item:
            continue
        if "category" not in item and not relevant_video(names, v):
            del items[item["id"]]
            continue
        item["category"] = (v.get("snippet") or {}).get("categoryId")
        _video_stats(item, v)
    # Each new channel's size, in one call.
    channels = list(dict.fromkeys(items[k]["channelId"] for k in new if items[k].get("channelId")))
    if channels:
        subs = {c["id"]: c.get("statistics") or {} for c in youtube("channels", {"part": "statistics", "id": ",".join(channels[:50])}).get("items") or []}
        for k in new:
            s = subs.get(items[k].get("channelId")) or {}
            if not s.get("hiddenSubscriberCount") and "subscriberCount" in s:
                items[k]["subscribers"] = int(s["subscriberCount"])
    if new:
        status.active("youtube", "new video")
    found.extend(new)
    newest = max((items[k]["at"] for k in new), default=0)
    marks["youtube"] = max(marks.get("youtube", 0), newest) or now()
    _ran("youtube", app_id)
    status.ok("youtube")
    return True


# ---------------------------------------------------------------------------
# News: Google News search, and any Google Alerts feeds
# ---------------------------------------------------------------------------


def _text(el, tag):
    found = el.find(tag)
    return (found.text or "").strip() if found is not None else ""


def _strip_tags(text):
    """Google's <b> around the search words goes without a trace; any other tag becomes a space."""
    text = re.sub(r"</?(b|i|em|strong)>", "", text or "", flags=re.I)
    return html.unescape(re.sub(r"<[^>]+>", " ", text))


def _rfc822(text):
    try:
        from email.utils import parsedate_to_datetime

        return int(parsedate_to_datetime(text).timestamp())
    except (TypeError, ValueError):
        return None


def google_news(names, lang="english"):
    """Articles from one Google News edition that name the game exactly, by any of `names`."""
    hl, gl, ceid = LANGS[lang]
    xml = request("https://news.google.com/rss/search", params={"q": " OR ".join(f'"{n}"' for n in names), "hl": hl, "gl": gl, "ceid": ceid}, as_json=False)
    out = []
    for item in ET.fromstring(xml).iter("item"):
        source = item.find("source")
        site = (source.text or "").strip() if source is not None else ""
        title = _text(item, "title")
        if site and title.endswith(f" - {site}"):
            title = title[: -len(site) - 3]
        out.append({
            "key": _text(item, "guid") or _text(item, "link"),
            "url": _text(item, "link"), "title": title, "author": site,
            "authorUrl": source.get("url") if source is not None else None,
            "at": _rfc822(_text(item, "pubDate")),
            "lang": hl.split("-")[0],
        })
    return out


ATOM = "{http://www.w3.org/2005/Atom}"
_alerts = None


def google_alerts():
    """Every entry of every Google Alerts feed (Atom), read once a run: (feed query, entry)."""
    global _alerts
    if _alerts is not None:
        return _alerts
    _alerts = []
    for feed in ALERT_FEEDS:
        root = ET.fromstring(request(feed, as_json=False))
        query = re.sub(r"^Google Alert - ", "", _text(root, f"{ATOM}title"))
        for entry in root.iter(f"{ATOM}entry"):
            link = entry.find(f"{ATOM}link")
            href = link.get("href") if link is not None else ""
            # Alerts link through google.com/url?url=<the article>.
            real = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query).get("url", [href])[0]
            _alerts.append((query, {
                "key": real, "url": real,
                "title": _strip_tags(_text(entry, f"{ATOM}title")),
                "text": _strip_tags(_text(entry, f"{ATOM}content")),
                "author": urllib.parse.urlsplit(real).netloc.removeprefix("www."),
                "at": iso_time(_text(entry, f"{ATOM}published")),
            }))
    return _alerts


def _host(url):
    return urllib.parse.urlsplit(url or "").netloc.lower().removeprefix("www.")


# Download sites and the words they use, for copies of the game being given away (cracked, repacked
# or "free"). Checked on the link and the title; the stores selling it are never one.
COPY_SITES = re.compile(
    r"\b(torrents?|crack(ed)?|repacks?|warez|skidrow|fitgirl|dodi|elamigos|igg ?games|steamunlocked|steamrip|"
    r"oceanofgames|ocean of games|ova ?games|game3rb|gog ?games|apunkagames|nosteam|online ?fix|pcgamestorrents|ankergames|"
    r"gamesfull|freegogpcgames|uploadhaven|mediafire|full version|free download|download free|"
    r"скачать|торрент|descargar gratis|télécharger gratuit\w*|download gratis|下载|ダウンロード)\b")
STORES = {"store.steampowered.com", "steamcommunity.com", "gog.com", "itch.io", "epicgames.com", "store.epicgames.com",
          "humblebundle.com", "fanatical.com", "nintendo.com", "xbox.com", "playstation.com", "steamdb.info"}


def is_copy(url, title):
    if _host(url) in STORES:
        return False
    return bool(COPY_SITES.search(norm(urllib.parse.unquote(url or ""))) or COPY_SITES.search(norm(title)))


def collect_news(media, game, found):
    app_id = game["appId"]
    names = all_names(media, game)
    every = [n for _, n in names]
    # The US edition every 30 minutes; every other country's every 2 hours, by the English name
    # and the names in its language (local sites often keep the English one).
    editions = [lang for lang in LANGS if _due(f"news-{lang}", app_id, EVERY["news"] if lang == "english" else EVERY["news-local"])]
    if not editions:
        return False
    articles = []
    for lang in editions:
        articles += google_news([game["name"]] + [n for l, n in names if l == lang], lang)
        _ran(f"news-{lang}", app_id)
        time.sleep(0.3)
    try:
        # An alert is the game's when its search names the game (all its names joined with OR), or
        # the page does.
        articles += [{**e, "alert": True} for query, e in google_alerts() if mentions(every, query) or mentions(every, e["title"], e["text"])]
    except (HttpError, ET.ParseError) as error:
        status.fail("news", f"Couldn't read a Google Alerts feed ({error}); check GOOGLE_ALERTS_FEEDS.")
    items = media["items"]
    seen = {i.get("title", "").lower() for i in items.values() if i["source"] == "news"}
    # Sites Google News has articles from: an alert's page there is news, anywhere else a web page.
    news_sites = {_host(i.get("authorUrl")) for i in items.values() if i["source"] == "news"}
    news_sites |= {_host(a.get("authorUrl")) for a in articles if not a.get("alert")}
    for a in articles:
        # A Reddit thread (from an alert like site:reddit.com "Game name") is listed as Reddit, under its subreddit.
        sub = re.match(r"https?://(?:[a-z]+\.)?reddit\.com/(r/[^/]+)", a["url"] or "")
        copy = a.get("alert") and not sub and is_copy(a["url"], a["title"])
        source = "reddit" if sub else "copy" if copy else "web" if a.get("alert") and _host(a["url"]) not in news_sites else "news"
        key = _id({"reddit": "rd", "copy": "cp", "web": "wb"}.get(source, "nw"), a["key"])
        # The same story reached through Google News and an alert (different links) counts once. A
        # Reddit thread is about a game when it says so or its subreddit is about games; a download
        # page naming the game is always one.
        if key in items or not a["url"] or a["title"].lower() in seen:
            continue
        if not (copy or about_games(a["title"], a.get("text")) or (sub and re.search(r"gam|steam|indie", sub.group(1).lower()))):
            continue
        seen.add(a["title"].lower())
        items[key] = {"id": key, "source": source, "url": a["url"], "title": _clip(re.sub(r"\s*:\s*r/\w+$", "", a["title"]), 300),
                      "text": _clip(a.get("text"), 400) or None,
                      "author": sub.group(1) if sub else a["author"],
                      "authorUrl": f"https://www.reddit.com/{sub.group(1)}/" if sub else a.get("authorUrl"),
                      "at": a["at"] or now(), "lang": a.get("lang") if a.get("lang") != "en" else None}
        found.append(key)
        status.active("news", {"reddit": "new Reddit post", "copy": "new download copy", "web": "new web page"}.get(source, "new article"))
    status.ok("news")
    return True


# ---------------------------------------------------------------------------
# A run
# ---------------------------------------------------------------------------

SOURCES = {"twitch": "Twitch", "youtube": "YouTube", "news": "news"}
QUIET = {"reddit", "web", "copy"}  # listed, never alerted


def collect(state, game, games):
    """Searches every source that's due for this game. Returns the ids of what's new, to alert on.
    A source's first search for a game only sets the baseline (the backlog isn't news), except for
    Twitch: whoever is live is worth knowing about whenever it is."""
    media = state.setdefault("media", {"items": {}})
    media.setdefault("items", {})
    started = media.setdefault("started", {})
    alert = []
    update_names(media, game)
    for source, run in (("twitch", collect_twitch), ("youtube", collect_youtube), ("news", collect_news)):
        found = []
        try:
            searched = run(media, game, found, games) if source == "youtube" else run(media, game, found)
        except (HttpError, KeyError, ValueError, ET.ParseError) as error:
            print(f"[{source}] {game['name']}: {type(error).__name__}: {error}")
            status.fail(source, f"Couldn't search {SOURCES[source]} ({error}).")
            continue
        if not searched:
            continue
        if started.get(source) or source == "twitch":
            # Search results can surface something old; that's not news.
            alert.extend(k for k in found if now() - media["items"][k]["at"] < ALERT_DAYS * 86400 and not media["items"][k].get("own")
                         and media["items"][k]["source"] not in QUIET)
        started.setdefault(source, now())
    if alert:
        print(f"[media] {game['name']}: {len(alert)} new ({', '.join(sorted({media['items'][k]['source'] for k in alert}))})")
    return alert
