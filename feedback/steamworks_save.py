"""Saves the Steamworks report pages read by steamworks.js (a file holding the page text the task read:
the JSON, then a line "END") as steamworks.json in the private data repo, through the GitHub API (`gh`),
so the checkout on this machine is never touched. The dashboard's Steam stats view shows it. Run by the
scheduled task on your Mac.

    python3 feedback/steamworks_save.py page.txt
"""

import base64
import json
import subprocess
import sys
import time

REPO = "fourgames/feedback-data"  # private: all the feedback data
PATH = "steamworks.json"


def gh(*args, data=None):
    out = subprocess.run(["gh", "api", *args], input=json.dumps(data) if data else None, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(f"gh api {args[-1]}: {out.stderr.strip()[:200]}")
    return json.loads(out.stdout or "null")


def main(path):
    text = open(path).read()
    # The page text: anything get_page_text puts before the JSON, the JSON, then "END".
    start, end = text.find("{"), text.rfind("END")
    if start < 0 or end < 0:
        raise SystemExit("No Steamworks stats in the file: the page wasn't finished (it ends with END).")
    read = json.loads(text[start:end].strip())
    if not read.get("apps"):
        raise SystemExit("No games were read: is Chrome signed in to partner.steampowered.com?")
    data = {**read, "read": int(time.time())}
    try:
        sha = gh(f"repos/{REPO}/contents/{PATH}")["sha"]
    except RuntimeError:
        sha = None  # the first save
    body = {"message": "Update Steamworks stats",
            "content": base64.b64encode((json.dumps(data, ensure_ascii=False, indent=1) + "\n").encode()).decode()}
    if sha:
        body["sha"] = sha
    gh("-X", "PUT", f"repos/{REPO}/contents/{PATH}", "--input", "-", data=body)
    pages = sum(len(a["pages"]) for a in read["apps"].values())
    print(f"Steamworks stats saved: {len(read['apps'])} apps, {pages} pages")


if __name__ == "__main__":
    main(sys.argv[1])
