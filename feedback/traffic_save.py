"""Store traffic from Steamworks' Traffic Breakdown page (read by traffic.js in your Chrome) into
traffic.json in the private data repo, through the GitHub API (`gh`), so the checkout on this machine is
never touched. Run by the scheduled task on your Mac, in two steps:

    python3 feedback/traffic_save.py --plan     prints the days to read, {appId: [day, …]}, for traffic.js
    python3 feedback/traffic_save.py page.txt   merges what traffic.js read (the page text: JSON, then END)

The games are the ones on your partner account (steamworks.json, read by steamworks.js). Each run reads
the last RECENT days again (Steam can still add to them) and fills in up to FILL older days per game, back
to BACK days. traffic.json: {read, apps: {appId: {days: {"YYYY-MM-DD": {cols, rows: [[source, numbers…]]}}}}}.
"""

import base64
import datetime
import json
import subprocess
import sys
import time

REPO = "fourgames/feedback-data"  # private: all the feedback data
PATH = "traffic.json"
RECENT = 3
FILL = 30
BACK = 120


def gh(*args, data=None, raw=False):
    head = ["-H", "Accept: application/vnd.github.raw"] if raw else []
    out = subprocess.run(["gh", "api", *head, *args], input=json.dumps(data) if data else None, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(f"gh api {args[-1]}: {out.stderr.strip()[:200]}")
    return out.stdout if raw else json.loads(out.stdout or "null")


def current():
    """(sha, data) of traffic.json, or (None, empty) before the first save. Read raw: it can pass 1 MB."""
    try:
        sha = gh(f"repos/{REPO}/contents/{PATH}")["sha"]
    except RuntimeError:
        return None, {"apps": {}}
    return sha, json.loads(gh(f"repos/{REPO}/contents/{PATH}", raw=True))


def plan(apps, have, today):
    """{appId: [days]}: the last RECENT full days, any of the last 14 that read no table, and up to FILL
    older missing days, newest first. Today isn't over, so it's never read."""
    out = {}
    for app in apps:
        days = (have.get(app) or {}).get("days") or {}
        want = []
        for back in range(1, BACK + 1):
            day = (today - datetime.timedelta(days=back)).isoformat()
            if back <= RECENT or day not in days or (back <= 14 and days[day].get("missing")):
                want.append(day)
        recent, older = want[:RECENT], want[RECENT:]
        out[app] = recent + older[:FILL]
    return out


def merge(data, read):
    """Adds the days read; a day read again replaces the old one. Returns how many days were saved."""
    saved = 0
    for app, got in (read.get("apps") or {}).items():
        days = data["apps"].setdefault(app, {"days": {}})["days"]
        for day, value in (got.get("days") or {}).items():
            # A failed read doesn't replace a good one.
            if value.get("missing") and day in days and not days[day].get("missing"):
                continue
            days[day] = value
            saved += 1
    data["read"] = int(time.time())
    return saved


def main(arg):
    sha, data = current()
    if arg == "--plan":
        stats = json.loads(gh(f"repos/{REPO}/contents/steamworks.json", raw=True))
        apps = sorted(stats.get("apps") or {})
        if not apps:
            raise SystemExit("No games in steamworks.json yet: read the Steamworks stats first.")
        print(json.dumps(plan(apps, data["apps"], datetime.date.today())))
        return
    text = open(arg).read()
    start, end = text.find("{"), text.rfind("END")
    if start < 0 or end < 0:
        raise SystemExit("No traffic in the file: the page wasn't finished (it ends with END).")
    read = json.loads(text[start:end].strip())
    if not read.get("apps"):
        raise SystemExit("No games were read: is Chrome signed in to partner.steamgames.com?")
    saved = merge(data, read)
    missing = sum(1 for a in read["apps"].values() for d in a["days"].values() if d.get("missing"))
    body = {"message": "Update store traffic",
            "content": base64.b64encode((json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode()).decode()}
    if sha:
        body["sha"] = sha
    gh("-X", "PUT", f"repos/{REPO}/contents/{PATH}", "--input", "-", data=body)
    print(f"Store traffic saved: {saved} day(s) for {len(read['apps'])} game(s)"
          + (f"; {missing} day(s) had no table with visits (did the page change?)" if missing else ""))


if __name__ == "__main__":
    main(sys.argv[1])
