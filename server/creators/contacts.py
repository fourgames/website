"""Finds email addresses and other channels' links in a channel description.

Creators write their business email in many ways: plain, "name [at] gmail [dot] com", "name(at)x.com".
Only those forms are undone; a bare "name at gmail dot com" is too, as long as "dot" is there.
"""

from __future__ import annotations

import re

EMAIL = re.compile(r"(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![\w-])")
_AT = re.compile(r"\s*[\[\(\{<]\s*(?:at|@)\s*[\]\)\}>]\s*", re.IGNORECASE)
_DOT = re.compile(r"\s*[\[\(\{<]\s*(?:dot|\.)\s*[\]\)\}>]\s*", re.IGNORECASE)
_WORDS = re.compile(r"\b([A-Za-z0-9._%+-]+)\s+at\s+([A-Za-z0-9-]+)\s+dot\s+([A-Za-z]{2,24})\b", re.IGNORECASE)
# Not real contact addresses: file names like icon@2x.png, and placeholders.
_FILE_ENDINGS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg")
_SKIP_DOMAINS = {"example.com", "email.com", "domain.com", "sentry.io"}
_SKIP_LOCAL = {"noreply", "no-reply", "donotreply"}

LINKS = {
    "twitch": re.compile(r"twitch\.tv/([A-Za-z0-9_]{3,25})", re.IGNORECASE),
    "x": re.compile(r"(?:twitter|x)\.com/([A-Za-z0-9_]{1,15})", re.IGNORECASE),
    "instagram": re.compile(r"instagram\.com/([A-Za-z0-9_.]{1,30})", re.IGNORECASE),
    "tiktok": re.compile(r"tiktok\.com/@([A-Za-z0-9_.]{2,24})", re.IGNORECASE),
    "youtube": re.compile(r"youtube\.com/(@[A-Za-z0-9_.-]{3,30}|channel/UC[A-Za-z0-9_-]{22})", re.IGNORECASE),
    "discord": re.compile(r"(?:discord\.gg|discord\.com/invite)/([A-Za-z0-9-]{2,32})", re.IGNORECASE),
}
# Web addresses in a description: with http(s)://, or a bare address on a link-in-bio host.
_URL = re.compile(r"https?://[^\s<>\"'()\[\]]+", re.IGNORECASE)
BIO_HOSTS = ("linktr.ee", "beacons.ai", "carrd.co", "solo.to", "bio.link", "lnk.bio", "allmylinks.com",
             "campsite.bio", "linkin.bio", "msha.ke", "taplink.cc", "flow.page", "hoo.be", "snipfeed.co",
             "bento.me", "withkoji.com", "direct.me", "stan.store", "linkbio.co", "about.me", "linkr.bio")
_BARE = re.compile(r"(?<![\w./])((?:www\.)?(?:" + "|".join(re.escape(h) for h in BIO_HOSTS)
                   + r")/[^\s<>\"'()\[\]]+)", re.IGNORECASE)
_NOT_HANDLES = {"intent", "share", "home", "hashtag", "i", "p", "reel", "explore", "videos", "directory"}


def emails(text: str | None) -> list[str]:
    if not text:
        return []
    text = _WORDS.sub(r"\1@\2.\3", _DOT.sub(".", _AT.sub("@", text)))
    found: list[str] = []
    for match in EMAIL.findall(text):
        address = match.strip(".").lower()
        local, _, domain = address.partition("@")
        if address.endswith(_FILE_ENDINGS) or domain in _SKIP_DOMAINS or local in _SKIP_LOCAL:
            continue
        if address not in found:
            found.append(address)
    return found


def links(text: str | None) -> dict[str, str]:
    """The first handle found per platform, e.g. {"twitch": "somestreamer"}."""
    out: dict[str, str] = {}
    for platform, pattern in LINKS.items():
        for handle in pattern.findall(text or ""):
            if handle.lower() not in _NOT_HANDLES:
                out[platform] = handle
                break
    return out


def urls(text: str | None) -> list[str]:
    """Every web address in the text, https:// added where missing, trailing punctuation dropped."""
    found: list[str] = []
    for url in [*_URL.findall(text or ""), *("https://" + u for u in _BARE.findall(text or ""))]:
        url = url.rstrip(".,;:!?*")
        if url not in found:
            found.append(url)
    return found
