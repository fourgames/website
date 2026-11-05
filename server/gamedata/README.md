# Player game data

The server side of the games' data collection, built against [SPEC.md](SPEC.md). The games (through the
`fourgames_data` Godot plugin) send sessions, game actions, hardware, settings and crash reports; players
see, download, opt out of or anonymise theirs on [fourgames.se/privacy](https://fourgames.se/privacy)
after signing in with Steam. It runs as `gamedata.service`: one small Python web server (aiohttp) on
`localhost:8103`, behind Caddy at `https://api.fourgames.se/gamedata/`, with its data in
`/srv/fourgames/gamedata`.

Every route answers with and without the `/gamedata` prefix, so Caddy's `handle` and `handle_path` both
work. Errors are JSON, `{"ok": false, "error": "<code>", "message": "…"}`, with a matching status.

## Routes

| Route | Who | What it does |
| --- | --- | --- |
| `POST /v1/session/start` | the game | Checks the Steam ticket and ownership with Steam, then starts a session: `{"ok": true, "session_id", "token", "opted_out", "upload_every_s", "max_batch_kb", "privacy_url"}`. Opted out (on the server, or `consent.gameplay` false): `opted_out: true`, `session_id` and `token` null, nothing stored. |
| `POST /v1/events` | the game (Bearer token) | One batch, gzip (`Content-Encoding: gzip`) or plain JSON. A repeated `seq` answers `{"ok": true, "duplicate": true}` and isn't stored twice. Events whose `data` is over 32 KB are left out and counted: `{"ok": true, "dropped": 1}`. |
| `POST /v1/session/end` | the game (Bearer) | `seq`, `playtime_s`, `summary`, `active_s`, `idle_s`, `first_session`, `last_scene`, `last_screen`. A second end answers `duplicate`; the first stays. |
| `POST /v1/crash` | the game (Bearer token of the *new* session) | The previous launch's crash. One per session (a retry answers `duplicate`). `crashed_session_id` is only kept if it's the same player's session. |
| `GET /v1/auth/steam?return=/privacy` | the page | Redirects to Steam's sign-in (OpenID 2.0). `return` is a path on the site (`/privacy`, `/ja/privacy`, …, an optional `?query`; no scheme, no `//`). |
| `GET /v1/auth/callback` | Steam | Checks Steam's answer (below), sets the `fg_privacy` cookie and redirects to `https://fourgames.se<return>`. On failure it redirects there with `?signin=failed` (or `?signin=cancelled`), without a cookie. |
| `GET /v1/me` | the page (cookie) | `{"ok": true, "signed_in": false}`, or `signed_in: true` with `opted_out` and `games` (below). |
| `POST /v1/me/optout` | the page | `{"opted_out": true\|false}`; works before a player's first session too. |
| `GET /v1/me/export` | the page | `fourgames-data.zip`: everything stored for the player as JSON, plus a README.txt explaining every field. Streamed from a temporary file; one is built at a time. |
| `POST /v1/me/anonymise` | the page | `{"confirm": true}`: anonymises (below) and clears the cookie. |
| `POST /v1/auth/signout` | the page | Clears the cookie. |
| `POST /v1/internal/lookup` | our tools, on this machine | Game data for public steamids (a Steam review's or discussion post's author), below. |
| `GET /health` (or `/v1/health`) | anyone, the status page | `{"ok": true, "time", "disk": {"used_bytes", "free_bytes", "total_bytes", "low_space"}}` |

Each entry of `games` (in `/v1/me` and the lookup) is one app id, so a player's demo and full game show
as two entries under the same player: `app_id`, `sessions`, `playtime_s` (what the game reported at the
end, or the latest event time for a session without an end), `first_seen` and `last_seen` (unix seconds),
`countries` (ISO codes played from). A game with test sessions (see Test mode) adds `test_sessions` (how
many) and, when every one of them is, `"test": true`. With `GAMEDATA_DEMO_OF`, a demo's entry adds `demo_of` (the game's
app id) and `owns_game` (they've played the full game, or Steam said they own it at a demo session's
start), and the full game's entry adds `played_demo`.

**What the plugin should do with an error:** `401 token_expired` or `bad_token`: start a new session.
`403 opted_out`: stop sending (the player opted out or anonymised since the session started).
`429` and `503` (`rate_limited`, `daily_cap`, `storage_full`) and `502 steam_unavailable`: keep the batch
and retry later (`Retry-After` says when). Any other 4xx (`bad_request`, `bad_event`, `too_large`,
`session_mismatch`, …): the batch will never be taken, drop it.

## Test mode

For trying a game (or the `godot/fourgames_data` test project) against the live server without its
sessions counting as players' data in our tools:

```
GAMEDATA_TEST_APP_IDS=5207970
GAMEDATA_TEST_STEAMIDS=76561198xxxxxxxxx
```

- A session start for an app in `GAMEDATA_TEST_APP_IDS` is checked with Steam as usual (the ticket, and
  that the account owns the game). If the account is one of `GAMEDATA_TEST_STEAMIDS`, the session is
  started and marked test (`sessions.test`; its event batches, hardware, settings and crash reports
  follow their session). Anyone else gets the same `400 unknown_app` an unlisted app gets, with the
  game's switch off too.
- An app in both `GAMEDATA_APP_IDS` and `GAMEDATA_TEST_APP_IDS` takes everyone; only the testers'
  sessions are marked test. `GAMEDATA_APP_IDS` on its own works as before.
- Test sessions are the player's like any other: `/v1/me` counts them (each game adds `test_sessions`,
  and `"test": true` when they all are), the download has them with `"test": true` in `sessions.json`,
  `crashes.json` and their `events/…` files, and opting out, anonymising and the retention treat them
  the same.
- The internal lookup leaves them out (and the hardware, progress, versions and crashes they sent);
  send `"include_test": true` to see them. A player with only test sessions isn't in its answer.
- Databases made before test mode get the column (default 0, not test) when the service starts.

## What's stored, and how

| | Where | Kept |
| --- | --- | --- |
| Players: `pid`, opted out, created, updated | `gamedata.db` | always |
| Sessions: game version and build, engine, platform, language, country and region, boot kind, input device, DLC, the end's numbers and summary, the latest progress event, whether it's a test session | `gamedata.db` | always |
| Hardware (OS, CPU and cores, RAM, GPU and driver, renderer, screen and refresh rate, Steam Deck) and the game's settings, per session | `gamedata.db` | only with `consent.hardware`; any other hardware key (a device id) is dropped |
| Event batches | `raw/<app_id>/<yyyy-mm>/<session_id>/<seq>.json.gz`, indexed in `gamedata.db` | always |
| Crash reports | `crashes/<app_id>/<yyyy-mm>/<crash_id>.json.gz` (log tail, last events), indexed in `gamedata.db` | always |

- **Pseudonymous.** A player is `pid = HMAC-SHA256(GAMEDATA_PEPPER, "steam:" + steamid64)`, first 32 hex
  characters. No steamid is ever stored, and the pepper is only in `/etc/fourgames/gamedata.env`. The files
  never hold a pid: they're keyed by session id, and the sessions table says whose session it is.
- **Country and region** come from the IP at session start, looked up in a local copy of DB-IP's free
  database. Only the country's ISO code and the region's name are kept; the IP itself is never stored or
  logged, not even hashed (the rate limits keep a salted hash in memory only, forgotten at a restart).
- **Anonymising** gives every row of the player (sessions, hardware, settings, batch index, crashes) one
  new random pid, in one transaction, so the data stays grouped but nothing links it to them. The
  player's own pid keeps only the opt-out, and its row's times are reset so they can't point at the data.
  SQLite's `secure_delete` is on, so the old pid doesn't linger in free pages.
- **Nothing is deleted automatically.** Instead, `GAMEDATA_LINK_MONTHS` (24) after a player's last
  session, an hourly job anonymises them the same way, except that their opt-out choice stays as it was:
  if they come back, they start afresh under their own pid. So the disk only grows; `/health` shows how
  full it is, and uploads stop (503 `storage_full`) while less than `GAMEDATA_MIN_FREE_MB` is free.
- The database is SQLite in WAL mode; the event files are written whole or not at all (a temp file renamed
  over it). Uploads of one session are handled one at a time, so a repeated `seq` can't race the first.

## Security

- **Never trust the client.** Every session starts with a Steam Web API ticket
  (`getAuthTicketForWebApi("fourgames-gamedata")`), checked with `ISteamUserAuth/AuthenticateUserTicket`
  (identity `fourgames-gamedata`, the publisher key, on `partner.steam-api.com`). The app id must be in
  `GAMEDATA_APP_IDS` (or `GAMEDATA_TEST_APP_IDS`, for a test account), and the player must own the game: a ticket from their own copy proves it
  (`ownersteamid`), anything else (Steam Family Sharing) is asked with `ISteamUser/CheckAppOwnership`.
- **Session tokens** are signed (HMAC-SHA256 with `GAMEDATA_TOKEN_SECRET`) and hold the session id, pid,
  app id and expiry (24 hours). Each upload must match its token's session, and the player must still be
  opted in.
- **Sign-in:** Steam OpenID 2.0. The callback checks that `claimed_id` is
  `https://steamcommunity.com/openid/id/<17 digits>` (and a real individual account), that `identity`
  matches it, that `op_endpoint` is Steam's, that `return_to` is exactly ours, that Steam signed all of
  those, that the answer is under 10 minutes old, and then always asks Steam itself
  (`openid.mode=check_authentication`). A signed `state` (10 minutes) and a matching `fg_openid` cookie tie
  the answer to the browser that started the sign-in.
- **The cookie** `fg_privacy` holds the pid and an expiry, signed with `GAMEDATA_COOKIE_SECRET`: HttpOnly,
  Secure, SameSite=None, Domain `api.fourgames.se`, 1 hour.
- **CORS and CSRF:** the player routes send `Access-Control-Allow-Origin: https://fourgames.se` and
  `Allow-Credentials: true` (preflights too); every POST must have `Origin: https://fourgames.se` and a JSON
  body (`Content-Type: application/json`).
- **Internal lookup:** only from `127.0.0.1` without an `X-Forwarded-For` (Caddy always adds one, so
  anything through Caddy gets a 404), and only with `X-Internal-Key: GAMEDATA_INTERNAL_KEY`.
- **Size caps:** a session start 64 KB (256 KB unpacked); a batch `GAMEDATA_MAX_BATCH_KB` gzipped (256 KB)
  and 4 MB unpacked, 2,000 events, 32 KB per event's data; a session end 64 KB; a crash 512 KB (2 MB
  unpacked), its log tail 64 KB and 500 events; the page's posts 4 KB. Gzip is unpacked by this code, not
  aiohttp, and stops as soon as it passes the cap, so a small gzip bomb costs nothing.
- **Rate limits** (in memory): session starts 60 an hour per IP and 30 per player; uploads 1,200 per 10
  minutes per IP and 300 per player; crashes 10 an hour per player; the page 120 per 10 minutes per IP,
  sign-ins 20; downloads 5 an hour per player; and at most `GAMEDATA_MAX_MB_PER_DAY` (50) MB of gzipped
  events per player a day.
- **Logs** show the first 8 characters of a pid, counts and sizes: never a steamid, a ticket, an IP, a
  country or what's in an event. aiohttp's access log is off.

## The internal lookup

For our own tools: game data next to a Steam review or discussion post, whose author's steamid is public.

```bash
curl -s localhost:8103/v1/internal/lookup -H "X-Internal-Key: $GAMEDATA_INTERNAL_KEY" \
  -H 'Content-Type: application/json' -d '{"steamids": ["76561198000000001"]}'
```

At most 200 steamids; `"include_test": true` counts test sessions too (left out by default). The answer is `{"ok": true, "players": {"<steamid>": …}}`: players without data
are left out, and opted-out or anonymised players show only `{"opted_out": true}`. Everyone else has
`{"opted_out": false, "games": [...]}`, each game with the fields above plus `last_version`, `crashes`,
`progress` (the data of their latest progress event), `hardware` (the latest, in the shape the game sends
it, or null), `regions` (`[{"country", "region"}]`) and `boot_kinds` (how many sessions of each kind).

## The geo database

Country and region come from DB-IP's free **IP to City Lite** database
([db-ip.com](https://db-ip.com/db/download/ip-to-city-lite)), a local file read with `maxminddb`
(`GEOIP_DB`, by default `/srv/fourgames/gamedata/geo/dbip-city-lite.mmdb`). `gamedata-geo.timer` runs
`python -m gamedata.geoupdate` on the 3rd of each month: it downloads that month's
`dbip-city-lite-YYYY-MM.mmdb.gz` (last month's while the new one isn't out), checks that it opens and
places well-known addresses, and renames it over the old file; the service picks the new file up within
a minute. Without the file, country and region are null and nothing else changes.

**Attribution (required):** DB-IP Lite is licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Wherever its data is shown (the privacy page,
which lists the countries, and the export's README.txt, which already says it), credit it as
*IP Geolocation by [DB-IP](https://db-ip.com)*.

The code: `web.py` (routes, CORS, cookies, the internal lookup, the hourly job), `steam.py` (tickets,
ownership, OpenID), `validate.py` (shape checks), `limits.py` (rate limits, body and gzip caps),
`store.py` (SQLite and files), `export.py` (the zip), `retention.py` (the unlinking), `geo.py` and
`geoupdate.py`, `signing.py` (pids and tokens), `config.py`. Settings are in `gamedata.env.example`.

## On the server

After `feedback-setup.sh` (it makes the `/srv/fourgames/own` checkout and `/etc/fourgames/`):

```bash
ssh fourgames-server
cd /srv/fourgames/own && git pull
uv venv --python 3.13 /srv/fourgames/gamedata-venv && uv pip install --python /srv/fourgames/gamedata-venv/bin/python -r server/gamedata/requirements.txt
install -d -m 700 /srv/fourgames/gamedata
sudo install -m 640 -o root -g fourgames server/gamedata/gamedata.env.example /etc/fourgames/gamedata.env
sudo nano /etc/fourgames/gamedata.env   # four new secrets (openssl rand -hex 32), STEAM_PUBLISHER_KEY,
                                        # GAMEDATA_APP_IDS; keep a copy of GAMEDATA_PEPPER somewhere safe
sudo install -m 644 server/gamedata.service server/gamedata-geo.service server/gamedata-geo.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now gamedata gamedata-geo.timer
sudo systemctl start gamedata-geo       # the first geo database now, not on the 3rd
journalctl -u gamedata -f               # "listening on 127.0.0.1:8103" means it's up
```

The publisher key's group in Steamworks must include the games in `GAMEDATA_APP_IDS` (and their demos).

**Caddy**: the `api.fourgames.se` block in `server/Caddyfile` needs, before any other `/gamedata` route:

```
	# Player game data (server/gamedata). The internal lookup is for this machine only.
	handle /gamedata/v1/internal/* {
		respond 404
	}
	handle /gamedata/* {
		reverse_proxy localhost:8103
	}
```

Then `sudo cp /srv/fourgames/own/server/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`,
and `curl https://api.fourgames.se/gamedata/health` should say `{"ok": true, …}`, while
`curl -X POST https://api.fourgames.se/gamedata/v1/internal/lookup` says 404.

**Backups:** this is the first data that lives only on the server. Back up `/srv/fourgames/gamedata`
(the database with `sqlite3 gamedata.db ".backup …"` while it runs, and the folders) and keep the pepper
apart from the backups.

## Day to day

| | |
| --- | --- |
| Logs | `journalctl -u gamedata -f`, `journalctl -u gamedata-geo` |
| Restart | `sudo systemctl restart gamedata` (needed after a code change or an env change, e.g. a new app id) |
| Disk | `curl -s localhost:8103/health`; uploads stop by themselves at `GAMEDATA_MIN_FREE_MB` free |
| New dependency | `uv pip install --python /srv/fourgames/gamedata-venv/bin/python -r /srv/fourgames/own/server/gamedata/requirements.txt` |
| Tests | `cd server && python -m pytest gamedata/tests` (with pytest and the requirements installed; no network: Steam and the geo database are faked) |
