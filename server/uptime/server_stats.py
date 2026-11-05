"""The server's own load for status.fourgames.se: CPU, memory, disk, network now, and this month's traffic.

Run every minute by uptime-check.service, after check.py. Writes /srv/fourgames/status/server.json.
CPU and network are measured as the change since the last run, so it keeps the previous counters in a
small state file; the month's traffic is added up there too, because the kernel's counters start over
at every reboot. Python 3 stdlib only, Linux only.
"""

from __future__ import annotations

import json
import os
import shutil
import time

STATUS_DIR = os.environ.get("UPTIME_STATUS_DIR", "/srv/fourgames/status")
STATE = os.environ.get("SERVER_STATS_STATE", "/srv/fourgames/uptime/server-stats-state.json")
# The interface the internet goes through (Strato's VPS: ens6). Loopback and the like don't count.
SKIP_INTERFACES = ("lo",)


def cpu_times() -> tuple[int, int]:
    """(busy, total) jiffies over all cores, from the first line of /proc/stat."""
    with open("/proc/stat") as f:
        parts = [int(x) for x in f.readline().split()[1:]]
    idle = parts[3] + (parts[4] if len(parts) > 4 else 0)  # idle + iowait
    return sum(parts) - idle, sum(parts)


def net_bytes() -> tuple[int, int]:
    """(received, sent) bytes over every real interface since boot."""
    rx = tx = 0
    with open("/proc/net/dev") as f:
        for line in f.readlines()[2:]:
            name, data = line.split(":", 1)
            if name.strip() in SKIP_INTERFACES:
                continue
            fields = data.split()
            rx += int(fields[0])
            tx += int(fields[8])
    return rx, tx


def memory_used_pct() -> float:
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            key, value = line.split(":", 1)
            info[key] = int(value.split()[0])
    total, available = info["MemTotal"], info.get("MemAvailable", info["MemFree"])
    return round(100 * (total - available) / total, 1)


def boot_id() -> str:
    try:
        with open("/proc/sys/kernel/random/boot_id") as f:
            return f.read().strip()
    except OSError:
        return ""


def load_state() -> dict:
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def step(state: dict, now: float, cpu: tuple[int, int], net: tuple[int, int], boot: str, month: str) -> tuple[dict, dict]:
    """The new state and the measured numbers, from the previous state and this run's counters.

    Pure, so it can be tested: a new boot (counters back at zero) or a first run measures nothing yet
    and adds nothing to the month; a new month starts its totals at zero.
    """
    prev = state if state.get("boot") == boot else {}
    measured = {"cpuPct": None, "inMbit": None, "outMbit": None}
    month_in, month_out = (state.get("monthIn", 0), state.get("monthOut", 0)) if state.get("month") == month else (0, 0)
    if prev:
        busy, total = cpu[0] - prev["cpu"][0], cpu[1] - prev["cpu"][1]
        if total > 0:
            measured["cpuPct"] = round(100 * busy / total, 1)
        seconds = now - prev["at"]
        d_in, d_out = net[0] - prev["net"][0], net[1] - prev["net"][1]
        if seconds > 0 and d_in >= 0 and d_out >= 0:
            measured["inMbit"] = round(d_in * 8 / seconds / 1e6, 2)
            measured["outMbit"] = round(d_out * 8 / seconds / 1e6, 2)
            month_in += d_in
            month_out += d_out
    new_state = {"boot": boot, "at": now, "cpu": list(cpu), "net": list(net),
                 "month": month, "monthIn": month_in, "monthOut": month_out}
    return new_state, measured


def main() -> None:
    now = time.time()
    month = time.strftime("%Y-%m", time.localtime(now))
    state, measured = step(load_state(), now, cpu_times(), net_bytes(), boot_id(), month)
    disk = shutil.disk_usage("/")
    load1 = os.getloadavg()[0]
    report = {
        "checkedAt": int(now),
        "cores": os.cpu_count() or 1,
        "cpuPct": measured["cpuPct"],
        "load1": round(load1, 2),
        "memoryPct": memory_used_pct(),
        "diskPct": round(100 * disk.used / disk.total, 1),
        "diskFreeGB": round(disk.free / 1e9, 1),
        "inMbit": measured["inMbit"],
        "outMbit": measured["outMbit"],
        "month": month,
        "monthInGB": round(state["monthIn"] / 1e9, 1),
        "monthOutGB": round(state["monthOut"] / 1e9, 1),
    }
    for path, data in ((STATE, state), (os.path.join(STATUS_DIR, "server.json"), report)):
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)


if __name__ == "__main__":
    main()
