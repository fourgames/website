#!/usr/bin/env python3
"""Player feedback collector, run by .github/workflows/feedback.yml.

    python feedback/run.py                  full run: fetch, triage, alert, write feedback/data/
    python feedback/run.py --test-discord   send one example of each Discord alert

loop.sh runs it every 5 minutes. A run with nothing new only reads from Steam.

Env (GitHub secrets): STEAM_PUBLISHER_KEY, ANTHROPIC_API_KEY, DISCORD_WEBHOOK_URL, DISCORD_MENTION.
None of them is ever written to feedback/data/. FEEDBACK_DRY_RUN=1 skips Claude (local testing).
"""

import argparse
import calendar
import hashlib
import json
import math
import os
import re
import sys
import time
from pathlib import Path

import status
import steam

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("FEEDBACK_DATA_DIR") or HERE / "data")  # override for local test runs
SCHEMA_VERSION = 1

MAX_TRIAGE_PER_RUN = 400  # bounds the first backfill; the rest is picked up next run
RESEARCH_TRIAGE_PER_RUN = 150  # the same for each research game, on its own budget
RESEARCH_CAP = 40.0  # dollars of Claude per research game; sorting stops there
CLUSTER_LEVELS = [3, 5, 10, 25, 50, 100, 250, 500]
URGENCY = ["low", "medium", "high", "urgent"]
DAY = 86400
YOUTUBE_KINDS = ("video", "comment")  # posts from YouTube (no Steam profile, no reply on Steam)
# Posts you can't answer on Steam and that have no Steam profile: YouTube's, and notes players left
# when refunding (they're anonymous).
OFFSITE_KINDS = (*YOUTUBE_KINDS, "refund")
# Games whose posts are all sorted again this run (app ids, or "all"); see resort().
RESORT = set(filter(None, re.split(r"[\s,]+", os.environ.get("FEEDBACK_RESORT", ""))))


def now():
    return int(time.time())


def load(path, default):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return default


def save(path, data):
    """Writes only when the content changed, so an idle run leaves nothing to commit."""
    path = Path(path)
    text = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text)
    tmp.replace(path)
    return True


# The research games' summaries, kept apart from index.json: their own workflow writes them.
RESEARCH_INDEX = DATA / "research-index.json"


def game_path(app_id):
    return DATA / "games" / f"{app_id}.json"


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------


def new_state(game):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "appId": game["appId"],
        "initialized": False,
        "watermarks": {},
        "items": {},
        "issues": {},
        "nextIssue": 1,
        "players": [],
        "reviewTotals": {},
        "releases": [],
    }


def ingest_reviews(state, game, run):
    """New and edited reviews, newest first, down to the last one we've seen. Hourly, every review
    instead: your reply on Steam doesn't change a review's updated time, so only a full read sees it
    (and when you sent it, for the dashboard's reply results)."""
    import media

    app_id = game["appId"]
    # A research game has no replies of yours to find, so it never needs the full read.
    full = not game.get("research") and media._due("reviews-full", app_id, 3600)
    watermark = 0 if full else state["watermarks"].get("reviews", 0)
    newest = watermark
    for page, (res, reviews) in enumerate(steam.review_pages(app_id, public=game.get("research"))):
        summary = res.get("query_summary") or {}
        if page == 0 and summary.get("total_reviews") is not None:
            state["reviewTotals"][time.strftime("%Y-%m-%d", time.gmtime())] = {
                "positive": summary.get("total_positive", 0),
                "negative": summary.get("total_negative", 0),
                "desc": summary.get("review_score_desc"),
                "score": summary.get("review_score"),  # Steam's 0-9 rating behind the wording
            }
        reached_old = False
        for r in reviews:
            ts = int(r.get("timestamp_updated") or r.get("timestamp_created") or 0)
            if ts < watermark:
                reached_old = True
                continue
            upsert_review(state, game, r, run)
            newest = max(newest, ts)
        if reached_old or page >= 200:
            break
    state["watermarks"]["reviews"] = max(newest, state["watermarks"].get("reviews", 0))
    if full:
        media._ran("reviews-full", app_id)


def review_extras(r):
    """The rest of what Steam says about a review and its author: whether they still play, Steam Deck,
    how helpful and funny other players found it, replies under it, and a refund. Refreshed on every
    read, since these change after the review is written."""
    author = r.get("author") or {}
    hours = lambda minutes: round((minutes or 0) / 60, 1)
    extras = {
        "playtimeRecent": hours(author.get("playtime_last_two_weeks")),  # last two weeks
        "lastPlayed": author.get("last_played") or None,
        "deck": bool(r.get("primarily_steam_deck")),
        "deckPlaytime": hours(author.get("deck_playtime_at_review")),
        "votesFunny": r.get("votes_funny", 0),
        "helpfulness": round(float(r.get("weighted_vote_score") or 0), 3),  # Steam's 0-1 helpful rank
        "comments": r.get("comment_count", 0),
    }
    if "refunded" in r:
        extras["refunded"] = bool(r["refunded"])
    return extras


def upsert_review(state, game, r, run):
    rid = f"r{r['recommendationid']}"
    author = r.get("author") or {}
    text = (r.get("review") or "").strip()
    voted_up = bool(r.get("voted_up"))
    updated = int(r.get("timestamp_updated") or r.get("timestamp_created") or 0)
    minutes = author.get("playtime_at_review") or author.get("playtime_forever") or 0
    item = state["items"].get(rid)
    if item is None:
        state["items"][rid] = {
            "id": rid,
            "kind": "review",
            "url": f"https://steamcommunity.com/profiles/{author.get('steamid')}/recommended/{game['appId']}/",
            "author": {"id": author.get("steamid"), "reviews": author.get("num_reviews")},
            "lang": r.get("language"),
            "created": int(r.get("timestamp_created") or updated),
            "updated": updated,
            "text": text,
            "votedUp": voted_up,
            "playtime": round(minutes / 60, 1),  # at the time of the review
            "playtimeForever": round((author.get("playtime_forever") or 0) / 60, 1),
            "steamPurchase": bool(r.get("steam_purchase")),
            "receivedForFree": bool(r.get("received_for_free")),
            "earlyAccess": bool(r.get("written_during_early_access")),
            "votesUp": r.get("votes_up", 0),
            "devResponse": r.get("developer_response") or None,
            "devRespondedAt": r.get("timestamp_dev_responded") or None,
            **review_extras(r),
            "versions": [],
            "flips": [],
            "pending": True,
        }
        run["new"].append(rid)
        status.active("steam", "new review")
        return
    item["votesUp"] = r.get("votes_up", 0)
    item.update(review_extras(r))
    item["author"]["reviews"] = author.get("num_reviews")
    item["playtimeForever"] = round((author.get("playtime_forever") or 0) / 60, 1)
    item["steamPurchase"] = bool(r.get("steam_purchase"))
    item["receivedForFree"] = bool(r.get("received_for_free"))
    item["devResponse"] = r.get("developer_response") or None
    item["devRespondedAt"] = (r.get("timestamp_dev_responded") or None) if item["devResponse"] else None
    if text == item["text"] and voted_up == item["votedUp"]:
        item["updated"] = max(item["updated"], updated)
        return
    # An edit: keep the old wording, so nothing a player wrote is ever lost.
    item["versions"].append({"at": item["updated"], "text": item["text"], "votedUp": item["votedUp"]})
    if voted_up != item["votedUp"]:
        item["flips"].append({"at": updated, "to": "positive" if voted_up else "negative"})
        if not voted_up:
            run["flips"].append(rid)
    item.update(text=text, votedUp=voted_up, updated=updated, edited=True, pending=True)
    run["edited"].append(rid)
    status.active("steam", "review edited")


def record_discount(state, game):
    """Steam has no history of a game's sales, but its store shows the current discount: keep it, as
    [time, percent] changes, so the dashboard can shade sale periods from now on."""
    discount = game.get("discount")
    if discount is None:
        return
    series = state.setdefault("discounts", [])
    if not series or series[-1][1] != discount:
        series.append([now(), discount])


def record_players(state, game, app_id=None, key="players"):
    """The game's player count, or (with app_id and key) its demo's in state["demoPlayers"]."""
    try:
        count = steam.player_count(app_id or game["appId"])
        series = state.get(key) or []
        # Steam now and then answers 0 for every game at once. A research game is only read every few
        # hours, so a false 0 would stick: a drop to 0 from 10 or more is read again before it's kept.
        if count == 0 and series and series[-1][1] >= 10:
            time.sleep(5)
            count = steam.player_count(app_id or game["appId"])
            if count == 0:
                print(f"[steam] {game['name']} {key}: 0 twice after {series[-1][1]}, skipped")
                return
    except steam.HttpError as error:
        print(f"[steam] {game['name']} {key}: {error}")
        status.fail("steam", f"Couldn't read the player count ({error}).")
        return
    if count is None:
        return
    series = state.setdefault(key, [])
    # Store changes only: the dashboard draws it as a step line, and an unchanged count isn't a commit.
    if not series or series[-1][1] != count:
        series.append([now(), count])
        status.active("steam", "players changed")


# ---------------------------------------------------------------------------
# Triage and issues
# ---------------------------------------------------------------------------


def issue_digest(issues, state=None):
    """What Claude sees of each issue, to merge duplicates and match patch notes: its title, any fix it
    likely got, and (with the state) what players actually said about it."""
    def said(issue):
        if not state:
            return []
        lines = [pt["text"] for item_id in issue.get("items", []) for pt in ((state["items"].get(item_id) or {}).get("triage") or {}).get("points") or []
                 if pt.get("issue") == issue["id"]]
        return list(dict.fromkeys(lines))[:5]
    return [
        {"id": i["id"], "kind": i["kind"], "title": i["title"], "area": i["area"], "mentions": i.get("mentions", 1),
         "summary": i.get("summary"), "details": "; ".join(i.get("details", [])[:3]), "said": said(i),
         "fixedIn": i.get("fixedIn") if i.get("status") == "likely_fixed" else None, "fixReason": i.get("fixReason")}
        for i in issues
    ]


def open_issues(state):
    """Every issue a new post could repeat, likely-fixed ones included (that's how "still happening" is found)."""
    return issue_digest(sorted(state["issues"].values(), key=lambda i: i.get("lastSeen", 0), reverse=True)[:150], state)


def thread_context(state, item):
    """For a reply: the thread it's in, and the issue its opening post was merged into."""
    if item["kind"] != "reply":
        return None
    op = state["items"].get(item.get("topic"))
    if not op:
        return None
    ctx = f"Thread: \"{op.get('title', '')}\""
    if op.get("issues"):
        ctx += f" (its opening post is in issues {', '.join(op['issues'])})"
    return ctx


PROFILE_REFRESH = 30 * DAY  # a player's public profile is read again this often
PROFILES_PER_RUN = 100  # lookups a run, so a backlog doesn't hold one up


def add_profiles(state):
    """The player's Steam name, picture and profile link for each post (from their public profile),
    so the dashboard can show who wrote it, and `about`: where they're from, how long they've been
    on Steam, limited or banned, their recent hours and most played games (steam.profile). Read
    again every 30 days, at most PROFILES_PER_RUN a run."""
    looked_up = {}
    for item in state["items"].values():
        author = item.get("author") or {}
        if not author.get("id") or item["kind"] in OFFSITE_KINDS:
            continue
        due = "profile" not in author or now() - author.get("aboutAt", 0) >= PROFILE_REFRESH
        if due and (author["id"] in looked_up or len(looked_up) < PROFILES_PER_RUN):
            if author["id"] not in looked_up:
                looked_up[author["id"]] = steam.profile(author["id"])
            profile = looked_up[author["id"]]
            author["profile"] = profile["url"] if profile else author.get("profile")
            author["aboutAt"] = now()
            if profile:
                author.update(name=profile["name"], avatar=profile["avatar"], about=profile.get("about") or None)
        # The size of their library too, like Steam shows on a review.
        if "games" not in author:
            if ("games", author["id"]) not in looked_up:
                looked_up[("games", author["id"])] = steam.games_owned(author["id"])
            author["games"] = looked_up[("games", author["id"])]
        item["author"] = author


def translate_own(state, budget):
    """Your own posts and replies aren't triaged (they're not feedback), but they get an English
    translation and their language like everyone else's. Done again if you edit them."""
    import triage

    for item in state["items"].values():
        jobs = []
        if item.get("dev") and not (item["kind"] == "topic" and item.get("forum") == "Events & Announcements"):
            jobs.append(("text", item.get("text") or ""))
        if item.get("devResponse"):
            jobs.append(("devResponse", item["devResponse"]))
        for field, text in jobs:
            key = hashlib.sha1(text.encode()).hexdigest()[:12]
            done = item.get("translatedOwn") or {}
            if not text.strip() or done.get(field) == key or budget["left"] <= 0:
                continue
            try:
                result = triage.translate(text)
            except Exception as error:  # noqa: BLE001 - try again next run
                print(f"[translate] {item['id']}: {type(error).__name__}: {error}")
                status.fail("claude", f"{triage.describe_error(error)[0]} Your own posts wait to be translated.")
                return
            status.active("claude", "translated your post")
            budget["left"] -= 1
            english = result.english.strip()
            if field == "text":
                item["triage"] = {"language": result.language, "english": english}
            else:
                item["devResponseLanguage"] = result.language
                item["devResponseEnglish"] = english or None
            item["translatedOwn"] = {**done, field: key}


VIDEOS_PER_RUN = 10  # per game; the rest wait for the next run
VIDEO_RETRY = 6 * 3600  # a video that failed is tried again this much later (an hour later the first time)
VIDEO_TRIES = 8
VIDEO_SECONDS_PER_RUN = 300
VIDEO_MAC_WAIT = 36 * 3600  # how long a new video waits for its captions from your Mac before Gemini writes them
VIDEO_MIN_WORDS = 30  # less talking than this (music, game sound) isn't worth a review


def review_videos(state, game, budget):
    """Claude reviews each YouTube video about the game from its transcript, so you don't have to watch
    it: a summary, how the creator felt, and the bugs, complaints, suggestions, questions and praise in
    it, each with the moment it's said (item["review"]). Once per video, newest first; your own aren't."""
    import media
    import triage

    items = (state.get("media") or {}).get("items") or {}
    # The status says whether transcripts work now: a failure shows only while one happens this run,
    # not until some other video happens to succeed.
    if any(i["source"] == "youtube" for i in items.values()):
        status.ok("transcripts")
    for video in items.values():
        if video.get("review"):
            video_post(state, video)
    # Video posts sorted before their points kept times are sorted once more, to link each moment.
    for post in state["items"].values():
        if post["kind"] == "video" and post.get("triage") and not post.get("timed"):
            post.update(pending=True, timed=True)
    # A video whose captions your Mac saved goes straight away, whatever failed before.
    saved = lambda i: (DATA / "transcripts" / f"{i['id'][2:]}.json").exists()
    todo = sorted((i for i in items.values() if i["source"] == "youtube" and "review" not in i and not i.get("own")
                   and not i.get("live") and not i.get("upcoming") and (saved(i) or (i.get("reviewTries", 0) < VIDEO_TRIES
                   and now() - i.get("reviewTried", 0) >= (3600 if i.get("reviewTries", 0) < 2 else VIDEO_RETRY)))), key=lambda i: -i["at"])
    started = time.time()
    for item in todo[:VIDEOS_PER_RUN]:
        # Gemini takes a while per video; the rest wait, so the run's other work isn't held up.
        if budget["left"] <= 0 or time.time() - started > VIDEO_SECONDS_PER_RUN:
            return
        # The video's own captions, saved by the scheduled task on your Mac (transcripts_fetch.py);
        # Gemini only for a video it hasn't covered after a day and a half (your Mac was off, or no captions).
        stored = DATA / "transcripts" / f"{item['id'][2:]}.json"
        if not stored.exists() and media.GEMINI_KEY and now() - item["at"] < VIDEO_MAC_WAIT:
            continue
        try:
            lines = [tuple(x) for x in load(stored, {}).get("lines") or []] if stored.exists() else \
                media.transcript(item["id"][2:], item.get("lang"), item.get("duration"))
        except media.TranscriptBlocked as error:
            print(f"[video] {item['id']}: {error}")
            status.fail("transcripts", "Gemini's free 8 hours of video a day are used up; the rest wait for tomorrow." if media.GEMINI_KEY
                        else "YouTube blocks reading transcripts from GitHub's servers: add the GEMINI_API_KEY secret (see feedback/README.md).")
            return
        except media.TranscriptBusy as error:
            # Not the video's fault, nor a failure: it's simply tried again next run.
            print(f"[video] {item['id']}: {error}; trying again next run")
            return
        except media.NoTranscript:
            item["reviewTries"] = item.get("reviewTries", 0) + 1
            item["reviewTried"] = now()
            continue
        except Exception as error:  # noqa: BLE001 - try again next run
            print(f"[video] {item['id']}: {type(error).__name__}: {error}")
            status.fail("transcripts", f"Couldn't transcribe a video ({type(error).__name__}).")
            item["reviewError"] = str(error)[:300]
            item["reviewTries"] = item.get("reviewTries", 0) + 1
            item["reviewTried"] = now()
            continue
        status.active("transcripts", "transcribed a video")
        if sum(len(text.split()) for _, text in lines) < VIDEO_MIN_WORDS:
            item["review"] = {"verdict": "unclear", "summary": "Hardly anything is said in it (music or game sound only).", "points": [], "at": now()}
            stored.unlink(missing_ok=True)
            continue
        try:
            result = triage.video_review(game["name"], item, lines)
        except Exception as error:  # noqa: BLE001 - try again next run
            print(f"[video] {item['id']}: {type(error).__name__}: {error}")
            status.fail("claude", f"{triage.describe_error(error)[0]} Videos wait to be reviewed.")
            return
        status.active("claude", "reviewed a video")
        budget["left"] -= 1
        order = ["bug", "complaint", "suggestion", "question", "praise"]
        item["review"] = {
            "verdict": result.verdict, "summary": result.summary, "at": now(),
            "upTo": media.TRANSCRIBE_MAX if not stored.exists() and media.GEMINI_KEY and (item.get("duration") or 0) > media.TRANSCRIBE_MAX else None,
            "points": [{"kind": p.kind, "text": p.text, "quote": p.quote, "at": triage.parse_clock(p.at)}
                       for p in sorted(result.points, key=lambda p: order.index(p.kind))],
        }
        for key in ("reviewTries", "reviewTried", "reviewError"):
            item.pop(key, None)
        stored.unlink(missing_ok=True)  # reviewed: the transcript isn't needed any more
        video_post(state, item)


def video_post(state, video):
    """A reviewed video as a post (kind "video"), sorted like a Steam review: what the creator ran into,
    asked for and liked joins your bugs and ideas, counted as one more person."""
    review = video.get("review") or {}
    if not review.get("points") or f"yv{video['id'][2:]}" in state["items"]:
        return
    lines = [review.get("summary") or ""]
    for pt in review["points"]:
        at = f" [{triage_clock(pt['at'])}]" if pt.get("at") is not None else ""
        lines.append(f"- {pt['kind'].capitalize()}{at}: {pt['text']}" + (f" (said: \"{pt['quote']}\")" if pt.get("quote") else ""))
    channel = video.get("channel") or {}
    state["items"][f"yv{video['id'][2:]}"] = {
        "id": f"yv{video['id'][2:]}", "kind": "video", "url": video["url"], "media": video["id"],
        "author": {"id": f"yt:{video.get('channelId')}", "name": video.get("author"), "profile": video.get("authorUrl"), "avatar": channel.get("avatar")},
        "created": video["at"], "updated": video["at"], "title": video.get("title"), "text": "\n".join(lines),
        "versions": [], "flips": [], "pending": True, "timed": True,
    }


def triage_seconds(text):
    """'1:02:30' or '12:30' (brackets allowed) → seconds, or None."""
    parts = (text or "").strip("[]() ").split(":")
    if not 2 <= len(parts) <= 3 or not all(p.isdigit() for p in parts):
        return None
    return sum(int(p) * 60**i for i, p in enumerate(reversed(parts)))


def triage_clock(seconds):
    m, s = divmod(int(seconds), 60)
    return f"{m // 60}:{m % 60:02d}:{s:02d}" if m >= 60 else f"{m}:{s:02d}"


def ingest_refunds(state, game, refunds, packages):
    """The notes players left when refunding the game (data/refunds.json, read from Steamworks by the
    scheduled task on your Mac: feedback/refunds.js) as posts (kind "refund"), sorted like a negative
    review. `packages` are the game's package ids (from the sales breakdown)."""
    for package in packages:
        for nid, note in ((refunds.get("packages") or {}).get(package, {}).get("notes") or {}).items():
            if f"rf{nid}" in state["items"]:
                continue
            try:
                created = calendar.timegm(time.strptime(note.get("date") or "", "%Y-%m-%d")) + DAY // 2
            except ValueError:
                created = note.get("seen") or now()
            state["items"][f"rf{nid}"] = {
                "id": f"rf{nid}", "kind": "refund", "url": f"https://partner.steampowered.com/package/refunds/{package}/?range=0",
                "author": {}, "created": created, "updated": created, "refundReason": note.get("category"),
                "noteLanguage": note.get("language"), "text": note["text"], "versions": [], "flips": [], "pending": True,
            }


def game_packages(sales):
    """{app id: [package ids]} from the sales breakdown: which packages each game sold."""
    out = {}
    for apps in (sales.get("days") or {}).values():
        for app, t in apps.items():
            for package in (t.get("breakdown") or {}).get("packages") or {}:
                out.setdefault(app, set()).add(package)
    return out


def ingest_youtube(state):
    """Each YouTube video's top comments (media.py reads them) as posts (kind "comment"), sorted like
    Steam posts. Viewers often say plainly what a creator wouldn't. Not the creator's own comments
    under their video, nor yours."""
    import media

    for video in ((state.get("media") or {}).get("items") or {}).values():
        if video["source"] != "youtube":
            continue
        for c in video.get("topComments") or []:
            if not c.get("id") or f"yc{c['id']}" in state["items"] or not (c.get("text") or "").strip():
                continue
            if (c.get("channelId") and c["channelId"] == video.get("channelId")) or media.own(c.get("author")):
                continue
            state["items"][f"yc{c['id']}"] = {
                "id": f"yc{c['id']}", "kind": "comment", "url": f"{video['url']}&lc={c['id']}", "media": video["id"],
                "author": {"id": f"yt:{c.get('channelId') or c.get('author')}", "name": c.get("author"), "profile": c.get("channelUrl"), "avatar": c.get("avatar")},
                "created": c.get("at") or video["at"], "updated": c.get("at") or video["at"], "title": None, "videoTitle": video.get("title"),
                "text": c["text"], "versions": [], "flips": [], "pending": True,
            }


def fallback_points(t):
    """Every post shows at least one point; if Claude gave none, the summary is that point."""
    return [{"kind": t.get("category") or "praise", "text": t.get("summary") or ""}]


def add_tone(state, game, budget):
    """Posts triaged before triage had tone, note and key points get just those filled in, once;
    their category, issue and alerts stay as they are."""
    import triage

    for item in state["items"].values():
        t = item.get("triage")
        if not t or item.get("dev") or item.get("offTopic") or budget["left"] <= 0:
            continue
        if "tone" in t and t.get("points"):
            continue
        try:
            result = triage.triage(game["name"], item, [], thread_context(state, item))
        except Exception as error:  # noqa: BLE001 - try again next run
            print(f"[tone] {item['id']}: {type(error).__name__}: {error}")
            status.fail("claude", f"{triage.describe_error(error)[0]} Some posts still lack a tone.")
            return
        status.active("claude", "sorted a post")
        budget["left"] -= 1
        t["tone"] = result.tone
        if result.note:
            t["note"] = result.note
        t["points"] = [p.model_dump() for p in result.points] or fallback_points(t)


def triage_pending(state, game, run, budget, until=None):
    """Triages waiting posts oldest first (only those before `until`, when given)."""
    import triage

    pending = sorted(
        (i for i in state["items"].values() if i.get("pending") and not i.get("dev") and (until is None or i["created"] < until)),
        key=lambda i: i["created"],
    )
    failures = 0
    for item in pending:
        if budget["left"] <= 0:
            print(f"[triage] budget used up; {len([i for i in pending if i.get('pending')])} posts wait for the next run")
            break
        try:
            t = triage.triage(game["name"], item, open_issues(state), thread_context(state, item))
        except Exception as error:  # noqa: BLE001 - leave it pending and try again next run
            failures += 1
            print(f"[triage] {item['id']}: {type(error).__name__}: {error}")
            message, fatal = triage.describe_error(error)
            waiting = sum(1 for i in pending if i.get("pending"))
            status.fail("claude", f"{message} {waiting} post{'s' if waiting != 1 else ''} wait to be translated and triaged.")
            if fatal or failures >= 5:
                print("[triage] stopping for this run")
                break
            continue
        status.active("claude", "sorted a post")
        budget["left"] -= 1
        result = t.model_dump()
        if not result["english"].strip() or result["english"].strip() == (item.get("text") or "").strip():
            result.pop("english")  # an English post: the dashboard shows its own text
        # A YouTube comment about the video or the creator, not the game: kept, but joins nothing.
        item["offTopic"] = not result.pop("about_game", True) or None
        result["points"] = [] if item["offTopic"] else result["points"] or fallback_points(result)
        assign_issues(state, item, result, run)
        item["triage"] = result
        item["pending"] = False
        run["triaged"].append(item["id"])
        if t.urgency == "urgent":
            run["urgent"].append(item["id"])


def assign_issues(state, item, result, run):
    """Every bug, complaint and suggestion point joins a bug or idea (an existing one it repeats, or a
    new one), so one long review can count towards several, and each idea counts every player who
    raised it. Rewrites the stored points as {kind, text, urgency, issue}."""
    for old in item.get("issues") or ([item["issue"]] if item.get("issue") else []):
        if old in state["issues"]:
            state["issues"][old]["items"] = [i for i in state["issues"][old]["items"] if i != item["id"]]
            run["touched"].add(old)
    links, new_titles, points = [], {}, []
    for point in result.get("points") or []:
        stored = {"kind": point["kind"], "text": point["text"], "urgency": point.get("urgency", "low")}
        if point.get("quote"):
            stored["quote"] = point["quote"]
        if point.get("still_after_fix"):
            stored["still"] = True
        # A video's point keeps the moment it's said, so the dashboard can link straight to it.
        if item["kind"] == "video" and triage_seconds(point.get("at")) is not None:
            stored["at"] = triage_seconds(point["at"])
        if point["kind"] in ("bug", "complaint", "suggestion", "praise"):
            kind = {"bug": "bug", "praise": "praise"}.get(point["kind"], "suggestion")
            issue_id = point.get("existing_issue") if point.get("existing_issue") in state["issues"] else None
            # Praise never joins a bug or idea, nor a complaint something players love.
            if issue_id and (state["issues"][issue_id]["kind"] == "praise") != (kind == "praise"):
                issue_id = None
            # A point Claude left without an issue still gets one, titled after itself.
            title = (point.get("new_issue_title") or "").strip() or point["text"].strip().rstrip(".")[:80]
            if not issue_id and title:
                issue_id = new_titles.get(title.lower())
                if not issue_id:
                    issue_id = f"I{state['nextIssue']}"
                    state["nextIssue"] += 1
                    new_titles[title.lower()] = issue_id
                    state["issues"][issue_id] = {
                        "id": issue_id, "kind": kind, "title": title, "area": result.get("area"), "summary": point["text"],
                        "status": "open", "created": now(), "items": [], "alerted": {"urgent": False, "cluster": 0},
                    }
            if issue_id:
                stored["issue"] = issue_id
                if item["id"] not in state["issues"][issue_id]["items"]:
                    state["issues"][issue_id]["items"].append(item["id"])
                if issue_id not in links:
                    links.append(issue_id)
                run["touched"].add(issue_id)
        points.append(stored)
    result["points"] = points
    item["issues"] = links
    item["issue"] = links[0] if links else None  # the most actionable one (points are ordered that way)


def refresh_issues(state, game):
    """Recomputes every issue's counts, status, priority and fix prompt from its posts."""
    items = state["items"]
    for issue_id in list(state["issues"]):
        issue = state["issues"][issue_id]
        posts = [items[i] for i in dict.fromkeys(issue["items"]) if i in items]
        if not posts:
            del state["issues"][issue_id]
            continue
        issue["items"] = [p["id"] for p in posts]
        issue["mentions"] = len({(p.get("author") or {}).get("id") or p["id"] for p in posts})
        issue["languages"] = sorted({(p.get("triage") or {}).get("language") or "?" for p in posts})
        issue["firstSeen"] = min(p["created"] for p in posts)
        issue["lastSeen"] = max(p["created"] for p in posts)
        # Urgency from the points that belong to this issue (a post can raise several), else the post's.
        urgencies = [pt.get("urgency", "low") for p in posts for pt in (p.get("triage") or {}).get("points") or [] if pt.get("issue") == issue_id]
        urgencies = urgencies or [(p.get("triage") or {}).get("urgency", "low") for p in posts]
        issue["urgency"] = max(urgencies, key=URGENCY.index)
        issue["negativeReviews"] = sum(1 for p in posts if p["kind"] == "review" and not p.get("votedUp"))
        issue["refunds"] = sum(1 for p in posts if p["kind"] == "refund")
        # Reported inside Steam's 2-hour refund window: a first-impression problem.
        issue["firstSession"] = len({(p.get("author") or {}).get("id") or p["id"] for p in posts
                                     if p["kind"] == "review" and p.get("playtime") is not None and p["playtime"] < 2})
        issue["details"] = list(dict.fromkeys(d for p in posts if (d := (p.get("triage") or {}).get("details"))))[:8]
        if issue["status"] in ("likely_fixed", "still_happening"):
            # Only a post after the fix that says the problem persists in the fixed version counts.
            after = [p["created"] for p in posts if p["created"] > issue["fixedAt"]
                     and any(pt.get("issue") == issue_id and pt.get("still") for pt in (p.get("triage") or {}).get("points") or [])]
            issue["status"] = "still_happening" if after else "likely_fixed"
            issue["stillSince"] = min(after) if after else None
        issue["priority"] = priority(issue)
        issue["fixPrompt"] = fix_prompt(game, issue, posts) if issue["kind"] == "bug" and not game.get("research") else None


def priority(issue):
    weight = {"low": 1, "medium": 2, "high": 4, "urgent": 8}[issue["urgency"]]
    age = (now() - issue["lastSeen"]) / DAY
    score = weight * (1 + math.log2(issue["mentions"])) * (1 if age < 7 else 0.6 if age < 30 else 0.3)
    score *= 1 + 0.25 * min(issue["negativeReviews"] + issue.get("refunds", 0), 4)
    score *= {"still_happening": 1.5, "likely_fixed": 0.2}.get(issue["status"], 1)
    return round(score, 2)


def fix_prompt(game, issue, posts):
    """A self-contained prompt to paste into Claude Code in the game's repo."""
    posts = sorted(posts, key=lambda p: p["created"], reverse=True)
    quotes = []
    for p in posts[:8]:
        t = p.get("triage") or {}
        english = (t.get("english") or p.get("text") or "").strip().replace("\n", " ")
        # The player's own point about this bug first, then the post it's from.
        mine = [pt["text"] for pt in t.get("points") or [] if pt.get("issue") == issue["id"]]
        if mine:
            english = "; ".join(mine) + f" (from the post: {english})"
        if len(english) > 600:
            english = english[:600] + "…"
        where = {"review": "Steam review", "topic": "Steam discussion", "reply": "Steam discussion reply",
                 "video": "YouTube video (notes on what the creator said)", "comment": "YouTube comment",
                 "refund": "note left when refunding"}[p["kind"]]
        extra = f", {p['playtime']} h played" if p["kind"] == "review" else ""
        lang = f", written in {t['language']}" if t.get("language") not in (None, "English") else ""
        quotes.append(f"- {where} ({time.strftime('%Y-%m-%d', time.gmtime(p['created']))}{extra}{lang}): \"{english}\"\n  {p['url']}")
    lines = [
        f"Players of {game['name']} are reporting a bug on Steam. Find the cause in this codebase and fix it.",
        "",
        f"Bug: {issue['title']}",
        f"Area of the game: {issue['area']}",
        f"Reported by {issue['mentions']} player{'s' if issue['mentions'] != 1 else ''} "
        f"({', '.join(issue['languages'])}), between {time.strftime('%Y-%m-%d', time.gmtime(issue['firstSeen']))} "
        f"and {time.strftime('%Y-%m-%d', time.gmtime(issue['lastSeen']))}.",
    ]
    if issue["status"] == "still_happening":
        lines.append(
            f"Note: the patch notes for {issue['fixedIn']} looked like they fixed this, but players still reported it "
            "afterwards, so that fix was incomplete or fixed something else."
        )
    if issue["details"]:
        lines += ["", "What the reports say about reproducing it:"] + [f"- {d}" for d in issue["details"]]
    lines += ["", "Player reports (translated to English):"] + quotes
    lines += [
        "",
        "Work out the most likely cause from the code, fix it, and tell me what you changed and how to test it. "
        "If the reports aren't enough to pin it down, say what to ask the players.",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Releases
# ---------------------------------------------------------------------------


def record_releases(state, events):
    """Every update is recorded at once (the dashboard shows it); matching waits its turn."""
    known = {r["gid"]: r for r in state["releases"]}
    for event in events:
        if event["gid"] in known:
            known[event["gid"]].update(event["stats"])
        else:
            state["releases"].append(
                {k: event[k] for k in ("gid", "name", "version", "launch", "time", "url")}
                | event["stats"] | {"notes": event["body"][:20000], "matched": [], "checked": False}
            )
    state["releases"].sort(key=lambda r: r["time"])


def process_in_order(state, game, run, budget, events):
    """Posts and updates in the order they happened: the posts before an update are triaged, then
    its patch notes are matched, then the posts after it (which then know about the fix)."""
    record_releases(state, events)
    for release in state["releases"]:
        if release.get("checked", True):
            continue
        triage_pending(state, game, run, budget, until=release["time"])
        if any(i.get("pending") and not i.get("dev") and i["created"] < release["time"] for i in state["items"].values()):
            print(f"[release] {release['name']}: matching waits for older posts to be triaged")
            break
        if not merge_duplicates(state, game):
            break
        refresh_issues(state, game)
        if not match_release(state, game, release):
            break
    triage_pending(state, game, run, budget)
    merge_duplicates(state, game)


def resort(state, game):
    """Sorts every post again from scratch, after the sorting rules changed: the issues are dropped and
    rebuilt post by post, with each update's patch notes matched again in between. New issues get new
    IDs, so a fix you marked on an old one no longer applies. The run is a baseline, so nothing pings."""
    for item in state["items"].values():
        if not item.get("dev"):
            item.update(pending=True, issues=[], issue=None)
    for release in state["releases"]:
        release.update(matched=[], partly=[], checked=False)
    state["issues"] = {}
    state["mergedAt"] = None
    state["initialized"] = False
    print(f"[resort] {game['name']}: every post will be sorted again")


def merge_duplicates(state, game):
    """Posts are sorted one at a time, so two issues can end up being the same thing. After new
    issues appear, Claude looks over the whole list once and duplicates are merged into the oldest."""
    import triage

    if state.get("mergedAt") == state["nextIssue"]:
        return True
    issues = [i for i in state["issues"].values() if i["items"]]
    try:
        groups = triage.find_duplicates(game["name"], issue_digest(issues, state))
    except Exception as error:  # noqa: BLE001 - try again next run
        print(f"[merge] {type(error).__name__}: {error}")
        status.fail("claude", f"{triage.describe_error(error)[0]} Duplicate issues wait to be merged.")
        return False
    status.active("claude", "checked issues")
    number = lambda issue_id: int(issue_id[1:])
    for group in groups:
        # Issues started by the same post were sorted apart on purpose, with the whole post in view.
        founders = [state["issues"][i]["items"][0] for i in group["ids"]]
        if len(set(founders)) < len(founders):
            continue
        keep_id, *others = sorted(group["ids"], key=number)
        keep = state["issues"][keep_id]
        keep["title"] = group["title"]
        for other_id in others:
            other = state["issues"].pop(other_id)
            for item_id in other["items"]:
                item = state["items"].get(item_id)
                if not item:
                    continue
                for pt in (item.get("triage") or {}).get("points") or []:
                    if pt.get("issue") == other_id:
                        pt["issue"] = keep_id
                item["issues"] = list(dict.fromkeys(keep_id if i == other_id else i for i in item.get("issues") or []))
                item["issue"] = item["issues"][0] if item["issues"] else None
                if item_id not in keep["items"]:
                    keep["items"].append(item_id)
            for p in other.get("partly", []):
                if not any(q["in"] == p["in"] for q in keep.get("partly", [])):
                    keep.setdefault("partly", []).append(p)
            if other.get("status") == "likely_fixed" and keep.get("status") != "likely_fixed":
                keep.update({k: other.get(k) for k in ("status", "fixedIn", "fixedAt", "fixedUrl", "fixReason")})
            for release in state["releases"]:
                for key in ("matched", "partly"):
                    if other_id in release.get(key, []):
                        release[key] = list(dict.fromkeys(keep_id if i == other_id else i for i in release[key]))
        print(f"[merge] {game['name']}: {', '.join(others)} into {keep_id} ({group['title']})")
    state["mergedAt"] = state["nextIssue"]
    return True


def match_release(state, game, release):
    """Strict matching: direct fixes mark an issue likely fixed (a later, real fix takes over from an
    earlier one); lines that only help are noted as partly addressing it."""
    import triage

    candidates = [
        i for i in state["issues"].values()
        if i["kind"] != "praise" and i["status"] in ("open", "still_happening", "likely_fixed") and i["firstSeen"] < release["time"]
    ]
    try:
        matches = triage.match_release(game["name"], {**release, "body": release.get("notes", "")}, issue_digest(candidates, state))
    except Exception as error:  # noqa: BLE001 - try again next run
        print(f"[release] {release['name']}: {type(error).__name__}: {error}")
        status.fail("claude", f"{triage.describe_error(error)[0]} Patch notes wait to be matched against issues.")
        return False
    status.active("claude", "matched patch notes")
    label = f"v{release['version']}" if release["version"] else release["name"]
    direct = [m for m in matches if m.get("fit", "direct") == "direct"]
    for m in matches:
        issue = state["issues"][m["issue"]]
        if m in direct:
            issue.update(status="likely_fixed", fixedIn=label, fixedAt=release["time"], fixedUrl=release["url"], fixReason=m["reason"])
        elif not any(p.get("in") == label for p in issue.get("partly", [])):
            issue.setdefault("partly", []).append({"in": label, "url": release["url"], "reason": m["reason"]})
    release.update(matched=[m["issue"] for m in direct], partly=[m["issue"] for m in matches if m not in direct], checked=True)
    print(f"[release] {game['name']} {label}: {len(direct)} fixed, {len(matches) - len(direct)} partly")
    return True


def apply_manual_fixes(state, game):
    """What you marked fixed on the dashboard (data/cleared.json, which only the dashboard writes):
    a patch-notes-style line and the update it's in (a release's gid, or none for the next update).
    Claude judges the line like patch notes, against just that issue: a direct fix marks it likely
    fixed (reply drafts and "still happening" follow as after a release), anything less notes it as
    partly addressed and it stays on the list. A fix in the next update takes that update's name once
    it's posted, and its reply drafts wait until then. A fix you take back (the check clicked again,
    or marked fixed anew) undoes what it did. Returns False when Claude can't be reached."""
    import triage

    cleared = load(DATA / "cleared.json", {}).get(str(game["appId"]), {})
    wanted = {f"{issue_id}@{c['at']}": (issue_id, c) for issue_id, c in cleared.items() if c.get("as") in ("fixed", "done") and c.get("note")}
    done = state.setdefault("manualFixes", {})
    for key in [k for k in done if k not in wanted]:
        issue = state["issues"].get(done.pop(key)["issue"])
        if not issue:
            continue
        if issue.get("manualFix") == key:
            for k in ("manualFix", "fixPending", "fixedIn", "fixedAt", "fixedUrl", "fixReason", "stillSince"):
                issue.pop(k, None)
            issue["status"] = "open"
        issue["partly"] = [p for p in issue.get("partly", []) if p.get("manual") != key]
        print(f"[fix] {game['name']} {issue['id']}: your fix was taken back")

    def release_for(c):
        """The update the fix is in: the one you picked, or the first posted after you marked it."""
        releases = sorted(state["releases"], key=lambda r: r["time"])
        if c.get("release"):
            return next((r for r in releases if r["gid"] == c["release"]), None)
        return next((r for r in releases if r["time"] > c["at"]), None)

    label_of = lambda r: (f"v{r['version']}" if r["version"] else r["name"]) if r else "the next update"
    for key, (issue_id, c) in wanted.items():
        issue = state["issues"].get(issue_id)
        if not issue:
            continue
        release = release_for(c)
        label, url = label_of(release), release["url"] if release else None
        # When the fix counts from: the update's date, unless you picked an update older than reports
        # you marked it fixed over (players on an old build); then those reports count as before the
        # fix (crossed out, replied to) and only later ones can say it's still happening.
        reported = max((state["items"][i]["created"] for i in issue["items"] if i in state["items"] and state["items"][i]["created"] <= c["at"]), default=0)
        at = (release["time"] if release["time"] > reported else c["at"]) if release else c["at"]
        if key in done:
            if issue.get("manualFix") == key and release and not done[key].get("pending") and issue.get("fixedAt") != at:
                issue["fixedAt"] = at
            # Waiting for the next update, and it's out now: the fix takes its name, replies can follow.
            if done[key].get("pending") and release:
                if issue.get("manualFix") == key:
                    issue.update(fixedIn=label, fixedUrl=url, fixedAt=at)
                    issue.pop("fixPending", None)
                for p in issue.get("partly", []):
                    if p.get("manual") == key:
                        p.update({"in": label, "url": url})
                done[key]["pending"] = False
                print(f"[fix] {game['name']} {issue_id}: your fix is out in {label}")
            continue
        try:
            matches = triage.match_release(game["name"], {"version": release["version"] if release else None, "name": label, "body": c["note"]},
                                           issue_digest([issue], state))
        except Exception as error:  # noqa: BLE001 - try again next run
            print(f"[fix] {issue_id}: {type(error).__name__}: {error}")
            status.fail("claude", f"{triage.describe_error(error)[0]} Fixes you marked wait to be checked.")
            return False
        status.active("claude", "checked your fix")
        fit = matches[0]["fit"] if matches else "none"
        reason = matches[0]["reason"] if matches else f"Your note doesn't seem to do what players asked: \"{c['note']}\""
        if fit == "direct":
            issue.update(status="likely_fixed", fixedIn=label, fixedAt=at, fixedUrl=url, fixReason=reason, manualFix=key)
            if release:
                issue.pop("fixPending", None)
            else:
                issue["fixPending"] = True
        else:
            issue["partly"] = [p for p in issue.get("partly", []) if p.get("in") != label] + [{"in": label, "url": url, "reason": reason, "manual": key}]
        done[key] = {"issue": issue_id, "fit": fit, "reason": reason, "pending": not release}
        print(f"[fix] {game['name']} {issue_id}: your fix is {fit} ({label})")
    return True


def draft_all_fix_replies(state, game):
    for issue in state["issues"].values():
        # A fix you marked for the next update gets its replies once that update is out.
        if issue["status"] == "likely_fixed" and not issue.get("fixPending"):
            if not draft_fix_replies(state, game, issue):
                break


def draft_fix_replies(state, game, issue):
    """Steam's guidance: reply when a review or thread is about a bug you've since fixed. For each
    negative review and each thread in a likely-fixed issue, from before the fix, draft that reply
    once (one per thread). The dashboard lists them until you've replied on Steam. Returns False
    when Claude can't be reached, so the caller stops trying this run."""
    import triage

    threads = {state["items"][i].get("topic") or i for i in issue["items"]
               if i in state["items"] and state["items"][i].get("fixReply") and state["items"][i]["kind"] != "review"}
    for item_id in issue["items"]:
        item = state["items"].get(item_id)
        # A draft for an earlier, since-replaced fix is drafted again.
        if (not item or item["kind"] in OFFSITE_KINDS or item["created"] >= issue["fixedAt"]
                or (item.get("fixReply") or {}).get("version") == issue["fixedIn"] or item.get("dev")):
            continue
        if item["kind"] == "review":
            if item.get("votedUp") or item.get("devResponse"):
                continue
        else:
            thread = item.get("topic") or item["id"]
            answered = any(i.get("dev") and (i["id"] == thread or i.get("topic") == thread) and i["created"] > item["created"]
                           for i in state["items"].values())
            if thread in threads or answered:
                continue
            threads.add(thread)
        try:
            reply = triage.fix_reply(game["name"], item, issue["title"], issue["fixedIn"], issue.get("fixReason") or "")
        except Exception as error:  # noqa: BLE001 - a missing draft isn't worth failing the run
            print(f"[reply] {item_id}: {type(error).__name__}: {error}")
            status.fail("claude", f"{triage.describe_error(error)[0]} Reply drafts for fixed issues are missing.")
            return False
        status.active("claude", "drafted a reply")
        item["fixReply"] = {"issue": issue["id"], "version": issue["fixedIn"], "at": issue["fixedAt"], **reply.model_dump()}
    return True


def draft_thanks_replies(state, game):
    """A thank-you draft for each positive review from the last 60 days you haven't answered, inviting
    the player back with the newest update since their review. Drafted again when a newer update
    comes out before you reply, so the invitation names it: the newest one with a version number (an
    announcement post if none has one), with the patch notes of every update since the review.
    A complaint in the review that an update has since fixed is named too, as in a fix reply; such a
    review gets its draft at any age, and the draft changes when its fixes do (one turning out to be
    still happening drops out)."""
    import triage

    updates = sorted((r for r in state["releases"] if not r.get("launch")), key=lambda r: r["time"])
    fixed = {}  # item id -> the issues in it fixed after it was posted
    for issue in state["issues"].values():
        if issue["status"] == "likely_fixed" and not issue.get("fixPending"):
            for i in issue["items"]:
                if i in state["items"] and state["items"][i]["created"] < issue["fixedAt"]:
                    fixed.setdefault(i, []).append(issue)
    for item_id, item in state["items"].items():
        fixes = sorted(fixed.get(item_id, []), key=lambda i: i["id"])
        if (item["kind"] != "review" or not item.get("votedUp") or item.get("devResponse") or item.get("dev")
                or item.get("pending") or (item["created"] < now() - 60 * DAY and not fixes)):
            continue
        since = [r for r in reversed(updates) if r["time"] > item["created"]]
        release = next((r for r in since if r.get("version")), since[0] if since else None)
        name = release["name"] if release else None
        ids = [f"{i['id']}@{i['fixedIn']}" for i in fixes]
        if "thanksReply" in item and item["thanksReply"].get("update") == name and item["thanksReply"].get("fixes", []) == ids:
            continue
        try:
            reply = triage.thanks_reply(game["name"], item, name, since,
                                        [(i["title"], i["fixedIn"], i.get("fixReason") or "") for i in fixes])
        except Exception as error:  # noqa: BLE001 - a missing draft isn't worth failing the run
            print(f"[reply] {item_id}: {type(error).__name__}: {error}")
            status.fail("claude", f"{triage.describe_error(error)[0]} Reply drafts for positive reviews are missing.")
            return
        status.active("claude", "drafted a reply")
        item["thanksReply"] = {"update": name, "fixes": ids, "at": release["time"] if release else item["created"], **reply.model_dump()}


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------


def send_alerts(state, game, run, first_run):
    """Urgent issues, new negative reviews and bug reports, flips to negative and clusters, each
    pinging you. A game's first run only sets the baseline."""
    import notify

    items, issues = state["items"], state["issues"]
    urgent = []
    for item_id in dict.fromkeys(run["urgent"]):
        item = items[item_id]
        issue = issues.get(item.get("issue"))
        if issue:
            if issue["alerted"]["urgent"]:
                continue
            issue["alerted"]["urgent"] = True
        if not first_run:
            urgent.append(notify.urgent(game, item, issue))
    flips = [] if first_run else [notify.flip(game, items[i]) for i in dict.fromkeys(run["flips"]) if not items[i]["votedUp"]]
    clusters = []
    for issue_id in run["touched"]:
        issue = issues.get(issue_id)
        if not issue or issue["kind"] == "praise":  # what players love isn't an alert
            continue
        level = max((n for n in CLUSTER_LEVELS if issue["mentions"] >= n), default=0)
        if level > issue["alerted"]["cluster"]:
            issue["alerted"]["cluster"] = level
            if not first_run:
                posts = sorted((items[i] for i in issue["items"]), key=lambda p: p["created"], reverse=True)
                clusters.append(notify.cluster(game, issue, posts))
    # Every new negative review and every new post reporting a bug, once, when it has been sorted
    # (posts from before these alerts existed don't count). Urgent ones were already sent above.
    state.setdefault("newPostAlertsFrom", now())
    posts = []
    for item_id in dict.fromkeys(run["triaged"]):
        item = items[item_id]
        if item.get("dev") or item.get("alertedNew") or item["created"] < state["newPostAlertsFrom"]:
            continue
        item["alertedNew"] = True
        # A refund note is as bad as a negative review, and rarer.
        negative = (item["kind"] == "review" and not item.get("votedUp")) or item["kind"] == "refund"
        bugs = [pt for pt in (item.get("triage") or {}).get("points") or [] if pt["kind"] == "bug"]
        if first_run or item_id in run["urgent"] or not (negative or bugs) or item["kind"] in YOUTUBE_KINDS:
            continue
        posts.append(notify.new_post(game, item, negative, bugs))
    spike = [] if first_run else check_spike(state, game)
    # Streams, videos and articles about the game (media.py), newest last.
    coverage = [notify.media(game, state["media"]["items"][i]) for i in sorted(run.get("media") or [], key=lambda i: state["media"]["items"][i]["at"])]
    # Curators who reviewed the game since the last look (community.py).
    curators = [] if first_run else [notify.curator(game, c) for c in run.get("curators") or []]
    for batch in (spike, urgent, posts, clusters, flips, coverage, curators):
        for start in range(0, len(batch), 10):
            notify.send(batch[start : start + 10], ping=True)


SPIKE_MIN = 3  # bad posts in a day, from different players
SPIKE_RATIO = 3  # times the usual day


def check_spike(state, game):
    """A spike: in the last 24 hours, at least SPIKE_MIN players posted a negative review or reported a
    bug, and that's at least SPIKE_RATIO times their usual day (the 14 days before). Pings once, then
    again only a day later or when the count doubles. Names the update that went out just before, if
    any, and the issues those posts are about."""
    import notify

    def bad(item):
        if item.get("dev") or item.get("pending"):
            return False
        return (item["kind"] == "review" and not item.get("votedUp")) or item["kind"] == "refund" or any(
            pt["kind"] == "bug" for pt in (item.get("triage") or {}).get("points") or [])

    t = now()
    who = lambda posts: {(p.get("author") or {}).get("id") or p["id"] for p in posts}
    recent = [i for i in state["items"].values() if t - DAY <= i["created"] and bad(i)]
    before = [i for i in state["items"].values() if t - 15 * DAY <= i["created"] < t - DAY and bad(i)]
    count, usual = len(who(recent)), len(who(before)) / 14
    last = state.get("spike") or {}
    if count < SPIKE_MIN or count < SPIKE_RATIO * usual:
        return []
    if last.get("at", 0) > t - DAY and count < 2 * last.get("count", 0):
        return []
    state["spike"] = {"at": t, "count": count}
    release = max((r for r in state["releases"] if r["time"] > t - 2 * DAY), key=lambda r: r["time"], default=None)
    tally = {}
    for p in recent:
        for issue_id in p.get("issues") or []:
            issue = state["issues"].get(issue_id)
            if issue and issue["kind"] != "praise":
                tally.setdefault(issue_id, set()).add((p.get("author") or {}).get("id") or p["id"])
    top = sorted(tally, key=lambda i: len(tally[i]), reverse=True)[:5]
    print(f"[spike] {game['name']}: {count} bad posts in 24 h (usually {usual:.1f} a day)")
    return [notify.spike(game, recent, count, usual, release, [(state["issues"][i], len(tally[i])) for i in top])]


USAGE_KEYS = ("input", "output", "calls", "cost")


def _add(bucket, used):
    for k in USAGE_KEYS:
        bucket[k] = round(bucket.get(k, 0) + used[k], 6) if k == "cost" else bucket.get(k, 0) + used[k]


def record_usage(state, before):
    """Adds what this game's Claude calls used this run to its running total, today's and each
    task's (the dashboard shows them, with the estimated cost). Counting started when this was added;
    estimate_past_usage fills in the time before."""
    import triage

    used = {k: triage.USAGE[k] - before[k] for k in USAGE_KEYS}
    if not used["calls"]:
        return
    usage = state.setdefault("usage", {"since": now(), "days": {}, "tasks": {}})
    day = usage["days"].setdefault(time.strftime("%Y-%m-%d", time.gmtime()), {})
    _add(usage, used)
    _add(day, used)
    for task, now_used in triage.USAGE["tasks"].items():
        was = before["tasks"].get(task, {})
        diff = {k: now_used[k] - was.get(k, 0) for k in USAGE_KEYS}
        if diff["calls"]:
            _add(usage["tasks"].setdefault(task, {}), diff)
            _add(day.setdefault("tasks", {}).setdefault(task, {}), diff)


def estimate_past_usage(state):
    """A one-off estimate of what Claude used before counting started, from the posts, patch notes
    and replies already saved: roughly what each call sends and gets back, by text length (about 3.5
    characters a token) plus the fixed parts of each prompt. It can't see posts sorted more than once
    or calls that failed, so it's on the low side. Put on the day each call most likely ran."""
    import triage

    usage = state.get("usage") or {}
    if "past" in state:
        return
    until = usage.get("since") or now()
    start = state.get("newPostAlertsFrom") or until  # about when collecting began for this game
    tokens = lambda text: len(text or "") / 3.5
    calls = []  # (when, task, tokens in, tokens out)
    items = sorted(state["items"].values(), key=lambda i: i["created"])
    for n, item in enumerate(items):
        when = min(max(item["created"], start), until)
        t = item.get("triage") or {}
        if item.get("dev"):
            for field in (item.get("translatedOwn") or {}):
                text = item.get("text") if field == "text" else item.get("devResponse")
                calls.append((when, "translate", 300 + tokens(text), 40 + tokens(text)))
        elif t:
            open_issues = min(150, sum(1 for i in state["issues"].values() if i.get("created", 0) <= item.get("updated", item["created"])) or n)
            calls.append((when, "sort", 1800 + tokens(item.get("text")) + 45 * open_issues, 350 + 60 * len(t.get("points") or [])))
        if item.get("fixReply"):
            calls.append((min(max(item["fixReply"].get("at", until), start), until), "reply", 700 + tokens(item.get("text")), 120))
        if item.get("thanksReply"):
            calls.append((min(max(item["thanksReply"].get("at", until), start), until), "reply", 1200 + tokens(item.get("text")), 150))
    for release in state["releases"]:
        if release.get("checked"):
            found = len(release.get("matched") or []) + len(release.get("partly") or [])
            calls.append((min(max(release["time"], start), until), "patch", 600 + tokens(release.get("notes")) + 60 * len(state["issues"]), 80 + 60 * found))
    past = {"until": until, "input": 0, "output": 0, "calls": 0, "cost": 0.0, "days": {}, "tasks": {}}
    for when, task, tin, tout in calls:
        used = {"input": round(tin), "output": round(tout), "calls": 1, "cost": triage.cost("claude-haiku-4-5", tin, tout)}  # what ran before counting began
        _add(past, used)
        _add(past["tasks"].setdefault(task, {}), used)
        _add(past["days"].setdefault(time.strftime("%Y-%m-%d", time.gmtime(when)), {}), used)
    state["past"] = past


def usage_summary(state):
    """What the dashboard's game list and Claude card need (they don't load every game's file):
    totals, cost per day and per task, counted and estimated."""
    usage, past = state.get("usage") or {}, state.get("past") or {}
    if not usage and not past.get("calls"):
        return None
    return {
        "since": usage.get("since"),
        **{k: usage.get(k, 0) for k in USAGE_KEYS},
        "days": {d: round(v["cost"], 4) for d, v in sorted(usage.get("days", {}).items())},
        "tasks": {t: round(v["cost"], 4) for t, v in usage.get("tasks", {}).items()},
        "past": {**{k: past.get(k, 0) for k in USAGE_KEYS}, "until": past.get("until"),
                 "days": {d: round(v["cost"], 4) for d, v in sorted(past.get("days", {}).items())},
                 "tasks": {t: round(v["cost"], 4) for t, v in past.get("tasks", {}).items()}},
    }


def check_credit(index):
    """Your Claude credit, as you last set it on the dashboard (data/credit.json: {balance, at,
    spent}, `spent` being every game's counted cost at that moment), minus what's been spent since.
    Below $2, Discord pings you once for that balance."""
    import notify

    credit = load(DATA / "credit.json", None)
    if not credit:
        return
    research = (load(RESEARCH_INDEX, None) or {}).get("games", [])
    spent = sum((g.get("claude") or {}).get("cost", 0) for g in index["games"] + research)
    left = credit["balance"] - (spent - credit.get("spent", 0))
    alerted = index.setdefault("creditAlert", None)
    if left < 2 and alerted != credit["at"]:
        index["creditAlert"] = credit["at"]
        notify.send([{"title": f"Claude credit is running low: about ${max(left, 0):.2f} left",
                      "description": "Estimated from what the feedback collector has used since you last set your balance on the dashboard. Top up before it runs out, or posts stop being sorted.",
                      "url": "https://platform.claude.com/settings/billing", "color": 0xFAB219}], ping=True)
        print(f"[credit] about ${left:.2f} left: pinged")


def full_run(part="all"):
    """One run. `part` is "own" (your games, sales and wishlists; summary in index.json), "research"
    (research games; summary in research-index.json) or both. Each part has its own workflow, so a
    research backlog never holds back your games' data, and the two never write the same file."""
    import triage

    if not triage.DRY_RUN and not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY is not set (add it as a GitHub secret, or set FEEDBACK_DRY_RUN=1 locally)")
    changed = []
    if part != "research":
        import notify

        notify.check()
        index = load(DATA / "index.json", {"schemaVersion": SCHEMA_VERSION, "games": []})
        index.pop("research", None)  # in research-index.json now
        own_run(index, changed)
        check_credit(index)
        (index.get("status") or {}).pop("reddit", None)  # Reddit's own API isn't used any more (media.py)
        index["status"] = status.merge(index.get("status"))
        # When anything last changed, for the dashboard's "last change" (it needs no GitHub API call).
        without_time = lambda i: {k: v for k, v in i.items() if k != "changedAt"}
        if changed or without_time(index) != without_time(load(DATA / "index.json", {})):
            index["changedAt"] = now()
        save(DATA / "index.json", index)
    if part != "own":
        summary = load(RESEARCH_INDEX, None) or {"games": load(DATA / "index.json", {}).get("research", [])}
        summary["games"] = research_games(summary["games"])
        for game in summary["games"]:
            if research_run(game):
                changed.append(game["name"])
        save(RESEARCH_INDEX, summary)
    print(f"[run] changed: {', '.join(changed) or 'nothing'}")


def own_run(index, changed):
    """Your games (reviews, threads, players, media, sorting, alerts), then sales and wishlists."""
    import notify
    import triage

    # The store data the website shows about each game; when any of it changes (a new store page, a
    # release, a sale, new screenshots or text), loop.sh starts a site rebuild instead of waiting for
    # the daily one. Games from before the fingerprint existed don't count as changed.
    site_view = lambda games: {g["appId"]: g.get("store") for g in games}
    before = site_view(index["games"])
    was_upcoming = {g["appId"] for g in index["games"] if g.get("status") == "upcoming"}
    index["games"] = steam.fetch_games(index["games"])
    for game in index["games"]:
        if game["appId"] in was_upcoming and game["status"] == "released":
            print(f"[release] {game['name']} is out: posting to Discord")
            notify.released(game)
    after = site_view(index["games"])
    if before and (after.keys() != before.keys() or any(before[a] and after[a] != before[a] for a in after)):
        (HERE / ".cache").mkdir(exist_ok=True)
        (HERE / ".cache" / "rebuild-site").touch()
        print("[site] store data changed: the website will be rebuilt")
    budget = {"left": MAX_TRIAGE_PER_RUN}
    # The games you want to bundle each game with, which only the dashboard writes.
    bundle_with = load(DATA / "bundles.json", {})
    # And the games you compare each game with, also written by the dashboard.
    compare_with = load(DATA / "competitors.json", {})
    # Refund notes, from Steamworks through the scheduled task on your Mac (it needs your login).
    refunds = load(DATA / "refunds.json", {})
    packages = game_packages(load(DATA / "sales.json", {}))
    if refunds.get("read"):
        days = (now() - refunds["read"]) // DAY
        if days >= 3:
            status.fail("refunds", f"Refund notes were last read {time.strftime('%b %-d', time.gmtime(refunds['read']))}: the daily task on your Mac needs Chrome open and signed in to Steamworks.")
        else:
            status.ok("refunds")
    for game in index["games"]:
        path = game_path(game["appId"])
        state = load(path, None) or new_state(game)
        if str(game["appId"]) in RESORT or "all" in RESORT:
            resort(state, game)
        first_run = not state["initialized"]
        run = {"new": [], "edited": [], "flips": [], "urgent": [], "triaged": [], "touched": set()}
        used_before = json.loads(json.dumps(triage.USAGE))  # a copy, tasks included
        try:
            events = steam.update_events(game["appId"])
        except steam.HttpError as error:
            print(f"[steam] {game['name']} events: {error}")
            status.fail("steam", f"Couldn't read the update posts ({error}).")
            events = []
        if game["status"] == "released":
            try:
                ingest_reviews(state, game, run)
                status.ok("steam")
            except steam.HttpError as error:
                print(f"[steam] {game['name']} reviews: {error}")
                status.fail("steam", f"Couldn't read the reviews ({error}).")
            record_players(state, game)
            record_discount(state, game)
        if game.get("demo"):
            record_players(state, game, game["demo"]["appId"], "demoPlayers")
        import discussions

        discussions.ingest(state, game, run)
        import community
        import media

        run["media"] = media.collect(state, game, len(index["games"]))
        ingest_youtube(state)
        ingest_refunds(state, game, refunds, packages.get(str(game["appId"])) or [])
        community.record_followers(state, game)
        community.record_achievements(state, game)
        community.record_bundles(state, game, list(bundle_with.get(str(game["appId"])) or {}))
        community.record_competitors(state, game, list(compare_with.get(str(game["appId"])) or {}))
        run["curators"] = community.record_curators(state, game)
        review_videos(state, game, budget)
        process_in_order(state, game, run, budget, events)
        add_tone(state, game, budget)
        add_profiles(state)
        translate_own(state, budget)
        refresh_issues(state, game)
        apply_manual_fixes(state, game)
        refresh_issues(state, game)
        draft_all_fix_replies(state, game)
        draft_thanks_replies(state, game)
        refresh_issues(state, game)
        send_alerts(state, game, run, first_run)
        # The baseline lasts until the backfill is fully triaged, so old posts never trigger alerts.
        state["initialized"] = not any(i.get("pending") for i in state["items"].values())
        print(
            f"[run] {game['name']}: {len(run['new'])} new, {len(run['edited'])} edited, "
            f"{len(run['flips'])} flipped negative, {len(state['issues'])} issues"
        )
        # The dashboard lists games by their newest player post.
        game["lastPost"] = max((i["created"] for i in state["items"].values() if not i.get("dev")), default=None)
        # And your own newest post (update notes, replies), shown next to it.
        game["lastDevPost"] = max((i["created"] for i in state["items"].values() if i.get("dev")), default=None)
        record_usage(state, used_before)
        estimate_past_usage(state)
        # The totals, for the dashboard's game list and its Claude card (which sums every game).
        game["claude"] = usage_summary(state)
        if save(path, state):
            changed.append(game["name"])

    import community
    import media
    import sales as sales_api

    # Steam's sales (sales.py), hourly: days settle over a while, so more often finds nothing new.
    if media._due("sales", 0, 3600):
        sales = load(DATA / "sales.json", {"highwatermark": "0", "days": {}, "apps": {}})
        if sales_api.sync(sales):
            media._ran("sales", 0)
            if save(DATA / "sales.json", sales):
                changed.append("sales")

    # Wishlists (wishlists.py), hourly with sales: same key, and Steam fills in each day once it's over.
    import wishlists as wishlists_api

    if wishlists_api.KEY and media._due("wishlists", 0, 3600):
        wishlists = load(DATA / "wishlists.json", {"apps": {}})
        if wishlists_api.sync(wishlists, [g["appId"] for g in index["games"]]):
            media._ran("wishlists", 0)
        if save(DATA / "wishlists.json", wishlists):
            changed.append("wishlists")

    try:
        community.record_discord(index, steam.site_config().get("discord"))
    except Exception as error:  # noqa: BLE001 - node missing locally, or a config hiccup
        print(f"[community] Discord skipped ({error})")


# ---------------------------------------------------------------------------
# Research games: other studios' games you add on the dashboard's Research view, collected and
# sorted like your own so you can see what their players love, miss and run into. No alerts,
# replies, sales, media or fix prompts; they're not yours to answer.
# ---------------------------------------------------------------------------

RESEARCH_EVERY = 6 * 3600  # once sorted, new posts on an older game don't need checking every 5 minutes


def research_games(previous):
    """[{appId, name, status, released, capsule, details, demo, research}] for every game in research.json
    (written by the dashboard), store details refreshed daily."""
    import media

    wanted = load(DATA / "research.json", {})
    known = {str(g["appId"]): g for g in previous}
    games = []
    for key, entry in wanted.items():
        game = known.get(key) or {"appId": int(key), "name": entry.get("name") or key, "research": True}
        # Daily, and once for a game saved before demos were looked up.
        if media._due("research-store", key, DAY) or "status" not in game or "demo" not in game:
            try:
                found = (steam.request("https://store.steampowered.com/api/appdetails", params={"appids": key, "cc": "us", "l": "english"}) or {}).get(key) or {}
            except steam.HttpError as error:
                print(f"[research] {key}: {error}")
                found = {}
            if found.get("success"):
                d = found["data"]
                release = d.get("release_date") or {}
                game.update(name=d.get("name") or game["name"], status="upcoming" if release.get("coming_soon") else "released",
                            released=steam.parse_release_date(release.get("date")), capsule=d.get("header_image"),
                            details=steam.store_extras(d), demo=steam.public_demo(d, game.get("demo")))
                media._ran("research-store", key)
            elif "status" not in game:
                continue  # not on the store (yet): try again next run
        games.append(game)
    return games


def research_run(game):
    """One research game's run: new reviews, threads and updates, sorted by Claude until it has cost
    RESEARCH_CAP. Every run while posts wait to be sorted, else every RESEARCH_EVERY. Returns whether
    its file changed."""
    import community
    import discussions
    import media
    import triage

    app_id = game["appId"]
    path = game_path(app_id)
    state = load(path, None) or {**new_state(game), "past": {}}  # nothing ran before counting
    if str(app_id) in RESORT or "all" in RESORT:
        resort(state, game)
    waiting = any(i.get("pending") and not i.get("dev") for i in state["items"].values())
    spent = (state.get("usage") or {}).get("cost", 0)
    if not ((waiting and spent < RESEARCH_CAP) or media._due("research", app_id, RESEARCH_EVERY)):
        return False
    run = {"new": [], "edited": [], "flips": [], "urgent": [], "triaged": [], "touched": set()}
    used_before = json.loads(json.dumps(triage.USAGE))
    try:
        events = steam.update_events(app_id)
    except steam.HttpError as error:
        print(f"[research] {game['name']} events: {error}")
        events = []
    if game["status"] == "released":
        try:
            ingest_reviews(state, game, run)
        except steam.HttpError as error:
            print(f"[research] {game['name']} reviews: {error}")
        record_players(state, game)
    # A demo's players too, like your own games' (often out before the game is).
    if game.get("demo"):
        record_players(state, game, game["demo"]["appId"], "demoPlayers")
    discussions.ingest(state, game, run)
    community.record_achievements(state, game)
    # Only the profile link: looking up thousands of names and avatars isn't worth the requests.
    for item in state["items"].values():
        author = item.get("author") or {}
        if "profile" not in author and str(author.get("id") or "").isdigit():
            author["profile"] = steam.profile_url(author["id"])
    budget = {"left": RESEARCH_TRIAGE_PER_RUN if spent < RESEARCH_CAP else 0}
    process_in_order(state, game, run, budget, events)
    refresh_issues(state, game)
    state["initialized"] = not any(i.get("pending") for i in state["items"].values())
    game["pending"] = sum(1 for i in state["items"].values() if i.get("pending") and not i.get("dev"))
    game["capped"] = bool(game["pending"]) and spent >= RESEARCH_CAP
    game["lastPost"] = max((i["created"] for i in state["items"].values() if not i.get("dev")), default=None)
    record_usage(state, used_before)
    game["claude"] = usage_summary(state)
    media._ran("research", app_id)
    print(f"[research] {game['name']}: {len(run['new'])} new, {len(run['triaged'])} sorted, {game['pending']} waiting, "
          f"{len(state['issues'])} issues, ${(state.get('usage') or {}).get('cost', 0):.2f} so far")
    return save(path, state)


def test_discord():
    """One example of each alert, from the real data and marked as a test, so you can see the webhook
    works and what the alerts look like. Nothing is saved."""
    import notify

    if not notify.WEBHOOK:
        sys.exit("DISCORD_WEBHOOK_URL is not set (add it as a GitHub secret)")
    if notify.RELEASES_WEBHOOK:
        latest = max((g for g in load(DATA / "index.json", {"games": []})["games"] if g.get("status") == "released"),
                     key=lambda g: g.get("released") or 0, default=None)
        if latest and not notify.released(latest, test=True):
            sys.exit(1)
    index = load(DATA / "index.json", {"games": []})
    states = {g["appId"]: load(game_path(g["appId"]), None) for g in index["games"]}
    states = {k: v for k, v in states.items() if v}
    games = {g["appId"]: g for g in index["games"]}
    pool = [(games[a], s, i) for a, s in states.items() for i in s["issues"].values()]
    if not pool:
        sys.exit("No issues in the data yet to build examples from")
    game, state, issue = max(pool, key=lambda p: p[2].get("priority", 0))
    posts = sorted((state["items"][i] for i in issue["items"] if i in state["items"]), key=lambda p: p["created"], reverse=True)
    all_items = [i for _, s, _ in pool for i in s["items"].values()]
    negative = next((i for i in all_items if i["kind"] == "review" and not i.get("votedUp")), None)
    bug_points = lambda i: [pt for pt in (i.get("triage") or {}).get("points") or [] if pt["kind"] == "bug"]
    bug_post = next((i for i in all_items if not i.get("dev") and bug_points(i) and not (i["kind"] == "review" and not i.get("votedUp"))), None)
    owner = lambda item: next(games[a] for a, s in states.items() if item["id"] in s["items"])
    test = "🧪 **Test** of the player feedback alerts: one of each kind, made from real posts. Nothing is wrong."
    sent = [notify.send([notify.urgent(game, posts[0], issue)], ping=True, note=test + "\n**1. Urgent issue** (pings you):")]
    sent.append(notify.send([notify.cluster(game, issue, posts)], ping=True, note="**2. Repeated reports** (pings you):"))
    if negative:
        sent.append(notify.send([notify.new_post(owner(negative), negative, True, bug_points(negative))], ping=True, note="**3. New negative review** (pings you):"))
    if bug_post:
        sent.append(notify.send([notify.new_post(owner(bug_post), bug_post, False, bug_points(bug_post))], ping=True, note="**4. New bug report** (pings you):"))
    if negative:
        sent.append(notify.send([notify.flip(owner(negative), negative)], ping=True, note="**5. Review flipped to negative** (pings you):"))
    release = max(state["releases"], key=lambda r: r["time"], default=None)
    sent.append(notify.send([notify.spike(game, posts, max(SPIKE_MIN, issue["mentions"]), 0.4, release, [(issue, issue["mentions"])])],
                            ping=True, note="**5b. Spike in negative reviews and bug reports** (pings you):"))
    # One of each kind of coverage, from the data when there is one.
    covered = {}
    for a, s in states.items():
        for m in sorted((s.get("media") or {}).get("items", {}).values(), key=lambda m: m["at"], reverse=True):
            covered.setdefault(m["source"], (games[a], m))
    for n, source in enumerate(("twitch", "youtube", "news"), 6):
        if source in covered:
            sent.append(notify.send([notify.media(*covered[source])], ping=True, note=f"**{n}. {notify.MEDIA[source][1]}** (pings you):"))
    print(f"[discord] test: {sum(sent)} of {len(sent)} messages accepted")
    if not all(sent):
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-discord", action="store_true")
    parser.add_argument("--part", choices=["all", "own", "research"], default="all")
    args = parser.parse_args()
    if args.test_discord:
        test_discord()
        return
    full_run(args.part)


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    main()
