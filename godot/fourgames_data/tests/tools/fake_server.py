#!/usr/bin/env python3
"""A stand-in for the gamedata server's game endpoints (server/gamedata/SPEC.md),
for tests/tools/live_check.sh: it answers the way the real one does, checks the
token and the gzip, and writes every request it got, body unzipped, to --record.

    python3 -I fake_server.py --port 8765 --record /tmp/record.json
    python3 -I fake_server.py --check /tmp/record.json

--check reads a record back and says whether a whole session arrived: one
/session/start with a hex ticket and an int app_id, gzipped /events whose seq
climbs from 0, and a /session/end, all under the session's own token.
"""
import argparse
import gzip
import json
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
SEEN = []
TOKENS = {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        zipped = self.headers.get("Content-Encoding") == "gzip"
        try:
            body = json.loads(gzip.decompress(raw) if zipped else raw)
        except Exception as error:  # noqa: BLE001 - any bad body is the client's
            return self.reply(400, {"ok": False, "error": "bad_body", "message": str(error)})
        path = self.path.split("/v1", 1)[-1]
        auth = self.headers.get("Authorization", "")
        with LOCK:
            SEEN.append({"path": path, "gzip": zipped, "auth": auth, "body": body, "at": time.time()})
            with open(self.server.record, "w") as out:
                json.dump(SEEN, out, indent=1)
        if path == "/session/start":
            if not isinstance(body.get("ticket"), str) or not body["ticket"]:
                return self.reply(400, {"ok": False, "error": "no_ticket"})
            if not body.get("consent", {}).get("gameplay", False):
                return self.reply(200, {"ok": True, "opted_out": True})
            sid = str(uuid.uuid4())
            TOKENS["tok-" + sid] = sid
            return self.reply(200, {"ok": True, "session_id": sid, "token": "tok-" + sid, "opted_out": False,
                                    "upload_every_s": 10, "max_batch_kb": 256,
                                    "privacy_url": "https://fourgames.se/privacy"})
        token = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""
        if token not in TOKENS:
            return self.reply(401, {"ok": False, "error": "bad_token"})
        if path in ("/events", "/session/end") and body.get("session_id") != TOKENS[token]:
            return self.reply(403, {"ok": False, "error": "wrong_session"})
        if path == "/events" and not zipped:
            return self.reply(415, {"ok": False, "error": "not_gzip"})
        return self.reply(200, {"ok": True})

    def reply(self, code, answer):
        data = json.dumps(answer).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def check(path):
    seen = json.load(open(path))
    problems = []
    starts = [r for r in seen if r["path"] == "/session/start"]
    events = [r for r in seen if r["path"] == "/events"]
    ends = [r for r in seen if r["path"] == "/session/end"]
    if len(starts) != 1:
        problems.append("expected one /session/start, got %d" % len(starts))
    else:
        start = starts[0]["body"]
        if not isinstance(start.get("app_id"), int) or isinstance(start.get("app_id"), bool):
            problems.append("app_id is not an int: %r" % start.get("app_id"))
        try:
            bytes.fromhex(start.get("ticket", ""))
        except ValueError:
            problems.append("the ticket is not hex")
    if not events or not all(r["gzip"] for r in events):
        problems.append("expected gzipped /events, got %d" % len(events))
    seqs = sorted({r["body"]["seq"] for r in events})
    if seqs != list(range(len(seqs))):
        problems.append("event batches' seq does not climb from 0: %r" % seqs)
    if not all(isinstance(r["body"]["seq"], int) for r in events):
        problems.append("seq is not an int")
    if len(ends) != 1:
        problems.append("expected one /session/end, got %d" % len(ends))
    elif ends[0]["body"]["seq"] != len(seqs):
        problems.append("/session/end's seq %r is not the %d batches sent" % (ends[0]["body"]["seq"], len(seqs)))
    sids = {r["body"].get("session_id") for r in events + ends}
    if len(sids) != 1:
        problems.append("batches name %d sessions" % len(sids))
    names = [e.get("name") for r in events for e in r["body"]["events"]]
    print("record: %d requests, %d events (%s)" % (len(seen), len(names), ", ".join(sorted(set(filter(None, names))))))
    for problem in problems:
        print("PROBLEM: " + problem)
    return 1 if problems else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--record")
    parser.add_argument("--check")
    args = parser.parse_args()
    if args.check:
        sys.exit(check(args.check))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.record = args.record
    server.serve_forever()


if __name__ == "__main__":
    main()
