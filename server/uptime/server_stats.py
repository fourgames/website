"""The server's own load for status.fourgames.se: CPU, memory, disk, network now, this month's traffic,
and a watch for floods of traffic (an attack) or plain overload.

Run every minute by uptime-check.service, after check.py. Writes /srv/fourgames/status/server.json.
CPU, network and requests are measured as the change since the last run, so it keeps the previous
counters in a small state file; the month's traffic is added up there too, because the kernel's
counters start over at every reboot. The last hour (per minute) and the last day (requests and
traffic in, for the "normal" level) are kept there as well. Python 3 stdlib only, Linux only.

When the watch changes to busy or attack it tells the staff Discord (DISCORD_WEBHOOK_URL), and again
when it's back to normal. `server_stats.py --test-alert` sends one test message and does nothing else.
"""

from __future__ import annotations

import json
import os
import shutil
import statistics
import sys
import time
import urllib.request
from typing import Callable

STATUS_DIR = os.environ.get("UPTIME_STATUS_DIR", "/srv/fourgames/status")
STATE = os.environ.get("SERVER_STATS_STATE", "/srv/fourgames/uptime/server-stats-state.json")
# The interface the internet goes through (Strato's VPS: ens6). Loopback and the like don't count.
SKIP_INTERFACES = ("lo",)
# Caddy's admin endpoint (only on the server itself); `metrics` in the Caddyfile's global options.
CADDY_METRICS_URL = os.environ.get("CADDY_METRICS_URL", "http://localhost:2019/metrics")
# Where the staff webhook lives when it isn't in the environment (the service unit loads it).
WEBHOOK_ENV_FILE = "/etc/fourgames/feedback.env"

# --- The watch's limits -----------------------------------------------------------------------------
RECENT_MINUTES = 60          # the page's last hour, minute by minute
DAY_MINUTES = 1440           # the "normal" level: the median of the last 24 hours
MIN_NORMAL_MINUTES = 60      # fewer minutes than this known: no normal level yet, the floors apply alone
# A surge: far more requests than usual. A game going viral does this too, with real players whose
# requests get answered, so a surge alone is only busy. An attack is what real players don't do.
SURGE_FACTOR = 4             # four times the usual requests a minute ...
SURGE_FLOOR = 200            # ... and at least ~3 a second, so a quiet night times four isn't a surge
SURGE_MINUTES = 3            # sustained, so one burst (a crawler, a release post) doesn't count
ANSWERED_PCT = 80            # a surge this much answered (2xx/3xx) is worded as real visitors
# Attack: signs real players don't produce.
FLOOD_FACTOR = 10            # a request flood: ten times the usual requests a minute ...
FLOOD_FLOOR = 600            # ... and at least 10 a second ...
FLOOD_ERROR_PCT = 50         # ... with most of them errors (4xx/5xx, including 429 from rate limits)
FLOOD_MINUTES = 3
ATTACK_IN_MBIT = 50          # raw traffic: nothing we run receives this much (game data events are small) ...
ATTACK_IN_MINUTES = 3        # ... for 3 minutes, without a request surge to explain it
ATTACK_SYN_RECV = 200        # half-open connections piling up: a SYN flood (normal is a handful)
# Busy: the server is working hard, whoever it's for.
BUSY_CPU_PCT = 90            # as the page's "nearly full"
BUSY_CPU_MINUTES = 5         # longer than a build or a video conversion spike
MOSTLY_PCT = 60              # one site with this share of the requests is named in the reason
ALERT_COOLDOWN = 30 * 60     # at most one Discord message per state per 30 minutes

OK, BUSY, ATTACK = "ok", "busy", "attack"
PAGE = "status.fourgames.se"
USER_AGENT = "fourgames-server/1.0"


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


def memory_total_gb() -> float:
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemTotal:"):
                return round(int(line.split()[1]) / 1e6, 1)  # kB → GB
    return 0.0


def boot_id() -> str:
    try:
        with open("/proc/sys/kernel/random/boot_id") as f:
            return f.read().strip()
    except OSError:
        return ""


def uptime_seconds() -> float:
    with open("/proc/uptime") as f:
        return float(f.read().split()[0])


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


# --- Requests (Caddy's metrics) ---------------------------------------------------------------------

def parse_metrics(text: str) -> list[tuple[str, dict, float]]:
    """Prometheus text format as (name, labels, value) samples; comments and broken lines are skipped."""
    samples = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            if "{" in line:
                name, rest = line.split("{", 1)
                label_text, value_text = rest.rsplit("}", 1)
                labels = _parse_labels(label_text)
            else:
                name, value_text = line.split(None, 1)
                labels = {}
            value = float(value_text.split()[0])  # a timestamp may follow the value
        except (ValueError, IndexError):
            continue
        samples.append((name.strip(), labels, value))
    return samples


def _parse_labels(text: str) -> dict:
    labels, i, n = {}, 0, len(text)
    while i < n:
        while i < n and text[i] in ", ":
            i += 1
        if i >= n:
            break
        eq = text.index("=", i)
        key = text[i:eq].strip()
        if eq + 1 >= n or text[eq + 1] != '"':
            raise ValueError("label value without quotes")
        j, value = eq + 2, []
        while text[j] != '"':
            if text[j] == "\\":
                j += 1
                value.append({"n": "\n"}.get(text[j], text[j]))
            else:
                value.append(text[j])
            j += 1
        labels[key] = "".join(value)
        i = j + 1
    return labels


def request_counters(samples: list[tuple[str, dict, float]]) -> dict | None:
    """Caddy's request counters since it started: `total`, per `hosts` (with `metrics { per_host }`),
    and `coded` / `errors` (4xx and 5xx) from a `code` label (on caddy_http_requests_total, else on
    caddy_http_request_duration_seconds_count), else None.

    Summed over every server and handler. None when Caddy has no request metrics (metrics not on).
    """
    requests = [(labels, v) for name, labels, v in samples if name == "caddy_http_requests_total"]
    if not requests:
        return None
    hosts: dict[str, float] = {}
    for labels, v in requests:
        if "host" in labels:
            hosts[labels["host"]] = hosts.get(labels["host"], 0) + v
    coded = [(l, v) for l, v in requests if "code" in l]
    if not coded:
        # caddy_http_requests_total has no code label; the duration histogram's _count does, and it
        # counts the same requests.
        coded = [(l, v) for name, l, v in samples if name == "caddy_http_request_duration_seconds_count" and "code" in l]
    return {
        "total": sum(v for _, v in requests),
        "coded": sum(v for _, v in coded) if coded else None,
        "errors": sum(v for l, v in coded if l["code"][:1] in ("4", "5")) if coded else None,
        "hosts": hosts,
    }


def requests_in_flight(samples: list[tuple[str, dict, float]]) -> int | None:
    values = [v for name, _, v in samples if name == "caddy_http_requests_in_flight"]
    return int(sum(values)) if values else None


def request_rates(prev: dict | None, counters: dict | None, now: float) -> dict:
    """Requests a minute, the share of them that were errors and the site most of them went to, from
    the change since the last run.

    Nothing (None) on the first run, without metrics, or when a counter went backwards (Caddy restarted).
    No error share without a `code` label; no site unless one had MOSTLY_PCT of the requests.
    """
    out = {"requestsPerMin": None, "errorPct": None, "mostlyHost": None}
    old = (prev or {}).get("c")
    if not isinstance(old, dict) or counters is None:
        return out
    seconds = now - prev["at"]
    total = counters["total"] - old.get("total", 0)
    if seconds <= 0 or total < 0 or "total" not in old:
        return out
    out["requestsPerMin"] = int(round(total * 60 / seconds))
    if counters["coded"] is not None and old.get("coded") is not None:
        coded, errors = counters["coded"] - old["coded"], counters["errors"] - old["errors"]
        if coded > 0 and errors >= 0:
            out["errorPct"] = round(100 * min(errors, coded) / coded, 1)
    old_hosts = old.get("hosts") or {}
    deltas = {h: v - old_hosts.get(h, 0) for h, v in counters["hosts"].items()}
    if total > 0 and deltas and all(d >= 0 for d in deltas.values()):
        host, top = max(deltas.items(), key=lambda kv: kv[1])
        if top * 100 >= MOSTLY_PCT * total:
            out["mostlyHost"] = host
    return out


def fetch_metrics(url: str = CADDY_METRICS_URL) -> str | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=3) as r:
            return r.read(5_000_000).decode("utf-8", "replace")
    except Exception:
        return None


# --- Connections ------------------------------------------------------------------------------------

TCP_ESTABLISHED, TCP_SYN_RECV = "01", "03"


def count_tcp_states(text: str) -> dict:
    """{state hex: sockets} from /proc/net/tcp or tcp6 text (the 4th column is the state)."""
    counts: dict[str, int] = {}
    for line in text.splitlines()[1:]:
        fields = line.split()
        if len(fields) > 3:
            counts[fields[3]] = counts.get(fields[3], 0) + 1
    return counts


def tcp_connections() -> tuple[int | None, int | None]:
    """(established, half-open SYN_RECV) over IPv4 and IPv6."""
    established = syn = 0
    found = False
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path) as f:
                counts = count_tcp_states(f.read())
        except OSError:
            continue
        found = True
        established += counts.get(TCP_ESTABLISHED, 0)
        syn += counts.get(TCP_SYN_RECV, 0)
    return (established, syn) if found else (None, None)


# --- The last hour and the last day -----------------------------------------------------------------

RECENT_KEYS = ("req", "errPct", "inMbit", "outMbit", "cpuPct", "est", "syn")
DAY_KEYS = ("req", "inMbit")


def push(ring: list, value, gap: int, cap: int) -> list:
    """The ring with this minute's value added, `gap` minutes after its last one: minutes missed in
    between (the server was off) are None, a second run in the same minute replaces the last value."""
    ring = list(ring)
    if gap <= 0 and ring:
        ring[-1] = value
    else:
        ring.extend([None] * min(max(gap - 1, 0), cap))
        ring.append(value)
    return ring[-cap:]


def update_rings(rings: dict, minute: int, values: dict, keys: tuple, cap: int) -> dict:
    """Every ring in `keys` with this minute's value; `minute` is epoch minutes."""
    last = rings.get("minute")
    gap = minute - last if isinstance(last, int) else 1
    out = {"minute": minute}
    for key in keys:
        out[key] = push(rings.get(key, []), values.get(key), gap, cap)
    return out


def median(values: list, minimum: int = MIN_NORMAL_MINUTES):
    known = [v for v in values if v is not None]
    if len(known) < minimum:
        return None
    m = statistics.median(known)
    return int(round(m)) if all(isinstance(v, int) for v in known) else round(m, 2)


# --- The judgement ----------------------------------------------------------------------------------

def sustained(values: list, minutes: int, threshold: float) -> bool:
    """The last `minutes` values all known and at or over the threshold."""
    tail = values[-minutes:]
    return len(tail) == minutes and all(v is not None and v >= threshold for v in tail)


def fmt_int(n) -> str:
    return f"{int(round(n)):,}"


def fmt_mbit(n) -> str:
    return f"{n:.1f}" if n < 10 else fmt_int(n)


# What a host's traffic is, for the reason's "mostly to …" (Caddy's per_host labels).
HOST_NAMES = {
    "api.fourgames.se": "the API (game data, key bot, contact form)",
    "status.fourgames.se": "this status page",
    "_other": "addresses we don't serve (bots, most likely)",
}


def host_name(host: str | None) -> str | None:
    if not host:
        return None
    return HOST_NAMES.get(host, "the short links" if host.endswith(".fourgames.se") else host)


def judge(recent: dict, normal_req, mostly_host: str | None = None) -> tuple[str, list[str]]:
    """ok, busy or attack from the last hour's minutes, with the reasons in plain English.

    A request surge that gets answered is busy (a game going viral looks like this); attack is only
    for what real players don't do: a flood of mostly errors, raw traffic without the requests to
    explain it, or half-open connections piling up.
    """
    req = recent.get("req", [])
    err = recent.get("errPct", [])
    inbit = recent.get("inMbit", [])
    cpu = recent.get("cpuPct", [])
    syn = recent.get("syn", [])
    normally = f" (normally {fmt_int(normal_req)})" if normal_req is not None else ""
    now_req = req[-1] if req and req[-1] is not None else None
    req_text = f"{fmt_int(now_req) if now_req is not None else '?'} requests a minute{normally}"
    where = host_name(mostly_host)
    req_text += f", mostly to {where}" if where else ""
    surge = sustained(req, SURGE_MINUTES, max(SURGE_FACTOR * (normal_req or 0), SURGE_FLOOR))
    now_err = err[-1] if err and err[-1] is not None else None

    attack = []
    if syn and syn[-1] is not None and syn[-1] >= ATTACK_SYN_RECV:
        attack.append(f"{fmt_int(syn[-1])} half-open connections piling up (a SYN flood)")
    if (sustained(req, FLOOD_MINUTES, max(FLOOD_FACTOR * (normal_req or 0), FLOOD_FLOOR))
            and sustained(err, FLOOD_MINUTES, FLOOD_ERROR_PCT)):
        attack.append(f"{req_text}, {fmt_int(now_err)}% of them errors")
    if sustained(inbit, ATTACK_IN_MINUTES, ATTACK_IN_MBIT) and not surge:
        attack.append(f"{fmt_mbit(inbit[-1])} Mbit/s coming in, far more than the requests explain")
    if attack:
        return ATTACK, attack

    busy = []
    if surge:
        if now_err is None:
            answered = ""
        elif now_err < 1:
            answered = ", and it's all being answered"
        elif now_err <= 100 - ANSWERED_PCT:
            answered = f", and {fmt_int(100 - now_err)}% of it is being answered"
        else:
            answered = f", {fmt_int(now_err)}% of it errors"
        busy.append(f"Lots of traffic: {req_text}{answered}")
    if sustained(cpu, BUSY_CPU_MINUTES, BUSY_CPU_PCT):
        busy.append(f"Working hard: CPU at {fmt_int(cpu[-1])}% for {BUSY_CPU_MINUTES} min")
    if busy:
        return BUSY, busy
    return OK, []


# --- Alerts -----------------------------------------------------------------------------------------

def duration_text(seconds: float) -> str:
    minutes = max(1, int(round(seconds / 60)))
    if minutes < 60:
        return f"{minutes} min"
    h, m = divmod(minutes, 60)
    return f"{h} h {m} min" if m else f"{h} h"


def alert_text(state: str, reasons: list[str]) -> str:
    """A warning for an attack; for busy only a note, as it's most likely real visitors."""
    if state == ATTACK:
        return f"⚠️ Unusual traffic on the server: {'; '.join(reasons)}. {PAGE}"
    return f"📈 {'; '.join(reasons)}. {PAGE}"


def recovery_text(announced: str, seconds: float) -> str:
    what = "Traffic is" if announced == ATTACK else "The server is"
    return f"✅ {what} back to normal after {duration_text(seconds)}."


def watch_step(ws: dict, state: str, reasons: list[str], now: float, send: Callable[[str], bool]) -> tuple[dict, dict]:
    """The watch's new state and what server.json says, sending Discord messages as needed.

    A change into busy or attack is announced, at most once per state per ALERT_COOLDOWN; a message
    that fails to send is tried again next minute. Back to ok sends how long it lasted, but only after
    an episode that was announced (so the last message never says "attack" while it's over).
    `ws` holds: state, since (the episode's start), announced (the last state told), sent (when each
    state was last told).
    """
    prev = ws.get("state", OK)
    since = ws.get("since")
    announced = ws.get("announced")
    sent = dict(ws.get("sent") or {})
    if state != OK:
        if prev == OK or since is None:
            since = now  # a new episode (any recovery message still waiting is dropped)
        if announced != state and now - sent.get(state, float("-inf")) >= ALERT_COOLDOWN:
            if send(alert_text(state, reasons)):
                announced = state
                sent[state] = now
        report = {"state": state, "reasons": reasons, "since": int(since)}
    else:
        if announced:
            if send(recovery_text(announced, now - (since if since is not None else now))):
                announced = None
                sent[OK] = now
        if not announced:
            since = None
        report = {"state": OK, "reasons": [], "since": None}
    return {"state": state, "since": since, "announced": announced, "sent": sent}, report


def webhook_url() -> str | None:
    url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if url:
        return url
    try:
        with open(WEBHOOK_ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith("export "):
                    line = line[7:].lstrip()
                key, sep, value = line.partition("=")
                if sep and key.strip() == "DISCORD_WEBHOOK_URL":
                    return value.strip().strip("'\"") or None
    except OSError:
        pass
    return None


def discord_send(text: str) -> bool:
    """Posts to the staff webhook. Never raises, and never prints the URL."""
    url = webhook_url()
    if not url:
        print("Discord alert not sent: no DISCORD_WEBHOOK_URL")
        return False
    request = urllib.request.Request(
        url, data=json.dumps({"content": text}).encode(), method="POST",
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read(1000)
        return True
    except Exception as error:
        code = getattr(error, "code", None)
        print(f"Discord alert failed: {type(error).__name__}{f' {code}' if code else ''}")
        return False


# --- The run ----------------------------------------------------------------------------------------

def write_json(path: str, data) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)


def main() -> None:
    now = time.time()
    month = time.strftime("%Y-%m", time.localtime(now))
    boot = boot_id()
    old = load_state()
    state = old
    if not state:
        # First run ever: when the server booted this month, everything it sent since boot is this
        # month's, so count from boot instead of from now.
        booted = now - uptime_seconds()
        if time.strftime("%Y-%m", time.localtime(booted)) == month:
            state = {"boot": boot, "at": booted, "cpu": [0, 0], "net": [0, 0], "month": month, "monthIn": 0, "monthOut": 0}
    state, measured = step(state, now, cpu_times(), net_bytes(), boot, month)

    metrics_text = fetch_metrics()
    samples = parse_metrics(metrics_text) if metrics_text else []
    counters = request_counters(samples)
    rates = request_rates(old.get("reqCounters") if old.get("boot") == boot else None, counters, now)
    established, syn = tcp_connections()

    minute = int(now) // 60
    values = {"req": rates["requestsPerMin"], "errPct": rates["errorPct"], "inMbit": measured["inMbit"],
              "outMbit": measured["outMbit"], "cpuPct": measured["cpuPct"], "est": established, "syn": syn}
    recent = update_rings(old.get("recent") or {}, minute, values, RECENT_KEYS, RECENT_MINUTES)
    day = update_rings(old.get("day") or {}, minute, values, DAY_KEYS, DAY_MINUTES)
    normal = {"req": median(day["req"]), "inMbit": median(day["inMbit"])}
    watch_state, reasons = judge(recent, normal["req"], rates["mostlyHost"])
    watch_ws, watch = watch_step(old.get("watch") or {}, watch_state, reasons, now, discord_send)

    state.update({
        "reqCounters": {"at": now, "c": counters} if counters is not None else None,
        "recent": recent, "day": day, "watch": watch_ws,
    })
    disk = shutil.disk_usage("/")
    load1 = os.getloadavg()[0]
    report = {
        "checkedAt": int(now),
        "cores": os.cpu_count() or 1,
        "cpuPct": measured["cpuPct"],
        "load1": round(load1, 2),
        "memoryPct": memory_used_pct(),
        "memoryTotalGB": memory_total_gb(),
        "diskTotalGB": round(shutil.disk_usage("/").total / 1e9),
        "diskPct": round(100 * disk.used / disk.total, 1),
        "diskFreeGB": round(disk.free / 1e9, 1),
        "inMbit": measured["inMbit"],
        "outMbit": measured["outMbit"],
        "month": month,
        "monthInGB": round(state["monthIn"] / 1e9, 1),
        "monthOutGB": round(state["monthOut"] / 1e9, 1),
        "requestsPerMin": rates["requestsPerMin"],
        "errorPct": rates["errorPct"],
        "mostlyHost": rates["mostlyHost"],
        "inFlight": requests_in_flight(samples),
        "established": established,
        "synRecv": syn,
        # The last hour, a value a minute, oldest first; endsAt is the last minute's start.
        "recent": {"endsAt": minute * 60, **{k: recent[k] for k in RECENT_KEYS}, "normal": normal},
        "watch": watch,
    }
    write_json(STATE, state)
    write_json(os.path.join(STATUS_DIR, "server.json"), report)


def test_alert() -> int:
    ok = discord_send("🧪 Test message from the server's traffic watch (server_stats.py --test-alert). "
                      f"Nothing is wrong. {PAGE}")
    print("Test alert sent" if ok else "Test alert not sent")
    return 0 if ok else 1


if __name__ == "__main__":
    if "--test-alert" in sys.argv[1:]:
        sys.exit(test_alert())
    main()
