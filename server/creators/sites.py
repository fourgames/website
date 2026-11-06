"""Finds creators' emails by following the links they post: Linktree and other link-in-bio pages,
and their own websites (plus that site's contact page). No captcha, nothing signed in, from the server.

Links come from the channel description (read with the YouTube API) and from the About panel's link
list (read by the creator-emails Chrome skill, which saves them with `python -m creators.reveal save`).
Big platforms (YouTube, Twitch, X, Instagram, Discord, shops, tip jars...) are skipped: their pages
don't show a creator's email without signing in. Only channels without an email yet, best first.

  python -m creators.sites [N]      follow up to N new links now (the hourly run does 150)
"""

from __future__ import annotations

import gzip
import html
import http.client
import json
import logging
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from typing import Callable

from . import contacts
from .config import USER_AGENT, Config, ConfigError
from .db import Store
from .games import own_appids
from .reveal import _order

log = logging.getLogger("creators.sites")

REFETCH_DAYS = 90
MAX_BYTES = 2_000_000
# Pages that never show a creator's email to a visitor who isn't signed in.
SKIP_HOSTS = (
    "youtube.com", "youtu.be", "twitch.tv", "twitter.com", "x.com", "instagram.com", "tiktok.com",
    "facebook.com", "fb.com", "fb.gg", "discord.gg", "discord.com", "patreon.com", "ko-fi.com", "throne.com",
    "streamlabs.com", "streamelements.com", "amazon.", "amzn.", "a.co", "steampowered.com",
    "steamcommunity.com", "spotify.com", "apple.com", "google.com", "goo.gl", "reddit.com", "paypal.",
    "cash.app", "linkedin.com", "threads.net", "bsky.app", "kick.com", "rumble.com", "snapchat.com",
    "pinterest.", "tumblr.com", "vk.com", "t.me", "telegram.", "whatsapp.com", "wa.me", "teespring.com",
    "spreadshirt.", "redbubble.com", "fourthwall.com", "streamlabs.", "nvidia.com", "epidemicsound.com",
    "humblebundle.com", "g2a.com", "kinguin.net", "instant-gaming.com", "eneba.com", "gamivo.com",
    "nordvpn.com", "raidshadowlegends.com", "plarium.com", "gamesplanet.com", "fanatical.com", "gog.com",
    "epicgames.com", "playstation.com", "xbox.com", "nintendo.", "roblox.com", "github.com",
    "soundcloud.com", "bandcamp.com", "twitchtracker.com", "streamable.com", "imgur.com",
    "buymeacoffee.com", "subscribestar.", "boosty.to", "donationalerts.com", "tipeeestream.com",
    "streamloots.com", "gofundme.com", "bit.ly/m/", "creativecommons.org", "wikipedia.org", "ign.com",
    "rutube.ru", "vkvideo.ru", "vkplay.live", "donatepay.ru", "dzen.ru", "ok.ru", "mail.ru", "yandex.",
    "bilibili.com", "nicovideo.jp", "afreecatv.com", "trovo.live", "dlive.tv", "itch.io", "gamejolt.com",
    "medium.com", "substack.com", "wordpress.com", "blogspot.com", "ytmusic", "music.apple.com",
    "deezer.com", "tidal.com", "audiomack.com", "gamersupps.gg", "razer.com", "logitech", "corsair.com",
    "hyperx.com", "secretlab.co", "elgato.com", "gfuel.com", "manscaped.com", "displate.com",
    "skillshare.com", "audible.", "curiositystream.com", "nebula.tv", "opera.com", "honey.com",
    "ground.news", "brilliant.org", "squarespace.com", "wix.com", "shopify.com", "etsy.com", "ebay.",
    "aliexpress.", "temu.com", "booking.com", "expressvpn.com", "surfshark.com", "privateinternetaccess.com",
)
# A page with more emails than this is a company or platform page, not one creator's.
MAX_PAGE_EMAILS = 4
# Emails that belong to the page's host or a web tool, not the creator.
SKIP_EMAIL_DOMAINS = {"wixpress.com", "sentry.wixpress.com", "sentry-next.wixpress.com", "squarespace.com",
                      "godaddy.com", "shopify.com", "carrd.co", "linktr.ee", "linktree.com", "beacons.ai",
                      "mysite.com", "yourdomain.com", "company.com", "gmail.co", "test.com", "site.com"}
SKIP_LOCAL = {"your", "youremail", "yourname", "email", "name", "user", "username", "privacy", "abuse",
              "dmca", "legal", "postmaster", "webmaster", "hostmaster", "copyright"}
_CONTACT_LINK = re.compile(r"""href=["']([^"'#]*(?:contact|kontakt|impressum|about|business|collab)[^"'#]*)["']""",
                           re.IGNORECASE)
_MAILTO = re.compile(r"mailto:([^\"'?<>\s]+)", re.IGNORECASE)

# transport(url, headers, timeout) -> (status, headers, body, final url). The tests pass a fake one.
Transport = Callable[[str, dict, float], tuple[int, dict, bytes, str]]


def urllib_transport(url: str, headers: dict, timeout: float) -> tuple[int, dict, bytes, str]:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as res:
            return (res.status, {k.lower(): v for k, v in res.headers.items()}, res.read(MAX_BYTES + 1),
                    res.geturl())
    except urllib.error.HTTPError as error:
        with error:
            return error.code, {}, b"", url


def host(url: str) -> str:
    h = urllib.parse.urlsplit(url).netloc.lower().split("@")[-1].split(":")[0]
    return h[4:] if h.startswith("www.") else h


def followable(url: str) -> bool:
    """False for big platforms (SKIP_HOSTS: "x.com" is that host and its subdomains, "amazon." any
    amazon.<tld>, "bit.ly/m/" a path) and for anything that isn't a web address."""
    if not url.lower().startswith(("http://", "https://")):
        return False
    h = host(url)
    if not h or "." not in h or h.endswith(".edu"):
        return False
    whole = h + urllib.parse.urlsplit(url).path.lower()
    for s in SKIP_HOSTS:
        if "/" in s:
            if whole.startswith(s):
                return False
        elif s.endswith("."):
            if h.startswith(s) or "." + s in "." + h:
                return False
        elif h == s or h.endswith("." + s):
            return False
    return True


def page_emails(text: str, page_host: str) -> list[str]:
    text = html.unescape(text)
    found = [urllib.parse.unquote(m) for m in _MAILTO.findall(text)]
    found = contacts.emails(" ".join(found) + " " + re.sub(r"<[^>]+>", " ", text))
    out = []
    for email in found:
        local, _, domain = email.partition("@")
        if (domain in SKIP_EMAIL_DOMAINS or domain.endswith(".wixpress.com") or local in SKIP_LOCAL
                or domain.startswith("test.") or domain.endswith(".edu")
                or (domain == page_host and page_host.endswith(contacts.BIO_HOSTS))):
            continue
        out.append(email)
    return out


class Follower:
    def __init__(self, store: Store, transport: Transport | None = None, pause: float = 1.0):
        self.store = store
        self.transport = transport or urllib_transport
        self.pause = pause

    def _get(self, url: str) -> tuple[str | None, str, str]:
        """(page text or None, status, final url)."""
        headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml",
                   "Accept-Encoding": "gzip, deflate", "Accept-Language": "en"}
        try:
            status, res_headers, body, final = self.transport(url, headers, 15)
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as error:
            return None, f"error: {type(error).__name__}", url
        if status != 200:
            return None, f"http {status}", final
        if len(body) > MAX_BYTES:
            return None, "too big", final
        kind = res_headers.get("content-type", "text/html").lower()
        if "html" not in kind and "text" not in kind:
            return None, "not a page", final
        try:
            encoding = res_headers.get("content-encoding", "").lower()
            if encoding == "gzip":
                body = gzip.decompress(body)
            elif encoding == "deflate":
                body = zlib.decompress(body)
        except (OSError, EOFError, zlib.error):
            return None, "broken encoding", final
        charset = re.search(r"charset=([\w-]+)", kind)
        try:
            return body.decode(charset.group(1) if charset else "utf-8", errors="replace"), "ok", final
        except LookupError:
            return body.decode("utf-8", errors="replace"), "ok", final

    def visit(self, url: str) -> tuple[str, list[str]]:
        if not followable(url):
            return "skipped", []
        text, status, final = self._get(url)
        if text is None:
            return status, []
        if not followable(final):  # a short link that led to a big platform
            return "skipped", []
        page_host = host(final)
        emails = page_emails(text, page_host)
        if not emails and not page_host.endswith(contacts.BIO_HOSTS):
            # Their own site: look on its contact or about page too (at most two, same site).
            seen = {final}
            for link in _CONTACT_LINK.findall(text):
                link = urllib.parse.urljoin(final, html.unescape(link))
                if host(link) != page_host or link in seen or len(seen) > 2:
                    continue
                seen.add(link)
                time.sleep(self.pause)
                more, _, _ = self._get(link)
                if more:
                    emails = page_emails(more, page_host)
                    if emails and len(emails) <= MAX_PAGE_EMAILS:
                        break
        if len(emails) > MAX_PAGE_EMAILS:
            return "ok", []
        return "ok", emails

    def sync_description_links(self) -> int:
        """Adds the web addresses in every channel's description to channel_links."""
        added = 0
        with self.store.db:
            for channel_id, description in self.store.db.execute(
                    "SELECT channel_id, description FROM youtube_channels WHERE gone = 0 AND description LIKE '%.%'"):
                for url in contacts.urls(description):
                    added += self.store.db.execute(
                        "INSERT OR IGNORE INTO channel_links (channel_id, url, source) VALUES (?, ?, 'description')",
                        (channel_id, url)).rowcount
        return added

    def due(self, own: set[int], now: float, limit: int) -> list[str]:
        """Links not followed yet (or long ago) of channels without an email, best channels first."""
        sql, order, a, b = _order(own, now)
        rows = self.store.db.execute(
            f"""SELECT l.url {sql.replace('FROM youtube_channels c', 'FROM youtube_channels c JOIN channel_links l ON l.channel_id = c.channel_id')}
                AND l.url NOT IN (SELECT url FROM sites WHERE fetched_at >= ?)
                AND c.channel_id NOT IN (SELECT channel_id FROM site_emails)
                {order}""", (*a, now - REFETCH_DAYS * 86400, *b))
        seen: list[str] = []
        for (url,) in rows:
            if url not in seen:
                seen.append(url)
                if len(seen) >= limit:
                    break
        return seen

    def run(self, own: set[int], limit: int = 150, now: float | None = None) -> dict[str, int]:
        added = self.sync_description_links()
        counts = {"links added": added, "followed": 0, "skipped": 0, "failed": 0, "with email": 0}
        for url in self.due(own, now or time.time(), limit):
            status, emails = self.visit(url)
            with self.store.db:
                self.store.db.execute(
                    """INSERT INTO sites (url, fetched_at, status, emails) VALUES (?, ?, ?, ?)
                       ON CONFLICT(url) DO UPDATE SET fetched_at = excluded.fetched_at, status = excluded.status,
                                                      emails = excluded.emails""",
                    (url, int(time.time()), status, json.dumps(emails)))
            key = "skipped" if status == "skipped" else "followed" if status == "ok" else "failed"
            counts[key] += 1
            counts["with email"] += bool(emails)
            if status != "skipped":
                time.sleep(self.pause)
        log.info("links: %s", ", ".join(f"{k} {v}" for k, v in counts.items()))
        return counts


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    try:
        config = Config.from_env()
    except ConfigError as error:
        print(f"creators: {error}", file=sys.stderr)
        return 2
    logging.basicConfig(level=config.log_level, format="%(levelname)s %(name)s: %(message)s")
    store = Store(config.db_path)
    try:
        counts = Follower(store).run(own_appids(config.steam_db, config.own_appids, config.own_studio),
                                     int(argv[0]) if argv else 150)
        print(", ".join(f"{k}: {v}" for k, v in counts.items()))
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
