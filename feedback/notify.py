"""Discord webhook embeds. The webhook URL and the mention come from GitHub secrets
(DISCORD_WEBHOOK_URL, DISCORD_MENTION) and are never written anywhere. Without a webhook the
payloads are printed instead, for local runs."""

import json
import os
import re
import time
import urllib.error
import urllib.request

import status

WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
# A Discord user or role to ping: "<@123>", "<@&456>", or a bare user ID.
MENTION = os.environ.get("DISCORD_MENTION", "").strip()
DASHBOARD_URL = "https://fourgames.se/fb-dash/"

COLORS = {"urgent": 0xE5484D, "flip": 0xF76B15, "cluster": 0xFFC53D, "daily": 0x3E63DD, "still": 0xD6409F}


def _mention():
    m = re.fullmatch(r"<@(&?)(\d+)>|(\d+)", MENTION)
    if not m:
        return "", {"parse": []}
    if m.group(3):
        return f"<@{m.group(3)}>", {"parse": [], "users": [m.group(3)]}
    if m.group(1):
        return f"<@&{m.group(2)}>", {"parse": [], "roles": [m.group(2)]}
    return f"<@{m.group(2)}>", {"parse": [], "users": [m.group(2)]}


# Flags for the alert's language field (dashboard.js has the same idea): the country a language is
# most associated with.
FLAGS = {
    "english": "gb", "korean": "kr", "japanese": "jp", "chinese": "cn", "simplified chinese": "cn",
    "traditional chinese": "tw", "german": "de", "french": "fr", "spanish": "es", "portuguese": "pt",
    "brazilian portuguese": "br", "russian": "ru", "polish": "pl", "italian": "it", "turkish": "tr", "ukrainian": "ua",
    "dutch": "nl", "swedish": "se", "danish": "dk", "norwegian": "no", "finnish": "fi", "czech": "cz",
    "hungarian": "hu", "thai": "th", "vietnamese": "vn", "indonesian": "id", "arabic": "sa",
}


def _flag(language):
    code = FLAGS.get((language or "").lower())
    flag = "".join(chr(0x1F1A5 + ord(c)) for c in code.upper()) if code else ""
    return f"{flag} {language}".strip()


def _clip(text, limit):
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def send(embeds, ping=False):
    """Posts up to 10 embeds in one message. Returns True when Discord accepted it (or no webhook is set)."""
    mention, allowed = _mention() if ping else ("", {"parse": []})
    embeds = [{k: v for k, v in e.items() if v is not None} for e in embeds[:10]]
    payload = {"username": "Player feedback", "embeds": embeds, "allowed_mentions": allowed}
    if mention:
        payload["content"] = mention
    if not WEBHOOK:
        print("[discord] (no webhook) " + json.dumps(payload, ensure_ascii=False)[:2000])
        status.fail("discord", "No DISCORD_WEBHOOK_URL secret is set, so alerts aren't sent.")
        return True
    body = json.dumps(payload).encode()
    for attempt in range(5):
        req = urllib.request.Request(
            WEBHOOK, data=body, headers={"Content-Type": "application/json", "User-Agent": "fourgames-feedback/1.0"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30):
                status.ok("discord")
                return True
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt < 4:
                try:
                    wait = float(json.loads(error.read()).get("retry_after", 2))
                except ValueError:
                    wait = 2
                time.sleep(min(wait, 60))
                continue
            print(f"[discord] webhook returned HTTP {error.code}")
            status.fail("discord", f"The Discord webhook returned HTTP {error.code}; it may have been deleted.")
            return False
        except urllib.error.URLError as error:
            print(f"[discord] webhook failed: {type(error).__name__}")
            status.fail("discord", "Couldn't reach Discord.")
            return False
    return False


def _quote(item):
    t = item.get("triage") or {}
    return _clip(t.get("english") or item.get("text"), 700)


def _post_fields(item):
    t = item.get("triage") or {}
    fields = [{"name": "Area", "value": _clip(t.get("area") or "-", 100), "inline": True}]
    if t.get("language") and t["language"] != "English":
        fields.append({"name": "Language", "value": _flag(t["language"]), "inline": True})
    if item["kind"] == "review":
        fields.append({"name": "Played", "value": f"{item.get('playtime', 0)} h", "inline": True})
    return fields


def urgent(game, item, issue):
    title = issue["title"] if issue else (item.get("triage") or {}).get("summary", "Urgent report")
    return {
        "title": _clip(f"🚨 Urgent · {game['name']}: {title}", 256),
        "url": item["url"],
        "description": _clip(f"> {_quote(item)}\n\n[Open the post]({item['url']}) · [Dashboard]({DASHBOARD_URL})", 4000),
        "color": COLORS["urgent"],
        "fields": _post_fields(item),
        "timestamp": _iso(item.get("updated") or item.get("created")),
    }


def flip(game, item):
    return {
        "title": _clip(f"👎 Review flipped to negative · {game['name']}", 256),
        "url": item["url"],
        "description": _clip(f"> {_quote(item)}\n\n[Open the review]({item['url']}) · [Dashboard]({DASHBOARD_URL})", 4000),
        "color": COLORS["flip"],
        "fields": _post_fields(item),
        "timestamp": _iso(item.get("updated")),
    }


def cluster(game, issue, items):
    links = "\n".join(
        f"• [{_clip((i.get('triage') or {}).get('summary') or i['kind'], 90)}]({i['url']})"
        + (f" ({i['triage']['language']})" if (i.get("triage") or {}).get("language", "English") != "English" else "")
        for i in items[:6]
    )
    langs = ", ".join(_flag(lang) for lang in issue.get("languages") or [])
    return {
        "title": _clip(f"🔁 {issue['mentions']} players report: {issue['title']} · {game['name']}", 256),
        "url": items[0]["url"] if items else DASHBOARD_URL,
        "description": _clip(f"Latest reports:\n{links}\n\n[Dashboard]({DASHBOARD_URL})", 4000),
        "color": COLORS["cluster"],
        "fields": [
            {"name": "Kind", "value": issue["kind"], "inline": True},
            {"name": "Area", "value": _clip(issue.get("area") or "-", 100), "inline": True},
            {"name": "Languages", "value": _clip(langs or "-", 1000), "inline": True},
        ],
    }


def daily(lines):
    return {
        "title": "📊 Daily player feedback",
        "url": DASHBOARD_URL,
        "description": _clip("\n".join(lines), 4000),
        "color": COLORS["daily"],
    }


def _iso(ts):
    if not ts:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))
