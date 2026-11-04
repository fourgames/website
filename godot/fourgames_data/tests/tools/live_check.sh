#!/bin/sh
# The plugin over a real network: starts tests/tools/fake_server.py, runs
# tests/tools/live_check.tscn against it both ways, and checks what arrived.
#
#   G=/path/to/Godot sh tests/tools/live_check.sh [<project folder>]
#
# Exits 0 when both runs passed and the server got a whole session.
set -u
G=${G:?set G to the Godot binary}
PROJECT=$(cd "${1:-.}" && pwd)
TOOLS="$PROJECT/tests/tools"
PORT=${PORT:-8765}
RECORD=$(mktemp -t fourgames_live)
OUT=$(mktemp -t fourgames_live_out)
python3 -I "$TOOLS/fake_server.py" --port "$PORT" --record "$RECORD" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -f "$RECORD" "$OUT"' EXIT
sleep 1
URL="http://127.0.0.1:$PORT/v1"
for MODE in ok blackhole; do
	: > "$RECORD"
	FOURGAMES_DATA_URL=$URL perl -e 'alarm shift; exec @ARGV' 120 \
		"$G" --headless --path "$PROJECT" res://tests/tools/live_check.tscn -- "$MODE" > "$OUT" 2>&1
	STATUS=$?
	grep "LIVE:\|ERROR\|SCRIPT" "$OUT"
	if [ "$STATUS" -ne 0 ] || grep -q "LIVE: FAIL\|SCRIPT ERROR" "$OUT"; then
		echo "live_check: $MODE failed (exit $STATUS)"
		exit 1
	fi
	if [ "$MODE" = ok ]; then
		python3 -I "$TOOLS/fake_server.py" --check "$RECORD" || exit 1
	fi
done
echo "live_check: passed"
