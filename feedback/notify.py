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
import steam

WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
# A Discord user or role to ping: "<@123>", "<@&456>", or a bare user ID.
MENTION = os.environ.get("DISCORD_MENTION", "").strip()
DASHBOARD_URL = "https://fourgames.se/fb-dash/"

COLORS = {"urgent": 0xE5484D, "flip": 0xF76B15, "cluster": 0xFFC53D, "still": 0xD6409F, "negative": 0xF76B15, "bug": 0xE5484D}


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


def check():
    """Looks the webhook up without posting anything (Discord answers a GET with its details), so the
    dashboard shows Discord as working before the first alert, and as broken if it's deleted."""
    if not WEBHOOK:
        status.fail("discord", "No DISCORD_WEBHOOK_URL secret is set, so alerts aren't sent.")
        return
    req = urllib.request.Request(WEBHOOK, headers={"User-Agent": "fourgames-feedback/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30):
            status.ok("discord")
    except urllib.error.HTTPError as error:
        if error.code in (401, 403, 404):
            status.fail("discord", f"The Discord webhook returned HTTP {error.code}; it may have been deleted.")
        else:
            print(f"[discord] webhook check: HTTP {error.code}")  # Discord hiccup: not the webhook's fault
    except urllib.error.URLError as error:
        print(f"[discord] webhook check failed: {type(error).__name__}")


def send(embeds, ping=False, note=None):
    """Posts up to 10 embeds in one message, with an optional line of text above them. Returns True
    when Discord accepted it (or no webhook is set)."""
    mention, allowed = _mention() if ping else ("", {"parse": []})
    embeds = [{k: v for k, v in e.items() if v is not None} for e in embeds[:10]]
    payload = {"username": "Player feedback", "embeds": embeds, "allowed_mentions": allowed}
    content = " ".join(part for part in (mention, note) if part)
    if content:
        payload["content"] = content
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
                status.active("discord", "sent an alert")
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
    """Language, purchase and hours (as on the review itself), then the game area from triage."""
    t = item.get("triage") or {}
    fields = []
    if t.get("language"):
        fields.append({"name": "Language", "value": _flag(t["language"]), "inline": True})
    if item["kind"] == "review":
        if "steamPurchase" in item:
            bought = "Free key" if item.get("receivedForFree") else "Yes" if item["steamPurchase"] else "No"
            fields.append({"name": "Steam purchase", "value": bought, "inline": True})
        hours = item.get("playtimeForever") or item.get("playtime") or 0
        at_review = item.get("playtime")
        value = f"{hours} h" + (f" ({at_review} h at review)" if at_review and at_review != hours else "")
        fields.append({"name": "Hours on record", "value": value, "inline": True})
    fields.append({"name": "Area", "value": _clip(t.get("area") or "-", 100), "inline": True})
    return fields


def _author(item):
    """The player's Steam name and picture, linked to their profile, like on Steam itself."""
    p = steam.profile((item.get("author") or {}).get("id"))
    if not p:
        name = (item.get("author") or {}).get("name")
        return {"name": name} if name else None
    return {"name": p["name"], "url": p["url"], "icon_url": p["avatar"]}


def _footer(game, item):
    kind = {"review": "Review", "topic": "Discussion thread", "reply": "Discussion reply"}[item["kind"]]
    return {"text": f"{kind} · {game['name']}"}


def urgent(game, item, issue):
    title = issue["title"] if issue else (item.get("triage") or {}).get("summary", "Urgent report")
    return {
        "title": _clip(f"🚨 Urgent · {game['name']}: {title}", 256),
        "url": item["url"],
        "description": _clip(f"> {_quote(item)}\n\n[Open the post]({item['url']}) · [Dashboard]({DASHBOARD_URL})", 4000),
        "color": COLORS["urgent"],
        "author": _author(item),
        "fields": _post_fields(item),
        "footer": _footer(game, item),
        "timestamp": _iso(item.get("created")),
    }


def new_post(game, item, negative, bugs):
    """A new negative review, or a new post reporting a bug (listing the bugs it reports)."""
    if negative:
        title = f"👎 New negative review · {game['name']}"
    else:
        title = f"🐛 New bug report · {game['name']}: {bugs[0]['text']}"
    lines = "".join(f"\n• {b['text']}" for b in bugs)
    return {
        "title": _clip(title, 256),
        "url": item["url"],
        "description": _clip(
            (f"**Bugs reported:**{lines}\n\n" if bugs and (negative or len(bugs) > 1) else "")
            + f"> {_quote(item)}\n\n[Open the post]({item['url']}) · [Dashboard]({DASHBOARD_URL})",
            4000,
        ),
        "color": COLORS["negative" if negative else "bug"],
        "author": _author(item),
        "fields": _post_fields(item),
        "footer": _footer(game, item),
        "timestamp": _iso(item.get("created")),
    }


def flip(game, item):
    return {
        "title": _clip(f"👎 Review flipped to negative · {game['name']}", 256),
        "url": item["url"],
        "description": _clip(f"> {_quote(item)}\n\n[Open the review]({item['url']}) · [Dashboard]({DASHBOARD_URL})", 4000),
        "color": COLORS["flip"],
        "author": _author(item),
        "fields": _post_fields(item),
        "footer": {"text": f"Flipped · {game['name']}"},
        "timestamp": _iso(((item.get("flips") or [{}])[-1]).get("at") or item.get("updated")),
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
        "footer": {"text": f"Latest report · {game['name']}"},
        "timestamp": _iso(items[0]["created"]) if items else None,
    }


def spike(game, posts, count, usual, release, top):
    """More negative reviews and bug reports than usual in the last 24 hours: how many, against a
    normal day, the update that went out just before, and what they're about."""
    negative = sum(1 for p in posts if p["kind"] == "review" and not p.get("votedUp"))
    lines = "\n".join(f"• {_clip(issue['title'], 120)} ({n} player{'s' if n != 1 else ''})" for issue, n in top)
    since = ""
    if release:
        label = f"v{release['version']}" if release.get("version") else release["name"]
        hours = max(1, round((time.time() - release["time"]) / 3600))
        since = f"[{_clip(label, 80)}]({release['url']}) went out {hours} h ago.\n\n"
    latest = sorted(posts, key=lambda p: p["created"], reverse=True)[:5]
    links = "\n".join(f"• [{_clip((p.get('triage') or {}).get('summary') or p['kind'], 90)}]({p['url']})" for p in latest)
    return {
        "title": _clip(f"📈 Spike · {game['name']}: {count} players unhappy in 24 h", 256),
        "url": DASHBOARD_URL,
        "description": _clip(
            since + (f"**What it's about:**\n{lines}\n\n" if lines else "") + f"**Latest:**\n{links}\n\n[Dashboard]({DASHBOARD_URL})", 4000),
        "color": COLORS["urgent"],
        "fields": [
            {"name": "Last 24 h", "value": str(count), "inline": True},
            {"name": "Usual day", "value": f"{usual:.1f}", "inline": True},
            {"name": "Negative reviews", "value": str(negative), "inline": True},
        ],
        "footer": {"text": f"Negative reviews and bug reports · {game['name']}"},
        "timestamp": _iso(latest[0]["created"]) if latest else None,
    }


MEDIA = {
    # source → (color, title)
    "twitch": (0x9146FF, "🔴 Live on Twitch"),
    "youtube": (0xFF0033, "▶️ New YouTube video"),
    "news": (0x3E63DD, "📰 New article"),
}


def _count(n):
    return f"{n:,}" if n is not None else None


def media(game, item):
    """Someone streaming, a video or an article about a game: who, how big, and a link
    straight to it (for a stream: the channel, to join the chat)."""
    color, title = MEDIA[item["source"]]
    if item["source"] == "youtube" and item.get("live"):
        title = "🔴 Live on YouTube"
    who = item.get("author") or "Someone"
    fields = []
    add = lambda name, value: fields.append({"name": name, "value": value, "inline": True}) if value else None
    if item["source"] == "twitch":
        add("Viewers", _count(item.get("viewers")))
        add("Followers", _count(item.get("followers")))
        add("Language", (item.get("lang") or "").upper() or None)
        link = f"[Watch and chat]({item['url']})"
    elif item["source"] == "youtube":
        add("Subscribers", _count(item.get("subscribers")))
        add("Views", _count(item.get("views")))
        if item.get("duration") and not item.get("live"):
            add("Length", f"{item['duration'] // 60}:{item['duration'] % 60:02d}")
        link = f"[Watch and comment]({item['url']})"
    else:
        link = f"[Read it]({item['url']})"
    quote = f"> {_clip(item['text'], 300)}\n" if item.get("text") and item["source"] != "youtube" else ""
    return {
        "title": _clip(f"{title} · {game['name']}: {who}", 256),
        "url": item["url"],
        "description": _clip(f"**{item.get('title') or ''}**\n{quote}\n{link} · [Dashboard]({DASHBOARD_URL})", 4000),
        "color": color,
        "author": {"name": who, "url": item["authorUrl"]} if item.get("authorUrl") else {"name": who},
        "image": {"url": item["thumb"]} if item.get("thumb") and item["source"] in ("twitch", "youtube") else None,
        "fields": fields or None,
        "footer": {"text": f"{game['name']}"},
        "timestamp": _iso(item.get("at")),
    }


CURATOR = {"recommended": (0x2A78D6, "Recommended"), "not_recommended": (0xE5484D, "Not recommended"), "informative": (0x8B8D98, "Informational")}


def curator(game, c):
    """A Steam curator who reviewed a game: who, how many follow them, and what they said."""
    color, verdict = CURATOR.get(c["state"], CURATOR["recommended"])
    links = [f"[Their review]({c['link']})" if c.get("link") else None, f"[Curator page]({c['url']})" if c.get("url") else None, f"[Dashboard]({DASHBOARD_URL})"]
    return {
        "title": _clip(f"Steam curator · {game['name']}: {verdict} by {c['name']}", 256),
        "url": c.get("url"),
        "description": _clip((f"> {_clip(c['blurb'], 600)}\n\n" if c.get("blurb") else "") + " · ".join(l for l in links if l), 4000),
        "color": color,
        "author": {"name": c["name"], "url": c["url"], "icon_url": c.get("avatar")} if c.get("url") else {"name": c["name"]},
        "fields": [{"name": "Followers", "value": _count(c.get("followers")), "inline": True}],
        "footer": {"text": game["name"]},
        "timestamp": _iso(c.get("time")),
    }


def _iso(ts):
    if not ts:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))
