# Uptime history

The 90 days of bars on [status.fourgames.se](https://status.fourgames.se). The page itself checks each
part live from the visitor's browser; this keeps the history, checked from the server instead.

Every minute `uptime-check.timer` runs `check.py` once (the system `python3`, standard library only).
It checks every part the way the page does, through the public URLs so Caddy and HTTPS are covered:

| Part | Up | Degraded | Down |
| --- | --- | --- | --- |
| Website | `https://fourgames.se/` answers 200 within 10 s | | anything else |
| Player feedback, Research | the loop's report (`/srv/fourgames/status/<part>.json`) says the last run was good and recent | late, or the last run failed | no run within the late limit, or no report |
| Key bot, contact form, alerts, game data | `/<part>/health` answers `ok: true` | alerts: YouTube or Twitch not connected; game data: disk nearly full | not answering, or not `ok` |
| Steam broadcasts | every stream sending | some | none |
| Short links | `https://discord.fourgames.se/` answers with a redirect | | anything else |

The limits are the same as in `status-page/status.js`. Steam broadcasts aren't counted at all while
no stream is set up, or while their own status (`broadcast.json`) is over 10 minutes old.

## Install

```bash
sudo install -d -o fourgames -g fourgames /srv/fourgames/uptime
sudo cp /srv/fourgames/own/server/uptime-check.service /srv/fourgames/own/server/uptime-check.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uptime-check.timer
```

Code changes need nothing: the feedback loop pulls the checkout every 5 minutes, and the next run
uses them. A changed unit file is copied again, then `sudo systemctl daemon-reload`.

## The data

- `/srv/fourgames/uptime/uptime.db` (SQLite): per part and local day (Europe/Stockholm) the minutes
  up, degraded and down; the outages (a run of minutes not up, with the worst state in it); the last
  minute counted per part. 100 days are kept.
- `/srv/fourgames/status/history.json`, written after every run and served at
  `https://api.fourgames.se/status/history.json`: the last 90 days (`days`, oldest first, today last)
  and per part `uptime` (minutes not down out of minutes checked, rounded down to two decimals;
  degraded counts as up; `null` without data), `daily` (`[up, degraded, down]` minutes per day, `null`
  for a day without data) and `outages` (the 50 newest, newest first; `end` is `null` while it lasts).

Logs: `journalctl -u uptime-check` (a line only for minutes when something isn't up).
Tests: `python -m pytest -q server/uptime/tests`.

## The Server row

`server_stats.py` runs right after `check.py` (same timer) and writes `/srv/fourgames/status/server.json`:
CPU and network as the change since the last run, memory, disk, and the traffic sent and received
this month (added up in `/srv/fourgames/uptime/server-stats-state.json`, since the kernel's counters
start over at every reboot). The status page shows it as meters in the *Server* row. One Steam
broadcast is about 4.7 Mbit/s and 1.5 TB a month of *Sent*.

## The traffic watch

The same run also watches for the server being flooded (an attack) or just busy, and tells the two
apart: a game going viral brings lots of real requests that get answered, an attack brings what real
players don't. Each minute `server_stats.py` records the requests a minute (from Caddy's metrics at
`http://localhost:2019/metrics`, turned on by `metrics { per_host }` in the Caddyfile's global
options), the share of them that were errors (4xx/5xx, only when `caddy_http_requests_total` has a
`code` label), the site most of them went to, traffic in and out, CPU, and the open TCP connections
(established, and half-open `SYN_RECV`, from `/proc/net/tcp` and `tcp6`). The last hour goes into
`server.json` as `recent`, with the normal level: the median of the last 24 hours of requests and
traffic in. `watch` in `server.json` is the judgement (the limits are constants at the top of
`server_stats.py`):

| State | When |
| --- | --- |
| attack | 200 or more half-open connections (a SYN flood); requests a minute at 10 × normal and at least 600 for 3 minutes with half or more of them errors (429 from rate limits included); or 50 Mbit/s or more coming in for 3 minutes without a request surge to explain it |
| busy | a request surge: 4 × normal and at least 200 a minute for 3 minutes, mostly answered or with no error counts (a game going viral looks like this); or CPU at 90% or more for 5 minutes |
| ok | anything else |

The status page shows busy as *Delayed* and attack as *Down* in the Server row, with the reason,
and a sparkline of the last hour's requests.

A change into busy or attack posts to the staff Discord (`DISCORD_WEBHOOK_URL` from
`/etc/fourgames/feedback.env`, which the service unit loads): busy as a note ("📈 Lots of
traffic: …"), attack as a warning ("⚠️ Unusual traffic on the server: …"), and the way back to
normal with how long it lasted; at most one message per state per 30 minutes. Try it once with
`server_stats.py --test-alert` (it reads the webhook from the env file when it isn't in the
environment, if that file is readable).

Caddy counts a request once for each route or handler it passes, so the requests a minute can be
higher than the real number of requests; the normal level is counted the same way, so the
comparison holds. Strato's network may filter large attacks before they reach the server at all;
the watch only sees what gets through.
