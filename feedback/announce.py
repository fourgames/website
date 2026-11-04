"""Your own channels, announced in Discord (instead of Streamcord, which missed uploads): new YouTube
videos, YouTube live streams and Twitch streams, posted to the public announcements webhook
(DISCORD_RELEASES_WEBHOOK_URL) with a role ping, named and pictured as YouTube or Twitch. run.py
calls run() every run, so a post lands within about 5 minutes. On the server, server/alerts hears
from YouTube and Twitch the moment something's new and starts a check right away
(`announce.py --push`): the same check, under a lock shared with the loop's, so nothing is posted twice.

YouTube is read from the channel's public feed, which lists every new upload with no quota; the
Data API (1 unit per check) then tells a live stream or a scheduled one from a video. Shorts and
past live streams aren't posted. Twitch is asked whether the channel is live right now.

What was posted is kept in data/announced.json. Each platform's first check only records what's
already there, so turning this on never posts old videos or a stream already announced. A push-started
check saves to .cache/announced-pending.json instead (data/ is only changed by the loop's run, between
its pulls and commits), and the loop's next check carries it over into data/announced.json.
"""

import calendar
import fcntl
import json
import os
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from pathlib import Path

import media
import notify
import status

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("FEEDBACK_DATA_DIR") or HERE / "data")  # as in run.py
# One check at a time, the loop's or a push-started one: two at once could post the same video twice.
LOCK = HERE / ".cache" / "announce.lock"
# What push-started checks saved since the loop's last check (not committed; see run()).
PENDING = HERE / ".cache" / "announced-pending.json"

YOUTUBE_CHANNEL = "UCGf6yX8yYzo1FBzhmKhFduA"  # the same channel as src/data/site.js
TWITCH_LOGIN = "fourgamesab"
# The roles Streamcord pinged: "Ping Upload" for videos, "Ping Stream" for live streams.
VIDEO_ROLE = "1179540668998221875"
STREAM_ROLE = "1179540647280128132"
# Who each post comes from, so it shows where it's from: the name and picture (public/images/discord).
YOUTUBE = ("YouTube", "https://fourgames.se/images/discord/youtube.png")
TWITCH = ("Twitch", "https://fourgames.se/images/discord/twitch.png")
# Live on YouTube and Twitch at once: only the first post within this long pings, the other just adds its link.
SAME_STREAM = 15 * 60
RECENT = 2 * 86400  # older videos in the feed are never posted (a video made public late, say)
KEEP = 200  # video ids remembered

NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}


@contextmanager
def locked():
    """Holds LOCK, waiting while another check (the loop's or a push-started one) has it. The lock
    goes with the process, so a check that's stopped or crashes never leaves it held."""
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK, "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def run(path=None, push=False):
    """One check, under the lock, from the newest state: PENDING when a push-started check left one,
    else `path` (data/announced.json). The loop's check (push=False) saves to `path`, taking PENDING
    over, and returns True when `path` changed. A push-started one saves to PENDING only, so data/
    never changes between the loop's pull and its run, and returns True when it changed."""
    path = Path(path or DATA / "announced.json")
    with locked():
        state = _load(PENDING)
        pending = state is not None
        if not pending:
            state = _load(path) or {}
        changed = check(state)
        if push:
            return changed and _save(PENDING, state)
        if not pending:
            return changed and _save(path, state)
        # The newest state is always in one of the two files, even if this stops halfway.
        _save(PENDING, state)
        try:
            os.replace(PENDING, path)
        except OSError:  # data/ on another disk (FEEDBACK_DATA_DIR)
            _save(path, state)
            PENDING.unlink()
        return True


def _load(path):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return None


def _save(path, state):
    """run.py's save(): the same format, written whole then moved, and only when it changed."""
    path = Path(path)
    text = json.dumps(state, ensure_ascii=False, indent=1) + "\n"
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text)
    tmp.replace(path)
    return True


def check(state):
    """Posts what's new since the last check and updates `state` (data/announced.json). Returns True
    when it changed."""
    before = repr(state)
    state.setdefault("youtube", {})
    state.setdefault("twitch", {})
    try:
        check_youtube(state["youtube"], not state["youtube"], state)
        status.ok("announce")
    except (media.HttpError, ET.ParseError) as error:
        print(f"[announce] YouTube: {error}")
        status.fail("announce", f"Couldn't read your YouTube channel ({error}).")
    if media.TWITCH_ID and media.TWITCH_SECRET:
        try:
            check_twitch(state["twitch"], not state["twitch"].get("checked"), state)
        except media.HttpError as error:
            print(f"[announce] Twitch: {error}")
            status.fail("announce", f"Couldn't check your Twitch channel ({error}).")
    return repr(state) != before


def check_youtube(seen, first, state):
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
            if _live(state, YOUTUBE, entry["title"], f"https://www.youtube.com/watch?v={video_id}"):
                seen[video_id] = "live"
            continue
        # A premiere waited as "upcoming", so its age is from when it was scheduled: it still counts.
        old = seen.get(video_id) != "upcoming" and time.time() - entry["published"] > RECENT
        seconds = info.get("seconds")
        if old or (seconds is not None and seconds <= 180 and _is_short(video_id)):
            seen[video_id] = "skipped"
            continue
        if _post(YOUTUBE, VIDEO_ROLE, f"https://www.youtube.com/watch?v={video_id}"):
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


def check_twitch(twitch, first, state):
    streams = media.twitch("streams", {"user_login": TWITCH_LOGIN}).get("data") or []
    stream = streams[0] if streams else None
    twitch["checked"] = True
    if not stream or stream["id"] == twitch.get("stream"):
        return
    if first:
        twitch["stream"] = stream["id"]
        return
    if _live(state, TWITCH, stream["title"], f"https://www.twitch.tv/{TWITCH_LOGIN}"):
        twitch["stream"] = stream["id"]


def _live(state, sender, title, url):
    """A live stream's post. The first within SAME_STREAM pings; a second (the same stream on the other
    platform, whichever is seen second) says "Also live" and pings no one."""
    also = time.time() - state.get("streamPinged", 0) < SAME_STREAM
    text = f"{'Also live' if also else 'Four Games is live'} on {sender[0]}: **{title}**\n{url}"
    if not _post(sender, None if also else STREAM_ROLE, text):
        return False
    if not also:
        state["streamPinged"] = int(time.time())
    return True


def _post(sender, role, text):
    """Posts to the announcements webhook as `sender` (name, picture), pinging `role` unless it's None.
    The link unfurls into YouTube's or Twitch's own player. Without the webhook it's only printed
    (local runs), and counts as posted."""
    print(f"[announce] {'(no ping) ' if not role else ''}{text}")
    if not notify.RELEASES_WEBHOOK:
        return True
    allowed = {"parse": [], "roles": [role]} if role else {"parse": []}
    note = f"<@&{role}>\n{text}" if role else text
    ok = notify.send([], note=note, webhook=notify.RELEASES_WEBHOOK,
                     username=sender[0], avatar=sender[1], mention=("", allowed))
    if ok:
        status.active("announce", "announced a video or stream")
    return ok


if __name__ == "__main__":
    # python feedback/announce.py --push: one check now, started by server/alerts when YouTube or
    # Twitch says something's new. Same environment as the loop (/etc/fourgames/feedback.env).
    import sys

    if sys.argv[1:] != ["--push"]:
        sys.exit("usage: python feedback/announce.py --push")
    print(f"[announce] push-started check: {'saved' if run(push=True) else 'nothing new'}")
