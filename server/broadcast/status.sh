#!/usr/bin/env bash
# Writes /srv/fourgames/status/broadcast.json for status.fourgames.se: every broadcast set up in
# /etc/fourgames/broadcast/ and whether its service is sending. Run every minute by
# steam-broadcast-status.timer.
set -euo pipefail
out=${BROADCAST_STATUS_FILE:-/srv/fourgames/status/broadcast.json}
python3 - "$out" <<'PY'
import glob, json, os, subprocess, sys, time
streams = []
for path in sorted(glob.glob("/etc/fourgames/broadcast/*.env")):
    name = os.path.basename(path)[:-4]
    unit = f"steam-broadcast@{name}.service"
    show = subprocess.run(["systemctl", "show", unit, "--property=ActiveState,ActiveEnterTimestampMonotonic,UnitFileState"],
                          capture_output=True, text=True).stdout
    props = dict(line.split("=", 1) for line in show.splitlines() if "=" in line)
    if props.get("UnitFileState") != "enabled":
        continue  # set up but switched off on purpose: not shown
    up_for = 0
    if props.get("ActiveState") == "active":
        mono = int(props.get("ActiveEnterTimestampMonotonic") or 0) / 1e6
        up_for = max(0, int(time.clock_gettime(time.CLOCK_MONOTONIC) - mono))
    streams.append({"name": name, "sending": props.get("ActiveState") == "active", "upForSeconds": up_for})
tmp = sys.argv[1] + ".tmp"
with open(tmp, "w") as f:
    json.dump({"checkedAt": int(time.time()), "streams": streams}, f)
os.replace(tmp, sys.argv[1])
PY
