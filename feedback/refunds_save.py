"""Merges refund notes read by refunds.js (a JSON file, the argument) into refunds.json in the private
data repo on GitHub, through the GitHub API (`gh`), so the checkout on this machine is never touched. Notes are only
ever added: each keeps when it was first seen. Each package's lifetime counts (units sold, returned,
refunded, refunds per reason) are replaced by the newest read. Run by the scheduled "refund notes" task on your Mac.

    python3 feedback/refunds_save.py notes.json
"""

import base64
import hashlib
import json
import subprocess
import sys
import time

REPO = "fourgames/feedback-data"  # private: all the feedback data
PATH = "refunds.json"


def gh(*args, data=None):
    out = subprocess.run(["gh", "api", *args], input=json.dumps(data) if data else None, capture_output=True, text=True)
    if out.returncode:
        raise SystemExit(f"gh api {args[0]}: {out.stderr.strip()}")
    return json.loads(out.stdout or "null")


def note_id(package, note):
    key = "|".join([package, note["category"] or "", note["date"] or "", note["text"]])
    return hashlib.sha1(key.encode()).hexdigest()[:12]


def main(path):
    read = json.loads(open(path).read())
    if isinstance(read, str):  # the page script returns a JSON string
        read = json.loads(read)
    if not read:
        raise SystemExit("No refund pages were read: is Chrome signed in to Steamworks?")
    try:
        current = gh(f"repos/{REPO}/contents/{PATH}")
        sha, data = current["sha"], json.loads(base64.b64decode(current["content"]))
    except SystemExit:
        sha, data = None, {"packages": {}}
    added = 0
    for package, info in read.items():
        entry = data["packages"].setdefault(package, {"name": info["name"], "notes": {}})
        entry["name"] = info["name"]
        for key in ("reasons", "sold", "returned", "refunded"):
            if info.get(key) is not None:
                entry[key] = info[key]
        # Steamworks' page script changes how arrays become JSON: a list can arrive as a string.
        notes = json.loads(info["notes"]) if isinstance(info["notes"], str) else info["notes"]
        for note in notes:
            nid = note_id(package, note)
            if nid not in entry["notes"]:
                entry["notes"][nid] = {**note, "seen": int(time.time())}
                added += 1
    data["read"] = int(time.time())
    body = {"message": "Update refund notes", "content": base64.b64encode((json.dumps(data, ensure_ascii=False, indent=1) + "\n").encode()).decode()}
    if sha:
        body["sha"] = sha
    gh("-X", "PUT", f"repos/{REPO}/contents/{PATH}", "--input", "-", data=body)
    print(f"{added} new refund note(s); {sum(len(p['notes']) for p in data['packages'].values())} in all")


if __name__ == "__main__":
    main(sys.argv[1])
