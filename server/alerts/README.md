# Push alerts

Makes the Discord announcements of your own channels (new YouTube videos, YouTube live streams,
Twitch streams; `feedback/announce.py`) near-instant. Before, the feedback loop checked every 5
minutes; now YouTube and Twitch tell the server the moment something's new, and it starts the same
check about 30 seconds later, and again 2 minutes after that. It runs as `alerts.service`, a small
Python web server on `localhost:8102` behind Caddy at `https://api.fourgames.se/alerts/`.

| From | How | Route |
| --- | --- | --- |
| YouTube | [WebSub](https://developers.google.com/youtube/v3/guides/push_notifications): the channel's feed, subscribed at Google's hub, renewed every 2.5 days (a subscription lasts 5) | `GET /youtube` (the hub's check), `POST /youtube` (signed `X-Hub-Signature`) |
| Twitch | [EventSub webhooks](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/): `stream.online` for `fourgamesab`, made at start if it isn't there yet, checked every 6 hours | `POST /twitch` (signed `Twitch-Eventsub-Message-Signature`) |
| You | `curl https://api.fourgames.se/alerts/health` | `GET /health`: the subscriptions, the last push and the last check |

Each route also answers without the `/alerts` prefix, so Caddy's `handle` and `handle_path` both work.

## Never twice

This service never posts. A push only starts `feedback/announce.py --push`, the very check the loop
runs, as its own process with the loop's interpreter (fresh code after each `git pull`):

- **One check at a time.** `announce.run()` holds a lock (`flock` on `feedback/.cache/announce.lock`)
  around reading the state, checking and saving, for the loop's checks and the pushed ones alike. The
  second one waits, then starts from what the first saved, so it sees the video as posted. The lock
  goes with the process, so a crashed or stopped check never leaves it held.
- **The data stays the loop's.** A pushed check saves to `feedback/.cache/announced-pending.json`, not
  to `data/announced.json`: the loop pulls the data repo before each run and commits after it, and a
  file changed in between would stop that pull. The loop's next check (within 5 minutes) starts from
  the pending file when there is one and moves it over `data/announced.json`, which it commits as
  before. The newest state is always in one of the two files, even if a check stops halfway.
- **Pushes come more than once.** Twitch resends a message it isn't sure arrived (the message id is
  remembered and a repeat only acknowledged), YouTube sends a notification for each change to a video,
  and pushes close together share their checks. Any extra check finds nothing new.
- **Push down, loop on.** If this service stops, a subscription lapses or a push never comes (a
  scheduled YouTube stream going live doesn't always send one), the loop's check every 5 minutes posts
  it as before.

So switching back to GitHub Actions (server/README.md) means stopping this service too: GitHub's runs
don't see the pending file.

Unsigned or wrongly signed messages do nothing (YouTube's are acknowledged anyway, as WebSub asks;
Twitch's get 403, as do Twitch messages older than 10 minutes). The hub's subscription check is only
answered for our own channel's feed, and only right after we asked, so no one else can swap the
subscription's secret.

The code: `youtube.py`, `twitch.py`, `checks.py` (planning the checks and running `announce.py`),
`web.py` (routes, health), `config.py`. Settings are in `alerts.env.example`.

## Setup

After `feedback-setup.sh` (it makes the `/srv/fourgames/own` checkout, the loop's venv and
`/etc/fourgames/feedback.env` with `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`), and once the loop
runs a version of `feedback/run.py` that takes the pending file over (it pulls `main` every 5 minutes):

```bash
ssh fourgames-server
cd /srv/fourgames/own && git pull
uv venv --python 3.13 /srv/fourgames/alerts-venv && uv pip install --python /srv/fourgames/alerts-venv/bin/python -r server/alerts/requirements.txt
sudo install -m 640 -o root -g fourgames server/alerts/alerts.env.example /etc/fourgames/alerts.env
sudo nano /etc/fourgames/alerts.env   # YOUTUBE_WEBSUB_SECRET and TWITCH_EVENTSUB_SECRET: openssl rand -hex 32, one each
```

**Caddy** first, since YouTube and Twitch check the callbacks the moment the service subscribes. The
`api.fourgames.se` block in `server/Caddyfile` needs:

```
	handle /alerts/* {
		reverse_proxy localhost:8102
	}
```

then `sudo cp /srv/fourgames/own/server/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`. Then:

```bash
sudo install -m 644 server/alerts.service /etc/systemd/system/alerts.service
sudo systemctl daemon-reload && sudo systemctl enable --now alerts
journalctl -u alerts -f    # "subscribed for 120 hours" (YouTube) and "subscribed to stream.online" (Twitch)
curl https://api.fourgames.se/alerts/health   # youtube.subscribed true, twitch.subscription "enabled"
```

If Caddy wasn't ready, YouTube tries again every 15 minutes, and a Twitch subscription that failed its
check is made again within 5 minutes.

## Day to day

| | |
| --- | --- |
| Logs | `journalctl -u alerts -f` (the check's own output, `[announce] …`, is there too) |
| Restart | `sudo systemctl restart alerts` (it waits for a running check first) |
| Code changes | the check is always the checkout's current `announce.py`; for a change in `server/alerts` itself, restart |
| New dependency | `uv pip install --python /srv/fourgames/alerts-venv/bin/python -r /srv/fourgames/own/server/alerts/requirements.txt` |
| Tests | `cd server && python -m pytest alerts/tests` (with pytest and aiohttp; no network) |
| Off | `sudo systemctl disable --now alerts`: the loop alone posts within 5 minutes, as before |
