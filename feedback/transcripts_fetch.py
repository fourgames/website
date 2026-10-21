"""Reads the captions of every YouTube video waiting for Claude's review and saves them to
transcripts/<video id>.json in the private data repo on GitHub, for run.py review_videos. YouTube blocks GitHub's
servers from reading captions but not a home connection, so the scheduled task on your Mac runs this
(with the refund notes): no daily limit, and the video's own captions rather than Gemini's listening.
Gemini is only the fallback for a video this hasn't covered after a day and a half (VIDEO_MAC_WAIT).

It reads the game files and writes through the GitHub API (`gh`), so the checkout on this machine is
never touched. youtube-transcript-api is installed in a venv of its own on first run.

    python3 feedback/transcripts_fetch.py
"""

import base64
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = "fourgames/feedback-data"  # private: all the feedback data
VENV = Path.home() / ".cache" / "fourgames-feedback" / "venv"


def ensure_library():
    """Runs this script again inside its own venv, with youtube-transcript-api in it."""
    try:
        import youtube_transcript_api  # noqa: F401
        return
    except ImportError:
        pass
    python = VENV / "bin" / "python"
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
        subprocess.run([str(python), "-m", "pip", "install", "-q", "--disable-pip-version-check", "youtube-transcript-api>=1.2,<2"], check=True)
    os.execv(str(python), [str(python), "-I", __file__, *sys.argv[1:]])


def gh(*args, data=None, raw=False):
    out = subprocess.run(["gh", "api", *args, *(["-H", "Accept: application/vnd.github.raw"] if raw else [])],
                         input=json.dumps(data) if data else None, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(f"gh api {args[-1]}: {out.stderr.strip()[:200]}")
    return out.stdout if raw else json.loads(out.stdout or "null")


def waiting_videos():
    """(video id, language) of each YouTube video no review exists for yet, across your games."""
    index = json.loads(gh(f"repos/{REPO}/contents/index.json", raw=True))
    try:
        have = {f["name"][:-5] for f in gh(f"repos/{REPO}/contents/transcripts")}
    except RuntimeError:
        have = set()  # no transcripts saved yet
    out = []
    for game in index["games"]:
        if game.get("research"):
            continue
        try:
            state = json.loads(gh(f"repos/{REPO}/contents/games/{game['appId']}.json", raw=True))
        except RuntimeError:
            continue
        for v in ((state.get("media") or {}).get("items") or {}).values():
            vid = v["id"][2:]
            if (v["source"] == "youtube" and "review" not in v and not v.get("own") and not v.get("live")
                    and not v.get("upcoming") and vid not in have):
                out.append((vid, v.get("lang")))
    return out


def captions(video_id, lang):
    from youtube_transcript_api import YouTubeTranscriptApi, _errors

    try:
        tracks = list(YouTubeTranscriptApi().list(video_id))
    except _errors.CouldNotRetrieveTranscript:
        return None
    # Uploaded captions over generated ones, the video's language first.
    tracks.sort(key=lambda t: (not (lang and t.language_code.split("-")[0] == lang.split("-")[0]), t.is_generated))
    if not tracks:
        return None
    try:
        return [[round(s.start), s.text] for s in tracks[0].fetch() if s.text.strip()]
    except _errors.CouldNotRetrieveTranscript:
        return None


def main():
    ensure_library()
    saved, missing = 0, 0
    for vid, lang in waiting_videos():
        lines = captions(vid, lang)
        if not lines:
            missing += 1  # no captions (yet): Gemini covers it later
            continue
        body = {"message": "Add a video transcript",
                "content": base64.b64encode((json.dumps({"lines": lines}, ensure_ascii=False) + "\n").encode()).decode()}
        gh("-X", "PUT", f"repos/{REPO}/contents/transcripts/{vid}.json", "--input", "-", data=body)
        saved += 1
    print(f"{saved} transcript(s) saved" + (f"; {missing} video(s) have no captions yet" if missing else ""))


if __name__ == "__main__":
    main()
