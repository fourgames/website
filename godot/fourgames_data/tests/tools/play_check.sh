#!/bin/sh
# The test game played headless (tests/tools/play_check.tscn) against
# tests/tools/fake_server.py, with the tests' stand-in Steam; then what the
# server got is checked: one whole session with the game's coins, deaths,
# respawns, level completes, settings, snapshots, positions and screens.
#
#   G=/path/to/Godot sh tests/tools/play_check.sh [<project folder>]
set -u
G=${G:?set G to the Godot binary}
PROJECT=$(cd "${1:-.}" && pwd)
TOOLS="$PROJECT/tests/tools"
PORT=${PORT:-8766}
RECORD=$(mktemp -t fourgames_play)
OUT=$(mktemp -t fourgames_play_out)
python3 -I "$TOOLS/fake_server.py" --port "$PORT" --record "$RECORD" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -f "$RECORD" "$OUT"' EXIT
sleep 1
FOURGAMES_DATA_URL="http://127.0.0.1:$PORT/v1" perl -e 'alarm shift; exec @ARGV' 120 \
	"$G" --headless --path "$PROJECT" res://tests/tools/play_check.tscn -- --fake-steam > "$OUT" 2>&1
STATUS=$?
grep "PLAY:\|ERROR\|SCRIPT" "$OUT"
if [ "$STATUS" -ne 0 ] || grep -q "PLAY: FAIL\|SCRIPT ERROR" "$OUT"; then
	echo "play_check: failed (exit $STATUS)"
	exit 1
fi
python3 -I "$TOOLS/fake_server.py" --check "$RECORD" \
	--expect action:coin,death,action:respawn,action:level_complete,setting_changed,snapshot,position,screen,progress,load:boot,perf \
	|| exit 1
echo "play_check: passed"
