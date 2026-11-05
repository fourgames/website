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
