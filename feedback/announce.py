"""Your own channels, announced in Discord (instead of Streamcord, which missed uploads): new YouTube
videos, YouTube live streams and Twitch streams, posted to the public announcements webhook
(DISCORD_RELEASES_WEBHOOK_URL) with a role ping. run.py calls check() every run, so a post lands
within about 5 minutes.

YouTube is read from the channel's public feed, which lists every new upload with no quota; the
Data API (1 unit per check) then tells a live stream or a scheduled one from a video. Shorts and
past live streams aren't posted. Twitch is asked whether the channel is live right now.

What was posted is kept in data/announced.json. Each platform's first check only records what's
already there, so turning this on never posts old videos or a stream already announced.
"""

import calendar
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

import media
import notify
import status

YOUTUBE_CHANNEL = "UCGf6yX8yYzo1FBzhmKhFduA"  # the same channel as src/data/site.js
TWITCH_LOGIN = "fourgamesab"
# The roles Streamcord pinged: "Ping Upload" for videos, "Ping Stream" for live streams.
VIDEO_ROLE = "1179540668998221875"
STREAM_ROLE = "1179540647280128132"
RECENT = 2 * 86400  # older videos in the feed are never posted (a video made public late, say)
KEEP = 200  # video ids remembered

NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}


def check(state):
    """Posts what's new since the last check and updates `state` (data/announced.json). Returns True
    when it changed."""
    before = repr(state)
    state.setdefault("youtube", {})
    state.setdefault("twitch", {})
    try:
        check_youtube(state["youtube"], not state["youtube"])
        status.ok("announce")
    except (media.HttpError, ET.ParseError) as error:
        print(f"[announce] YouTube: {error}")
        status.fail("announce", f"Couldn't read your YouTube channel ({error}).")
    if media.TWITCH_ID and media.TWITCH_SECRET:
        try:
            check_twitch(state["twitch"], not state["twitch"].get("checked"))
        except media.HttpError as error:
            print(f"[announce] Twitch: {error}")
            status.fail("announce", f"Couldn't check your Twitch channel ({error}).")
    return repr(state) != before


def check_youtube(seen, first):
    feed = ET.fromstring(media.request(f"https://www.youtube.com/feeds/videos.xml?channel_id={YOUTUBE_CHANNEL}", as_json=False))
    entries = {}
    for entry in feed.findall("a:entry", NS):
        published = entry.findtext("a:published", "", NS)
        entries[entry.findtext("yt:videoId", "", NS)] = {
            "title": entry.findtext("a:title", "", NS),
            "published": calendar.timegm(time.strptime(published[:19], "%Y-%m-%dT%H:%M:%S")) if published else 0,
        }
    if first:
        for video_id in entries:
            seen[video_id] = "old"
        return
    new = [v for v in entries if seen.get(v) not in ("posted", "live", "skipped", "old")]
    details = _details(new)
    for video_id in reversed(new):  # oldest first
        entry, info = entries[video_id], details.get(video_id) or {}
        kind = info.get("kind", "video")
        if kind == "upcoming":
            seen[video_id] = "upcoming"  # checked again each run until it starts
            continue
        if seen.get(video_id) == "live" or kind == "ended":
            seen[video_id] = "skipped"  # a past live stream: its live post went out, or it was missed
            continue
        if kind == "live":
            if _post(STREAM_ROLE, f"Four Games is live on YouTube: **{entry['title']}**\nhttps://www.youtube.com/watch?v={video_id}"):
                seen[video_id] = "live"
            continue
        # A premiere waited as "upcoming", so its age is from when it was scheduled: it still counts.
        old = seen.get(video_id) != "upcoming" and time.time() - entry["published"] > RECENT
        seconds = info.get("seconds")
        if old or (seconds is not None and seconds <= 180 and _is_short(video_id)):
            seen[video_id] = "skipped"
            continue
        if _post(VIDEO_ROLE, f"https://www.youtube.com/watch?v={video_id}"):
            seen[video_id] = "posted"
    # Forget the oldest ids, but never what's still in the feed.
    for video_id in list(seen)[: max(0, len(seen) - KEEP)]:
        if video_id not in entries:
            del seen[video_id]


def _details(ids):
    """{id: {"kind": "video" | "live" | "upcoming" | "ended", "seconds": length}} from the Data API, 1
    unit for up to 50.
    Without a key every new upload counts as a video. A premiere is a video: it's posted when it starts."""
    if not ids or not media.YOUTUBE_KEY:
        return {}
    out = {}
    res = media.youtube("videos", {"part": "snippet,contentDetails,liveStreamingDetails", "id": ",".join(ids[:50])})
    for item in res.get("items") or []:
        state = item["snippet"].get("liveBroadcastContent")  # "live", "upcoming" or "none"
        stream = item.get("liveStreamingDetails")
        premiere = stream and item["contentDetails"].get("duration") not in (None, "P0D")
        if state == "upcoming":
            kind = "upcoming"
        elif state == "live":
            kind = "video" if premiere else "live"
        elif stream and not premiere:
            kind = "ended"
        else:
            kind = "video"
        out[item["id"]] = {"kind": kind, "seconds": media._duration(item["contentDetails"].get("duration"))}
    # A video the API doesn't return yet (just published) waits for the next check.
    for video_id in ids:
        out.setdefault(video_id, {"kind": "upcoming"} if media.YOUTUBE_KEY else {"kind": "video"})
    return out


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _is_short(video_id):
    """YouTube serves a Short at /shorts/<id> and redirects any other video to /watch. Only asked for
    videos of 3 minutes or less (a Short's longest). When it can't be told, it's posted as a video
    (better one post too many than a missed one)."""
    req = urllib.request.Request(f"https://www.youtube.com/shorts/{video_id}", method="HEAD", headers={"User-Agent": media.USER_AGENT})
    try:
        with urllib.request.build_opener(_NoRedirect).open(req, timeout=15) as res:
            return res.status == 200
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        return False


def check_twitch(twitch, first):
    streams = media.twitch("streams", {"user_login": TWITCH_LOGIN}).get("data") or []
    stream = streams[0] if streams else None
    twitch["checked"] = True
    if not stream or stream["id"] == twitch.get("stream"):
        return
    if first:
        twitch["stream"] = stream["id"]
        return
    note = f"Four Games is live on Twitch: **{stream['title']}**\nhttps://www.twitch.tv/{TWITCH_LOGIN}"
    if _post(STREAM_ROLE, note):
        twitch["stream"] = stream["id"]


def _post(role, text):
    """Posts to the announcements webhook. The link unfurls into YouTube's or Twitch's own player.
    Without the webhook it's only printed (local runs), and counts as posted."""
    print(f"[announce] {text.splitlines()[-1]}")
    if not notify.RELEASES_WEBHOOK:
        return True
    allowed = {"parse": [], "roles": [role]}
    ok = notify.send([], note=f"<@&{role}>\n{text}", webhook=notify.RELEASES_WEBHOOK, username=None, mention=("", allowed))
    if ok:
        status.active("announce", "announced a video or stream")
    return ok
