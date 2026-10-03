#!/usr/bin/env python3
"""Player feedback collector, run by .github/workflows/feedback.yml.

    python feedback/run.py --gate    decide whether a full run is due (stdlib only, prints run=true/false)
    python feedback/run.py           full run: fetch, triage, alert, write feedback/data/
    python feedback/run.py --force   full run regardless of the schedule

A full run is due every 4 hours, and on every 20-minute tick for 48 hours after a game publishes an
update or patch-notes event (which /ship does), so reports about a fresh build surface quickly.

Env (GitHub secrets): STEAM_PUBLISHER_KEY, ANTHROPIC_API_KEY, DISCORD_WEBHOOK_URL, DISCORD_MENTION.
None of them is ever written to feedback/data/. FEEDBACK_DRY_RUN=1 skips Claude (local testing).
"""

import argparse
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path

import status
import steam

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("FEEDBACK_DATA_DIR") or HERE / "data")  # override for local test runs
RUN_STATE = DATA.parent / ".cache" / "run.json" if os.environ.get("FEEDBACK_DATA_DIR") else HERE / ".cache" / "run.json"  # not committed; kept by the Actions cache
SCHEMA_VERSION = 1

FULL_INTERVAL = 4 * 3600
BURST_WINDOW = 48 * 3600
SLACK = 15 * 60  # cron ticks drift, so "4 hours" means "at least 3h45m"
DAILY_REPORT_HOUR = 7  # UTC; the first run after this posts the daily report
MAX_TRIAGE_PER_RUN = 400  # bounds the first backfill; the rest is picked up next run
CLUSTER_LEVELS = [3, 5, 10, 25, 50, 100, 250, 500]
URGENCY = ["low", "medium", "high", "urgent"]
DAY = 86400


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


def game_path(app_id):
    return DATA / "games" / f"{app_id}.json"


def output(name, value):
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"{name}={value}\n")
    print(f"{name}={value}")


# ---------------------------------------------------------------------------
# Gate
# ---------------------------------------------------------------------------


def gate():
    index = load(DATA / "index.json", {"games": []})
    run_state = load(RUN_STATE, {})
    if not index["games"]:
        return True, "no games known yet"
    for game in index["games"]:
        try:
            events = steam.update_events(game["appId"])
        except steam.HttpError as error:
            print(f"[gate] {game['name']}: {error}")
            continue
        if not events:
            continue
        latest = events[0]
        known = {r["gid"] for r in load(game_path(game["appId"]), {}).get("releases", [])}
        if latest["gid"] not in known:
            return True, f"{game['name']}: new update '{latest['name']}'"
        if now() - latest["time"] < BURST_WINDOW:
            return True, f"{game['name']}: within 48 h of '{latest['name']}'"
    since = now() - run_state.get("lastFullRun", 0)
    if since >= FULL_INTERVAL - SLACK:
        return True, "scheduled"
    return False, f"last full run {since // 60} min ago"


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
    """New and edited reviews, newest first, down to the last one we've seen."""
    app_id = game["appId"]
    watermark = state["watermarks"].get("reviews", 0)
    newest = watermark
    for page, (res, reviews) in enumerate(steam.review_pages(app_id)):
        summary = res.get("query_summary") or {}
        if page == 0 and summary.get("total_reviews") is not None:
            state["reviewTotals"][time.strftime("%Y-%m-%d", time.gmtime())] = {
                "positive": summary.get("total_positive", 0),
                "negative": summary.get("total_negative", 0),
                "desc": summary.get("review_score_desc"),
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
    state["watermarks"]["reviews"] = newest


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
            "versions": [],
            "flips": [],
            "pending": True,
        }
        run["new"].append(rid)
        return
    item["votesUp"] = r.get("votes_up", 0)
    item["author"]["reviews"] = author.get("num_reviews")
    item["playtimeForever"] = round((author.get("playtime_forever") or 0) / 60, 1)
    item["steamPurchase"] = bool(r.get("steam_purchase"))
    item["receivedForFree"] = bool(r.get("received_for_free"))
    item["devResponse"] = r.get("developer_response") or None
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


def record_discount(state, game):
    """Steam has no history of a game's sales, but its store shows the current discount: keep it, as
    [time, percent] changes, so the dashboard can shade sale periods from now on."""
    discount = game.get("discount")
    if discount is None:
        return
    series = state.setdefault("discounts", [])
    if not series or series[-1][1] != discount:
        series.append([now(), discount])


def record_players(state, game):
    try:
        count = steam.player_count(game["appId"])
    except steam.HttpError as error:
        print(f"[steam] {game['name']} players: {error}")
        status.fail("steam", f"Couldn't read the player count ({error}).")
        return
    if count is None:
        return
    series = state["players"]
    # Store changes only: the dashboard draws it as a step line, and an unchanged count isn't a commit.
    if not series or series[-1][1] != count:
        series.append([now(), count])


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


def add_profiles(state):
    """The player's Steam name, picture and profile link for each post (from their public profile),
    looked up once per post so the dashboard can show who wrote it."""
    looked_up = {}
    for item in state["items"].values():
        author = item.get("author") or {}
        if not author.get("id"):
            continue
        if "profile" not in author:
            if author["id"] not in looked_up:
                looked_up[author["id"]] = steam.profile(author["id"])
            profile = looked_up[author["id"]]
            author["profile"] = profile["url"] if profile else None
            if profile:
                author.update(name=profile["name"], avatar=profile["avatar"])
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
            budget["left"] -= 1
            english = result.english.strip()
            if field == "text":
                item["triage"] = {"language": result.language, "english": english}
            else:
                item["devResponseLanguage"] = result.language
                item["devResponseEnglish"] = english or None
            item["translatedOwn"] = {**done, field: key}


def fallback_points(t):
    """Every post shows at least one point; if Claude gave none, the summary is that point."""
    return [{"kind": t.get("category") or "praise", "text": t.get("summary") or ""}]


def add_tone(state, game, budget):
    """Posts triaged before triage had tone, note and key points get just those filled in, once;
    their category, issue and alerts stay as they are."""
    import triage

    for item in state["items"].values():
        t = item.get("triage")
        if not t or item.get("dev") or budget["left"] <= 0:
            continue
        if "tone" in t and t.get("points"):
            continue
        try:
            result = triage.triage(game["name"], item, [], thread_context(state, item))
        except Exception as error:  # noqa: BLE001 - try again next run
            print(f"[tone] {item['id']}: {type(error).__name__}: {error}")
            status.fail("claude", f"{triage.describe_error(error)[0]} Some posts still lack a tone.")
            return
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
        status.ok("claude")
        budget["left"] -= 1
        result = t.model_dump()
        result["points"] = result["points"] or fallback_points(result)
        if not result["english"].strip() or result["english"].strip() == (item.get("text") or "").strip():
            result.pop("english")  # an English post: the dashboard shows its own text
        assign_issues(state, item, result, run)
        item["triage"] = result
        item["pending"] = False
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
        issue["fixPrompt"] = fix_prompt(game, issue, posts) if issue["kind"] == "bug" else None


def priority(issue):
    weight = {"low": 1, "medium": 2, "high": 4, "urgent": 8}[issue["urgency"]]
    age = (now() - issue["lastSeen"]) / DAY
    score = weight * (1 + math.log2(issue["mentions"])) * (1 if age < 7 else 0.6 if age < 30 else 0.3)
    score *= 1 + 0.25 * min(issue["negativeReviews"], 4)
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
        where = {"review": "Steam review", "topic": "Steam discussion", "reply": "Steam discussion reply"}[p["kind"]]
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
    known = {r["gid"] for r in state["releases"]}
    for event in events:
        if event["gid"] not in known:
            state["releases"].append(
                {k: event[k] for k in ("gid", "name", "version", "launch", "time", "url")}
                | {"notes": event["body"][:20000], "matched": [], "checked": False}
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
    number = lambda issue_id: int(issue_id[1:])
    for group in groups:
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


def draft_all_fix_replies(state, game):
    for issue in state["issues"].values():
        if issue["status"] == "likely_fixed":
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
        if not item or item["created"] >= issue["fixedAt"] or (item.get("fixReply") or {}).get("version") == issue["fixedIn"] or item.get("dev"):
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
        item["fixReply"] = {"issue": issue["id"], "version": issue["fixedIn"], "at": issue["fixedAt"], **reply.model_dump()}
    return True


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------


def send_alerts(state, game, run, first_run):
    """Urgent issues, flips to negative and clusters. A game's first run only sets the baseline."""
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
    # Urgent issues and clusters @mention; flips arrive quietly.
    for batch, ping in ((urgent, True), (clusters, True), (flips, False)):
        for start in range(0, len(batch), 10):
            notify.send(batch[start : start + 10], ping=ping)


def daily_report(index, states):
    import notify

    lines = daily_lines(index, states)
    return bool(lines) and notify.send([notify.daily(lines)])


def daily_lines(index, states):
    since = max(index.get("dailyReportAt") or 0, now() - 36 * 3600) or now() - DAY
    lines = []
    for game in index["games"]:
        state = states.get(game["appId"])
        if not state:
            continue
        items = state["items"].values()
        new_reviews = [i for i in items if i["kind"] == "review" and i["created"] >= since]
        up = sum(1 for i in new_reviews if i["votedUp"])
        flips = sum(1 for i in items for f in i.get("flips", []) if f["at"] >= since)
        threads = sum(1 for i in items if i["kind"] == "topic" and i["created"] >= since and not i.get("dev"))
        replies = sum(1 for i in items if i["kind"] == "reply" and i["created"] >= since and not i.get("dev"))
        new_issues = [i for i in state["issues"].values() if i["created"] >= since and i["kind"] != "praise"]
        to_reply = [i for i in items if i.get("fixReply") and not i.get("devResponse")
                    and state["issues"].get(i["fixReply"]["issue"], {}).get("status") == "likely_fixed"]
        open_bugs = [i for i in state["issues"].values() if i["kind"] == "bug" and i["status"] != "likely_fixed"]
        still = [i for i in state["issues"].values() if i["status"] == "still_happening"]
        players = [n for t, n in state["players"] if t >= since]
        last_players = state["players"][-1][1] if state["players"] else None
        peak = max(players + ([last_players] if last_players is not None else []), default=None)
        totals = state["reviewTotals"].get(max(state["reviewTotals"], default=""), {})

        line = f"**{game['name']}**"
        if last_players is not None:
            line += f" · 👥 {last_players} now, {peak} peak"
        if totals:
            line += f" · ⭐ {totals.get('desc') or ''} ({totals.get('positive', 0)}👍 {totals.get('negative', 0)}👎)"
        parts = [f"{len(new_reviews)} new review{'s' if len(new_reviews) != 1 else ''} ({up}👍 {len(new_reviews) - up}👎)"]
        if flips:
            parts.append(f"{flips} flipped")
        if threads or replies:
            parts.append(f"{threads} new thread{'s' if threads != 1 else ''}, {replies} repl{'ies' if replies != 1 else 'y'}")
        parts.append(f"{len(open_bugs)} open bug{'s' if len(open_bugs) != 1 else ''}")
        if to_reply:
            parts.append(f"{len(to_reply)} worth a reply (fixed since)")
        if still:
            parts.append(f"{len(still)} still happening after a fix")
        line += "\n" + " · ".join(parts)
        for issue in sorted(new_issues, key=lambda i: i["priority"], reverse=True)[:3]:
            line += f"\n• New {issue['kind']}: {issue['title']} ({issue['mentions']})"
        lines.append(line)
    return lines


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def full_run():
    import triage

    if not triage.DRY_RUN and not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY is not set (add it as a GitHub secret, or set FEEDBACK_DRY_RUN=1 locally)")
    import notify

    if not notify.WEBHOOK:
        status.fail("discord", "No DISCORD_WEBHOOK_URL secret is set, so alerts aren't sent.")
    index = load(DATA / "index.json", {"schemaVersion": SCHEMA_VERSION, "games": [], "dailyReportAt": None})
    index["games"] = steam.fetch_games(index["games"])
    budget = {"left": MAX_TRIAGE_PER_RUN}
    states, changed = {}, []
    for game in index["games"]:
        path = game_path(game["appId"])
        state = load(path, None) or new_state(game)
        first_run = not state["initialized"]
        run = {"new": [], "edited": [], "flips": [], "urgent": [], "touched": set()}
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
        import discussions

        discussions.ingest(state, game, run)
        process_in_order(state, game, run, budget, events)
        add_tone(state, game, budget)
        add_profiles(state)
        translate_own(state, budget)
        refresh_issues(state, game)
        draft_all_fix_replies(state, game)
        refresh_issues(state, game)
        send_alerts(state, game, run, first_run)
        # The baseline lasts until the backfill is fully triaged, so old posts never trigger alerts.
        state["initialized"] = not any(i.get("pending") for i in state["items"].values())
        print(
            f"[run] {game['name']}: {len(run['new'])} new, {len(run['edited'])} edited, "
            f"{len(run['flips'])} flipped negative, {len(state['issues'])} issues"
        )
        states[game["appId"]] = state
        # The dashboard lists games by their newest player post.
        game["lastPost"] = max((i["created"] for i in state["items"].values() if not i.get("dev")), default=None)
        if save(path, state):
            changed.append(game["name"])

    hour = time.gmtime().tm_hour
    today = time.strftime("%Y-%m-%d", time.gmtime())
    last = index.get("dailyReportAt")
    if last and hour >= DAILY_REPORT_HOUR and time.strftime("%Y-%m-%d", time.gmtime(last)) != today:
        if daily_report(index, states):
            index["dailyReportAt"] = now()
    elif not last:
        index["dailyReportAt"] = now()  # first ever run: start counting from here
    index["status"] = status.merge(index.get("status"))
    save(DATA / "index.json", index)
    save(RUN_STATE, {"lastFullRun": now()})
    print(f"[run] changed: {', '.join(changed) or 'nothing'}")


def test_discord():
    """One example of each alert, from the real data and marked as a test, so you can see the webhook
    works and what the alerts look like. Nothing is saved."""
    import notify

    if not notify.WEBHOOK:
        sys.exit("DISCORD_WEBHOOK_URL is not set (add it as a GitHub secret)")
    index = load(DATA / "index.json", {"games": []})
    states = {g["appId"]: load(game_path(g["appId"]), None) for g in index["games"]}
    states = {k: v for k, v in states.items() if v}
    games = {g["appId"]: g for g in index["games"]}
    pool = [(games[a], s, i) for a, s in states.items() for i in s["issues"].values()]
    if not pool:
        sys.exit("No issues in the data yet to build examples from")
    game, state, issue = max(pool, key=lambda p: p[2].get("priority", 0))
    posts = sorted((state["items"][i] for i in issue["items"] if i in state["items"]), key=lambda p: p["created"], reverse=True)
    negative = next((i for _, s, _ in pool for i in s["items"].values() if i["kind"] == "review" and not i.get("votedUp")), None)
    test = "🧪 **Test** of the player feedback alerts: one of each kind, made from real posts. Nothing is wrong."
    sent = [notify.send([notify.urgent(game, posts[0], issue)], ping=True, note=test + "\n**1. Urgent issue** (pings you):")]
    sent.append(notify.send([notify.cluster(game, issue, posts)], ping=True, note="**2. Repeated reports** (pings you):"))
    if negative:
        owner = next(games[a] for a, s in states.items() if negative["id"] in s["items"])
        sent.append(notify.send([notify.flip(owner, negative)], note="**3. Review flipped to negative** (no ping):"))
    sent.append(notify.send([notify.daily(daily_lines(index, states))], note="**4. Daily report** (no ping):"))
    print(f"[discord] test: {sum(sent)} of {len(sent)} messages accepted")
    if not all(sent):
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gate", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--test-discord", action="store_true")
    args = parser.parse_args()
    if args.test_discord:
        test_discord()
        return
    force = args.force or os.environ.get("FEEDBACK_FORCE") == "true"
    if args.gate:
        if os.environ.get("FEEDBACK_HAS_KEY") == "false":
            print("::warning::Player feedback is paused: add the ANTHROPIC_API_KEY secret (see feedback/README.md)")
            output("run", "false")
            return
        due, reason = (True, "forced") if force else gate()
        print(f"[gate] {reason}")
        output("run", "true" if due else "false")
        return
    full_run()


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    main()
