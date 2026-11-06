"""The dashboard's "Tag my game" check, POST /v1/admin/tagcheck: does each tag really describe the game?

The Market page's "Tag my game" (src/lib/feedback/market-tags.js) works out from the market files which
tags go with doing well among games like ours. Numbers can't tell whether a tag is true of the game,
and a tag that isn't brings the wrong players (refunds, bad reviews). So the owner can ask Claude:
it reads the game's description (the text sent, or the store page's when none is sent) and marks every
current tag and every suggested one as fits / maybe / no, with a short reason. Nothing is stored; the
dashboard keeps the last answer in the browser.

  POST /v1/admin/tagcheck  {appid?, name, about?, tags: [names], candidates: [names]}
  -> 200 {summary, current: [{tag, fits, why}], candidates: [...], source: "given"|"store", model}

Behind admin.require_admin. The key is ANTHROPIC_API_KEY, as for the game ideas (ideas.py); without it
the check answers 503 claude_not_configured.
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
from typing import Any

import aiohttp
from aiohttp import web

from . import web as W
from .limits import Refused, read_json

log = logging.getLogger("gamedata.tagcheck")

# Haiku 5.5, as for the ideas: a check is ~3k tokens in, ~1k out, well under a cent.
MODEL = "claude-haiku-5-5"
EFFORT = "medium"
MAX_TOKENS = 6000
CLAUDE_TIMEOUT = 120.0
CLAUDE_PARALLEL = 2
STORE_URL = "https://store.steampowered.com/api/appdetails"
STORE_TIMEOUT = 20
KB = 1024
BODY_CAPS = (16 * KB, 16 * KB)
MAX_NAME = 200
MAX_ABOUT = 6000
MAX_TAGS = 20
MAX_TAG_LEN = 60
FITS = ["yes", "maybe", "no"]

TAGCHECK = web.AppKey("tagcheck", object)

SYSTEM = """You check Steam store tags for a small indie studio's game. You get the game's description \
and two lists of Steam user tags: the tags the game has now, and tags that similar games use and that \
the market data suggests adding. For every tag in both lists, say whether it truly describes this game \
as the description presents it:
- "yes": a player who picked the game for this tag would find it there.
- "maybe": plausible, but the description doesn't say enough to be sure (say what would make it true).
- "no": it doesn't describe the game; a player looking for it would be disappointed.
Judge only by the description, not by whether the tag sells. Generic tags (Indie, Singleplayer, \
Casual...) are "yes" when they're true. Keep each reason to one short sentence, concrete, naming what \
in the game makes it fit or not. The summary: two or three sentences, the most useful changes first \
(tags to drop, true suggestions worth adding, and anything the description leaves unclear)."""

ITEM = {"type": "object", "properties": {
    "tag": {"type": "string"}, "fits": {"type": "string", "enum": FITS}, "why": {"type": "string"}},
    "required": ["tag", "fits", "why"], "additionalProperties": False}
SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"summary": {"type": "string"},
                   "current": {"type": "array", "items": ITEM},
                   "candidates": {"type": "array", "items": ITEM}},
    "required": ["summary", "current", "candidates"],
    "additionalProperties": False,
}


class Checker:
    """The Claude client (made on first use; a test swaps it for a fake) and the store fetch."""

    def __init__(self):
        self.client = None
        self._parallel: asyncio.Semaphore | None = None

    @property
    def parallel(self) -> asyncio.Semaphore:
        if self._parallel is None:
            self._parallel = asyncio.Semaphore(CLAUDE_PARALLEL)
        return self._parallel


def make_client():
    import anthropic
    return anthropic.AsyncAnthropic(timeout=CLAUDE_TIMEOUT, max_retries=1)


def plain(text: str) -> str:
    """Store HTML as plain text: tags out, entities decoded, whitespace squeezed."""
    text = re.sub(r"<\s*(br|/p|/li|/h\d)\s*/?>", "\n", text or "", flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    text = "\n".join(line.strip() for line in re.sub(r"[ \t\r\f\v]+", " ", text).split("\n"))
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


async def fetch_about(appid: int) -> str:
    """The store page's short description and "About this game", in English."""
    url = os.environ.get("TAGCHECK_STORE_URL", "").strip() or STORE_URL
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=STORE_TIMEOUT)) as session:
            async with session.get(url, params={"appids": str(appid), "l": "english", "cc": "us"},
                                   headers={"User-Agent": "FourGamesDashboard/1.0"}) as response:
                if response.status != 200:
                    raise Refused(502, "store_unavailable", f"the Steam store answered HTTP {response.status}; paste the description instead")
                body = await response.json(content_type=None)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
        raise Refused(502, "store_unavailable", "the Steam store can't be reached; paste the description instead") from None
    entry = (body or {}).get(str(appid)) or {}
    data = entry.get("data") if entry.get("success") else None
    if not isinstance(data, dict):
        raise Refused(404, "no_store_page", "Steam has no public store page for that app; paste the description instead")
    parts = [plain(data.get("short_description", "")), plain(data.get("about_the_game", "") or data.get("detailed_description", ""))]
    return "\n\n".join(p for p in parts if p)[:MAX_ABOUT]


def tag_list(body: dict[str, Any], name: str) -> list[str]:
    value = body.get(name, [])
    if not isinstance(value, list) or len(value) > MAX_TAGS or not all(isinstance(t, str) and 0 < len(t.strip()) <= MAX_TAG_LEN for t in value):
        raise Refused(400, "bad_request", f"{name} must be a list of at most {MAX_TAGS} tag names")
    out: list[str] = []
    for t in value:
        t = t.strip()
        if t.lower() not in {x.lower() for x in out}:
            out.append(t)
    return out


def user_prompt(name: str, about: str, tags: list[str], candidates: list[str]) -> str:
    lines = [f"Game: {name}", "", "Description:", about, "",
             "Current tags (most important first): " + ", ".join(tags)]
    lines.append("Suggested tags: " + (", ".join(candidates) if candidates else "(none)"))
    return "\n".join(lines)


def tidy(result: dict[str, Any], tags: list[str], candidates: list[str]) -> dict[str, Any]:
    """Claude's answer for exactly the tags sent, in their order; a tag it skipped is "maybe"."""
    def pick(items: Any, names: list[str]) -> list[dict[str, str]]:
        by = {}
        for it in items if isinstance(items, list) else []:
            if isinstance(it, dict) and isinstance(it.get("tag"), str):
                by.setdefault(it["tag"].strip().lower(), it)
        out = []
        for n in names:
            it = by.get(n.lower(), {})
            fits = it.get("fits") if it.get("fits") in FITS else "maybe"
            why = it.get("why") if isinstance(it.get("why"), str) and it.get("why").strip() else "Claude didn't say."
            out.append({"tag": n, "fits": fits, "why": why.strip()[:400]})
        return out
    summary = result.get("summary") if isinstance(result.get("summary"), str) else ""
    return {"summary": summary.strip()[:1500], "current": pick(result.get("current"), tags),
            "candidates": pick(result.get("candidates"), candidates)}


async def ask_claude(client, prompt: str) -> tuple[dict[str, Any], str]:
    import anthropic
    try:
        async with client.messages.stream(
            model=MODEL, max_tokens=MAX_TOKENS,
            output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": SCHEMA}},
            system=SYSTEM, messages=[{"role": "user", "content": prompt}],
        ) as stream:
            message = await stream.get_final_message()
    except anthropic.AuthenticationError:
        raise Refused(503, "claude_key_refused", "Anthropic refused the server's ANTHROPIC_API_KEY") from None
    except anthropic.RateLimitError:
        raise Refused(429, "claude_busy", "Claude's rate limit is used up; try again in a minute", {"Retry-After": "60"}) from None
    except anthropic.APIStatusError as error:
        log.warning("claude answered %s", error.status_code)
        raise Refused(502, "claude_error", f"Claude had a problem (HTTP {error.status_code}); try again") from None
    except anthropic.APITimeoutError:
        raise Refused(504, "claude_timeout", "Claude didn't answer in time; try again") from None
    except anthropic.APIConnectionError:
        raise Refused(502, "claude_unavailable", "Claude can't be reached; try again") from None
    if message.stop_reason == "refusal":
        raise Refused(502, "claude_refused", "Claude declined to check these tags")
    if message.stop_reason == "max_tokens":
        raise Refused(502, "claude_cut_off", "Claude's answer was cut off; try again")
    text = next((b.text for b in message.content if b.type == "text"), "")
    try:
        result = json.loads(text)
    except ValueError:
        raise Refused(502, "claude_bad_answer", "Claude's answer wasn't readable; try again") from None
    if not isinstance(result, dict):
        raise Refused(502, "claude_bad_answer", "Claude's answer wasn't readable; try again")
    return result, getattr(message, "model", MODEL) or MODEL


async def tagcheck(request: web.Request) -> web.Response:
    from .admin import require_admin
    require_admin(request)
    body = await read_json(request, *BODY_CAPS, require_json_type=True)
    if not isinstance(body, dict) or not set(body) <= {"appid", "name", "about", "tags", "candidates"}:
        raise Refused(400, "bad_request", "send {appid?, name, about?, tags, candidates}")
    name = body.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > MAX_NAME:
        raise Refused(400, "bad_request", f"name must be the game's name (at most {MAX_NAME} characters)")
    appid = body.get("appid")
    if appid is not None and (type(appid) is not int or not 0 < appid < 2**31):
        raise Refused(400, "bad_request", "appid must be a Steam app id")
    about = body.get("about")
    if about is not None and (not isinstance(about, str) or len(about) > MAX_ABOUT):
        raise Refused(400, "bad_request", f"about must be text (at most {MAX_ABOUT} characters)")
    tags, candidates = tag_list(body, "tags"), tag_list(body, "candidates")
    if not tags:
        raise Refused(400, "bad_request", "send at least one current tag")
    candidates = [c for c in candidates if c.lower() not in {t.lower() for t in tags}]
    checker: Checker = request.app[TAGCHECK]
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip() and checker.client is None:
        raise Refused(503, "claude_not_configured", "the server has no ANTHROPIC_API_KEY in its environment")
    about = (about or "").strip()
    source = "given"
    if not about:
        if appid is None:
            raise Refused(400, "bad_request", "send about (the game's description) or an appid to read the store page")
        about, source = await fetch_about(appid), "store"
        if not about:
            raise Refused(404, "no_description", "the store page has no description; paste one instead")
    if checker.client is None:
        checker.client = make_client()
    async with checker.parallel:
        raw, model = await ask_claude(checker.client, user_prompt(name.strip(), about, tags, candidates))
    out = tidy(raw, tags, candidates)
    log.info("tag check for %s: %d tags, %d suggestions, by %s", appid or "a game without an app id", len(tags), len(candidates), model)
    return W.ok({**out, "source": source, "model": model})


def add_routes(app: web.Application, v1: str) -> None:
    if TAGCHECK not in app:
        app[TAGCHECK] = Checker()
    app.router.add_route("POST", f"{v1}/tagcheck", tagcheck)
