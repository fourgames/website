#!/usr/bin/env bash
# Sends one prepared video to Steam over RTMP, on repeat, forever. Run by steam-broadcast@<name>.service
# with /etc/fourgames/broadcast/<name>.env (STEAM_RTMP_URL, STEAM_STREAM_KEY, VIDEO).
# The video is already in Steam's format (prepare.sh on the Mac), so ffmpeg only copies it: next to no
# CPU, which matters on a 1-core server. The stream key never reaches the log: ffmpeg's messages go
# through sed, which blanks it out.
set -euo pipefail

: "${STEAM_RTMP_URL:?missing in the env file}" "${STEAM_STREAM_KEY:?missing in the env file}" "${VIDEO:?missing in the env file}"
[ -r "$VIDEO" ] || { echo "can't read the video $VIDEO" >&2; exit 1; }

key=$STEAM_STREAM_KEY
url="${STEAM_RTMP_URL%/}/$key"
# -re: send at playback speed (a live feed, not a file upload). -stream_loop -1: start over at the end.
ffmpeg -hide_banner -nostdin -loglevel warning -re -stream_loop -1 -i "$VIDEO" -c copy -f flv "$url" 2>&1 \
  | sed -u "s|${key//|/\\|}|<stream key>|g" >&2
exit "${PIPESTATUS[0]}"
