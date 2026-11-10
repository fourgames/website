"""A fake Steam and PCGamingWiki for the tests: no request ever leaves the machine."""

import json
import random
import urllib.parse
from datetime import datetime, timezone

import pytest

from steamdata.config import Config
from steamdata.db import Store
from steamdata.net import Http

# 2026-11-04 12:00 UTC
NOW = datetime(2026, 11, 4, 12, tzinfo=timezone.utc).timestamp()


class FakeClock:
    def __init__(self, now: float = NOW):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += max(seconds, 0.001)


def item(appid, name, *, kind=0, reviews=100, pct=90, score=8, price=999, original=None,
         discount=0, free=False, release=1_700_000_000, coming_soon=False, tags=(19, 492),
         success=1, deck=3, devs=("Dev",)):
    """One store_items entry like IStoreBrowseService/GetItems returns."""
    if success != 1:
        return {"item_type": 0, "id": appid, "success": success, "visible": False, "name": "",
                "store_url_path": "app/0/", "appid": 0}
    out = {"item_type": 0, "id": appid, "success": 1, "visible": True, "name": name, "appid": appid,
           "type": kind,
           "tagids": list(tags),
           "categories": {"supported_player_categoryids": [2], "feature_categoryids": [22]},
           "reviews": {"summary_filtered": {"review_count": reviews, "percent_positive": pct,
                                            "review_score": score, "review_score_label": "x"}},
           "basic_info": {"short_description": f"{name} is a game.",
                          "developers": [{"name": d, "creator_clan_account_id": 1} for d in devs],
                          "publishers": [{"name": "Pub", "creator_clan_account_id": 2}]},
           "tags": [{"tagid": t, "weight": 1000 - i} for i, t in enumerate(tags)],
           "release": {"steam_release_date": release, **({"is_coming_soon": True,
                                                          "coming_soon_display": "date_quarter"}
                                                         if coming_soon else {})},
           "platforms": {"windows": True, "mac": False, "steamos_linux": True,
                         "steam_deck_compat_category": deck}}
    if free:
        out["is_free"] = True
    elif price is not None:
        option = {"packageid": 1, "final_price_in_cents": str(price), "formatted_final_price": "$"}
        if original:
            option["original_price_in_cents"] = str(original)
            option["discount_pct"] = discount
        out["best_purchase_option"] = option
    return out


def details(name, *, kind="game", legal=None, description="A fine game.", genres=((1, "Action"),)):
    return {"type": kind, "name": name, "steam_appid": 1, "required_age": 0, "is_free": False,
            "detailed_description": description, "about_the_game": description,
            "short_description": "Short.", "legal_notice": legal,
            "supported_languages": "English<strong>*</strong>, French<br><strong>*</strong>languages with full audio support",
            "developers": ["Dev"], "publishers": ["Pub"],
            "genres": [{"id": str(g), "description": n} for g, n in genres],
            "categories": [{"id": 2, "description": "Single-player"}],
            "pc_requirements": {"minimum": "<strong>Minimum:</strong> OpenGL 3.3"},
            "release_date": {"coming_soon": False, "date": "Jun 23, 2023"},
            "achievements": {"total": 12}, "dlc": [5, 6], "controller_support": "full"}


GODOT_PAGE = """{{Infobox game
|steam appid  = %d
|steam appid side = 9999
}}
{{Infobox game/row/engine|Godot|name=Godot 3|build=3.7.0.0|ref=<ref>{{Refcheck|user=X|date=2026-02-22}}</ref>}}
"""
MENTION_PAGE = """{{Infobox game
|steam appid  = %d
}}
{{Infobox game/row/engine|Clausewitz}}
{{ii}} Open source reimplementation in [[Engine:Godot|Godot]].
"""


def store_page_html(appid, ai=""):
    """A store page cut down to what's read from it. ai: the disclosure text ("" none, None: the
    store sent its front page instead)."""
    if ai is None:
        return '<html><link rel="canonical" href="https://store.steampowered.com/"></html>'
    box = ('<div class="game_page_autocollapse"> <div id="game_area_content_descriptors" class="game_area_description">'
           ' <h2>AI Generated Content Disclosure</h2> <p>The developers describe how their game uses AI Generated'
           f' Content like this:</p> <p><i> {ai} </i> </p> </div> </div>') if ai else ""
    return (f'<html><link rel="canonical" href="https://store.steampowered.com/app/{appid}/Some_Game/">'
            f'<div id="appHubAppName" class="apphub_AppName">Some Game</div>{box}'
            '<div class="game_page_autocollapse sys_req"><h2>System Requirements</h2></div></html>')


class FakeWeb:
    """The transport for Http: routes by path to a small fake Steam and PCGamingWiki."""

    def __init__(self, clock: FakeClock):
        self.clock = clock
        self.calls: list[tuple[float, str, str, dict]] = []
        # appid -> GetItems entry; also the app list (games only) and player counts.
        self.items: dict[int, dict] = {}
        self.listed: list[int] = []
        self.list_modified: dict[int, int] = {}
        self.players: dict[int, int] = {}
        self.details: dict[int, dict | None] = {}
        self.ai: dict[int, str | None] = {}  # appid -> its AI disclosure text (None: no store page)
        self.pcgw_pages: dict[int, tuple[str, int, str]] = {}  # pageid -> (title, revid, text)
        self.fail: dict[str, list] = {}  # path -> replies to give before the normal one
        self.page_size = 10000

    def __call__(self, url, headers, timeout):
        parts = urllib.parse.urlsplit(url)
        params = dict(urllib.parse.parse_qsl(parts.query))
        self.calls.append((self.clock.now, parts.netloc, parts.path, params))
        queued = self.fail.get(parts.path)
        if queued:
            reply = queued.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply
        handler = {
            "/IStoreService/GetAppList/v1/": self.app_list,
            "/IStoreBrowseService/GetItems/v1/": self.get_items,
            "/ISteamUserStats/GetNumberOfCurrentPlayers/v1/": self.current_players,
            "/IStoreService/GetTagList/v1/": self.tag_list,
            "/api/appdetails": self.app_details,
            "/w/api.php": self.wiki,
        }.get(parts.path)
        if handler is None and parts.path.startswith("/app/"):
            return self.store_page(int(parts.path.split("/")[2]))
        if handler is None:
            return 404, {}, b"<html>not found</html>"
        out = handler(params)
        if isinstance(out, tuple):
            return out
        return 200, {"content-type": "application/json"}, json.dumps(out).encode()

    def calls_to(self, path_part: str):
        return [c for c in self.calls if path_part in c[2]]

    def app_list(self, p):
        if not p.get("key"):
            return 403, {}, b"<html>Forbidden</html>"
        since = int(p.get("if_modified_since", 0))
        after = int(p.get("last_appid", 0))
        size = min(int(p.get("max_results", 10000)), self.page_size)
        apps = [a for a in sorted(self.listed) if a > after and self.list_modified.get(a, 1) > since]
        page, more = apps[:size], len(apps) > size
        res = {"apps": [{"appid": a, "name": self.items.get(a, {}).get("name", f"App {a}"),
                         "last_modified": self.list_modified.get(a, 1), "price_change_number": 7}
                        for a in page]}
        if more:
            res.update(have_more_results=True, last_appid=page[-1])
        return {"response": res}

    def get_items(self, p):
        request = json.loads(p["input_json"])
        out = [self.items.get(i["appid"]) or item(i["appid"], "", success=15) for i in request["ids"]]
        return {"response": {"store_items": out}}

    def current_players(self, p):
        appid = int(p["appid"])
        if appid not in self.players:
            return 404, {}, b'{"response":{"result":42}}'
        return {"response": {"player_count": self.players[appid], "result": 1}}

    def tag_list(self, p):
        return {"response": {"version_hash": "1", "tags": [{"tagid": 19, "name": "Action"},
                                                           {"tagid": 492, "name": "Indie"}]}}

    def store_page(self, appid):
        return 200, {"content-type": "text/html"}, store_page_html(appid, self.ai.get(appid, "")).encode()

    def app_details(self, p):
        appid = int(p["appids"])
        data = self.details.get(appid)
        if data is None:
            return {str(appid): {"success": False}}
        return {str(appid): {"success": True, "data": data}}

    def wiki(self, p):
        if p.get("generator") == "backlinks":
            pages = [{"pageid": pid, "ns": 0, "title": t, "lastrevid": rev}
                     for pid, (t, rev, _) in sorted(self.pcgw_pages.items())]
            return {"batchcomplete": True, "query": {"pages": pages}}
        if p.get("pageids"):
            pages = []
            for pid in (int(x) for x in p["pageids"].split("|")):
                title, rev, text = self.pcgw_pages[pid]
                pages.append({"pageid": pid, "ns": 0, "title": title,
                              "revisions": [{"revid": rev, "slots": {"main": {"content": text}}}]})
            return {"batchcomplete": True, "query": {"pages": pages}}
        return 400, {}, b"{}"


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def web(clock):
    return FakeWeb(clock)


@pytest.fixture
def http(web):
    return Http("test-agent", transport=web)


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "steam.db")


@pytest.fixture
def store(db_path):
    s = Store(db_path)
    yield s
    s.close()


@pytest.fixture
def rng():
    return random.Random(1)


@pytest.fixture
def config(db_path):
    return Config(db_path=db_path, web_api_key="test-key")
