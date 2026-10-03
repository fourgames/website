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
import json
import math
import os
import sys
import time
from pathlib import Path

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
            "author": {"id": author.get("steamid")},
            "lang": r.get("language"),
            "created": int(r.get("timestamp_created") or updated),
            "updated": updated,
            "text": text,
            "votedUp": voted_up,
            "playtime": round(minutes / 60, 1),
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


def record_players(state, game):
    try:
        count = steam.player_count(game["appId"])
    except steam.HttpError as error:
        print(f"[steam] {game['name']} players: {error}")
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


def issue_digest(issues):
    """What Claude sees of each issue, to merge duplicates and match patch notes."""
    return [
        {"id": i["id"], "kind": i["kind"], "title": i["title"], "area": i["area"], "mentions": i.get("mentions", 1),
         "summary": i.get("summary"), "details": "; ".join(i.get("details", [])[:3])}
        for i in issues
    ]


def open_issues(state):
    """Every issue a new post could repeat, likely-fixed ones included (that's how "still happening" is found)."""
    return issue_digest(sorted(state["issues"].values(), key=lambda i: i.get("lastSeen", 0), reverse=True)[:150])


def thread_context(state, item):
    """For a reply: the thread it's in, and the issue its opening post was merged into."""
    if item["kind"] != "reply":
        return None
    op = state["items"].get(item.get("topic"))
    if not op:
        return None
    ctx = f"Thread: \"{op.get('title', '')}\""
    if op.get("issue"):
        ctx += f" (its opening post is issue {op['issue']})"
    return ctx


def triage_pending(state, game, run, budget):
    import triage

    pending = sorted(
        (i for i in state["items"].values() if i.get("pending") and not i.get("dev")), key=lambda i: i["created"]
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
            if failures >= 5:
                print("[triage] too many failures, stopping for this run")
                break
            continue
        budget["left"] -= 1
        result = t.model_dump(exclude={"existing_issue", "new_issue_title"})
        if result["language"] == "English" and result["english"].strip() == (item.get("text") or "").strip():
            result.pop("english")  # no need to store the same text twice
        item["triage"] = result
        item["pending"] = False
        assign_issue(state, item, t, run)
        if t.urgency == "urgent":
            run["urgent"].append(item["id"])


def assign_issue(state, item, t, run):
    old = item.get("issue")
    if old and old in state["issues"]:
        state["issues"][old]["items"] = [i for i in state["issues"][old]["items"] if i != item["id"]]
        run["touched"].add(old)
    item["issue"] = None
    if t.category not in ("bug", "suggestion"):
        return
    issue_id = t.existing_issue if t.existing_issue in state["issues"] else None
    if not issue_id and t.new_issue_title:
        issue_id = f"I{state['nextIssue']}"
        state["nextIssue"] += 1
        state["issues"][issue_id] = {
            "id": issue_id,
            "kind": t.category,
            "title": t.new_issue_title.strip(),
            "area": t.area,
            "summary": t.summary,
            "status": "open",
            "created": now(),
            "items": [],
            "alerted": {"urgent": False, "cluster": 0},
        }
    if issue_id:
        state["issues"][issue_id]["items"].append(item["id"])
        item["issue"] = issue_id
        run["touched"].add(issue_id)


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
        issue["urgency"] = max(((p.get("triage") or {}).get("urgency", "low") for p in posts), key=URGENCY.index)
        issue["negativeReviews"] = sum(1 for p in posts if p["kind"] == "review" and not p.get("votedUp"))
        issue["details"] = list(dict.fromkeys(d for p in posts if (d := (p.get("triage") or {}).get("details"))))[:8]
        if issue["status"] in ("likely_fixed", "still_happening"):
            after = [p["created"] for p in posts if p["created"] > issue["fixedAt"]]
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


def check_releases(state, game, events):
    """New update events: ask Claude which open issues the patch notes address."""
    import triage

    known = {r["gid"] for r in state["releases"]}
    for event in sorted(events, key=lambda e: e["time"]):
        if event["gid"] in known:
            continue
        candidates = [
            i for i in state["issues"].values() if i["status"] in ("open", "still_happening") and i["firstSeen"] < event["time"]
        ]
        try:
            matches = triage.match_release(game["name"], event, issue_digest(candidates))
        except Exception as error:  # noqa: BLE001 - try again next run
            print(f"[release] {event['name']}: {type(error).__name__}: {error}")
            continue
        label = f"v{event['version']}" if event["version"] else event["name"]
        for m in matches:
            issue = state["issues"][m["issue"]]
            issue.update(status="likely_fixed", fixedIn=label, fixedAt=event["time"], fixedUrl=event["url"], fixReason=m["reason"])
        state["releases"].append(
            {k: event[k] for k in ("gid", "name", "version", "time", "url")} | {"matched": [m["issue"] for m in matches]}
        )
        print(f"[release] {game['name']} {label}: {len(matches)} issue(s) likely fixed")
    state["releases"].sort(key=lambda r: r["time"])


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
        if not issue:
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


def daily_report(index, states, sales=None):
    import notify

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
        new_issues = [i for i in state["issues"].values() if i["created"] >= since]
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
        if still:
            parts.append(f"{len(still)} still happening after a fix")
        line += "\n" + " · ".join(parts)
        days = (sales or {}).get("days") or {}
        if days:
            # Steam's days are Pacific time and settle late, so report the latest day with data.
            latest = max(days)
            t = days[latest].get(str(game["appId"]))
            if t:
                line += f"\n💰 {latest}: ${t.get('net', 0):,.2f} net, {t.get('units', 0)} sold"
                if t.get("returnedUnits"):
                    line += f", {t['returnedUnits']} refunded"
        for issue in sorted(new_issues, key=lambda i: i["priority"], reverse=True)[:3]:
            line += f"\n• New {issue['kind']}: {issue['title']} ({issue['mentions']})"
        lines.append(line)
    if not lines:
        return False
    return notify.send([notify.daily(lines)])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def full_run():
    import triage

    if not triage.DRY_RUN and not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY is not set (add it as a GitHub secret, or set FEEDBACK_DRY_RUN=1 locally)")
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
            events = []
        if game["status"] == "released":
            try:
                ingest_reviews(state, game, run)
            except steam.HttpError as error:
                print(f"[steam] {game['name']} reviews: {error}")
            record_players(state, game)
        import discussions

        discussions.ingest(state, game, run)
        triage_pending(state, game, run, budget)
        refresh_issues(state, game)
        check_releases(state, game, events)
        refresh_issues(state, game)
        send_alerts(state, game, run, first_run)
        # The baseline lasts until the backfill is fully triaged, so old posts never trigger alerts.
        state["initialized"] = not any(i.get("pending") for i in state["items"].values())
        print(
            f"[run] {game['name']}: {len(run['new'])} new, {len(run['edited'])} edited, "
            f"{len(run['flips'])} flipped negative, {len(state['issues'])} issues"
        )
        states[game["appId"]] = state
        if save(path, state):
            changed.append(game["name"])

    import sales as sales_api

    sales = load(DATA / "sales.json", {"highwatermark": "0", "days": {}, "apps": {}})
    if sales_api.sync(sales):
        save(DATA / "sales.json", sales)

    hour = time.gmtime().tm_hour
    today = time.strftime("%Y-%m-%d", time.gmtime())
    last = index.get("dailyReportAt")
    if last and hour >= DAILY_REPORT_HOUR and time.strftime("%Y-%m-%d", time.gmtime(last)) != today:
        if daily_report(index, states, sales):
            index["dailyReportAt"] = now()
    elif not last:
        index["dailyReportAt"] = now()  # first ever run: start counting from here
    save(DATA / "index.json", index)
    save(RUN_STATE, {"lastFullRun": now()})
    print(f"[run] changed: {', '.join(changed) or 'nothing'}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gate", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
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
