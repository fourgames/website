"""PCGamingWiki: which games list an engine (Godot) in their infobox, through its public MediaWiki API.

PCGamingWiki's Cargo queries (action=cargoquery) are only open to signed-in users, so this uses two
ordinary, cheap API queries instead:

1. The pages that link to Engine:Godot (generator=backlinks, with each page's latest revision id).
2. The wikitext of the new or changed ones, 20 pages per request, to read the infobox's engine row
   ({{Infobox game/row/engine|Godot|...}}) and Steam app id (|steam appid = 1942280).

A page whose infobox lists the engine is strength 2; one that only links it elsewhere (e.g. "open
source reimplementation in Godot") is strength 1. PCGamingWiki's content is CC BY-NC-SA 3.0: fine
for our own analysis, not for republishing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .engine import MENTION, STRONG
from .net import Http

API = "https://www.pcgamingwiki.com/w/api.php"
PAGES_PER_REQUEST = 20


@dataclass(frozen=True)
class PageRef:
    pageid: int
    title: str
    revid: int


@dataclass(frozen=True)
class PageInfo:
    pageid: int
    title: str
    revid: int
    appids: tuple[int, ...]
    strength: int
    evidence: str


def engine_key(name: str) -> str:
    """"Godot" -> "godot", the engine name used in engine_signals."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


def backlinks(http: Http, engine: str, cont: dict | None = None) -> tuple[list[PageRef], dict | None]:
    """One batch (up to 500) of the main-namespace pages linking to Engine:<engine>, and the
    continuation for the next batch (None when done)."""
    params = {"action": "query", "format": "json", "formatversion": "2",
              "generator": "backlinks", "gbltitle": f"Engine:{engine}", "gblnamespace": "0",
              "gbllimit": "500", "prop": "info"}
    params.update(cont or {})
    data = http.get_json(API, params)
    pages = ((data.get("query") or {}).get("pages") or []) if isinstance(data, dict) else []
    refs = [PageRef(int(p["pageid"]), str(p.get("title") or ""), int(p.get("lastrevid") or 0))
            for p in pages if isinstance(p.get("pageid"), int)]
    nxt = data.get("continue") if isinstance(data, dict) else None
    return refs, (dict(nxt) if nxt else None)


def contents(http: Http, pageids: list[int]) -> dict[int, tuple[str, int, str]]:
    """pageid -> (title, revid, wikitext), for the pages the reply has content for."""
    params = {"action": "query", "format": "json", "formatversion": "2",
              "pageids": "|".join(str(p) for p in pageids),
              "prop": "revisions", "rvprop": "ids|content", "rvslots": "main"}
    data = http.get_json(API, params)
    pages = ((data.get("query") or {}).get("pages") or []) if isinstance(data, dict) else []
    out = {}
    for p in pages:
        revs = p.get("revisions") or []
        if not revs or not isinstance(p.get("pageid"), int):
            continue
        main = (revs[0].get("slots") or {}).get("main") or {}
        text = main.get("content")
        if isinstance(text, str):
            out[p["pageid"]] = (str(p.get("title") or ""), int(revs[0].get("revid") or 0), text)
    return out


_ENGINE_ROW = re.compile(r"\{\{\s*Infobox game/row/engine\s*\|([^{}]*(?:\{\{[^{}]*\}\}[^{}]*)*)\}\}", re.I)
_STEAM_APPID = re.compile(r"^\s*\|\s*steam appid\s*=\s*([0-9 ,]+)\s*$", re.I | re.M)


def _row_args(body: str) -> tuple[str, dict[str, str]]:
    # Drop nested templates such as the <ref>{{Refcheck|...}}</ref> before splitting on |.
    body = re.sub(r"\{\{[^{}]*\}\}", "", body)
    body = re.sub(r"<ref[^>]*>.*?</ref>|<ref[^>]*/>", "", body, flags=re.S)
    parts = [p.strip() for p in body.split("|")]
    named = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            named[k.strip().lower()] = v.strip()
    return parts[0], named


def parse_page(pageid: int, title: str, revid: int, text: str, engine: str) -> PageInfo:
    appids: list[int] = []
    for match in _STEAM_APPID.finditer(text):
        for part in match.group(1).split(","):
            part = part.strip()
            if part.isdigit() and int(part) not in appids:
                appids.append(int(part))
    key = engine_key(engine)
    strength, evidence = MENTION, f"PCGamingWiki page {title!r} links Engine:{engine}"
    for match in _ENGINE_ROW.finditer(text):
        value, named = _row_args(match.group(1))
        if engine_key(value).startswith(key):
            strength = STRONG
            version = named.get("name") or value
            build = named.get("build")
            evidence = f"PCGamingWiki infobox: {version}" + (f" ({build})" if build else "") + f" - {title}"
            break
    return PageInfo(pageid, title, revid, tuple(appids), strength, evidence[:200])
