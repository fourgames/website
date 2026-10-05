#!/usr/bin/env python3
"""Player feedback collector, run by .github/workflows/feedback.yml.

    python feedback/run.py                  full run: fetch, triage, alert, write feedback/data/
    python feedback/run.py --test-discord   send one example of each Discord alert

loop.sh runs it every 5 minutes. A run with nothing new only reads from Steam.

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
SCHEMA_VERSION = 1

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
        status.active("steam", "new review")
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
            status.active("claude", "translated your post")
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
        result["points"] = result["points"] or fallback_points(result)
        if not result["english"].strip() or result["english"].strip() == (item.get("text") or "").strip():
            result.pop("english")  # an English post: the dashboard shows its own text
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
    status.active("claude", "checked issues")
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
        negative = item["kind"] == "review" and not item.get("votedUp")
        bugs = [pt for pt in (item.get("triage") or {}).get("points") or [] if pt["kind"] == "bug"]
        if first_run or item_id in run["urgent"] or not (negative or bugs):
            continue
        posts.append(notify.new_post(game, item, negative, bugs))
    # Streams, videos and articles about the game (media.py), newest last.
    coverage = [notify.media(game, state["media"]["items"][i]) for i in sorted(run.get("media") or [], key=lambda i: state["media"]["items"][i]["at"])]
    for batch in (urgent, posts, clusters, flips, coverage):
        for start in range(0, len(batch), 10):
            notify.send(batch[start : start + 10], ping=True)


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
    price_in, price_out = triage.PRICES.get(triage.MODEL, (0, 0))
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
        used = {"input": round(tin), "output": round(tout), "calls": 1, "cost": (tin * price_in + tout * price_out) / 1e6}
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
    spent = sum((g.get("claude") or {}).get("cost", 0) for g in index["games"])
    left = credit["balance"] - (spent - credit.get("spent", 0))
    alerted = index.setdefault("creditAlert", None)
    if left < 2 and alerted != credit["at"]:
        index["creditAlert"] = credit["at"]
        notify.send([{"title": f"Claude credit is running low: about ${max(left, 0):.2f} left",
                      "description": "Estimated from what the feedback collector has used since you last set your balance on the dashboard. Top up before it runs out, or posts stop being sorted.",
                      "url": "https://platform.claude.com/settings/billing", "color": 0xFAB219}], ping=True)
        print(f"[credit] about ${left:.2f} left: pinged")


def full_run():
    import triage

    if not triage.DRY_RUN and not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY is not set (add it as a GitHub secret, or set FEEDBACK_DRY_RUN=1 locally)")
    import notify

    notify.check()
    index = load(DATA / "index.json", {"schemaVersion": SCHEMA_VERSION, "games": []})
    # The store data the website shows about each game; when any of it changes (a new store page, a
    # release, a sale, new screenshots or text), loop.sh starts a site rebuild instead of waiting for
    # the daily one. Games from before the fingerprint existed don't count as changed.
    site_view = lambda games: {g["appId"]: g.get("store") for g in games}
    before = site_view(index["games"])
    index["games"] = steam.fetch_games(index["games"])
    after = site_view(index["games"])
    if before and (after.keys() != before.keys() or any(before[a] and after[a] != before[a] for a in after)):
        (HERE / ".cache").mkdir(exist_ok=True)
        (HERE / ".cache" / "rebuild-site").touch()
        print("[site] store data changed: the website will be rebuilt")
    budget = {"left": MAX_TRIAGE_PER_RUN}
    changed = []
    # The games you want to bundle each game with, which only the dashboard writes.
    bundle_with = load(DATA / "bundles.json", {})
    # And the games you compare each game with, also written by the dashboard.
    compare_with = load(DATA / "competitors.json", {})
    for game in index["games"]:
        path = game_path(game["appId"])
        state = load(path, None) or new_state(game)
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
        import discussions

        discussions.ingest(state, game, run)
        import community
        import media

        run["media"] = media.collect(state, game, len(index["games"]))
        community.record_followers(state, game)
        community.record_achievements(state, game)
        community.record_bundles(state, game, list(bundle_with.get(str(game["appId"])) or {}))
        community.record_competitors(state, game, list(compare_with.get(str(game["appId"])) or {}))
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

    check_credit(index)
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

    try:
        community.record_discord(index, steam.site_config().get("discord"))
    except Exception as error:  # noqa: BLE001 - node missing locally, or a config hiccup
        print(f"[community] Discord skipped ({error})")
    (index.get("status") or {}).pop("reddit", None)  # Reddit's own API isn't used any more (media.py)
    index["status"] = status.merge(index.get("status"))
    # When anything last changed, for the dashboard's "last change" (it needs no GitHub API call).
    without_time = lambda i: {k: v for k, v in i.items() if k != "changedAt"}
    if changed or without_time(index) != without_time(load(DATA / "index.json", {})):
        index["changedAt"] = now()
    save(DATA / "index.json", index)
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
    args = parser.parse_args()
    if args.test_discord:
        test_discord()
        return
    full_run()


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    main()
