# Player game data: the contract

The one document the four parts build against: the server (`server/gamedata`), the Godot plugin
(`fourgames_data`, built and tested on its own in `godot/fourgames_data/`, then added to the unreleased games; not to the released ones), and the privacy page on fourgames.se. Change it here first if a part needs something different. The server's exact fields and replies
(new event types, `/v1/me` extras, the lookup) are in `server/gamedata/README.md`, which wins over
this file where they differ.

## Goals and rules

- Collect a lot, for one purpose: **improving the games and fixing bugs**. Sessions, detailed game
  actions (enough to replay a session), performance per scene, boot times, input device, active vs idle
  time, where players stop, settings changes, owned DLC, demo → full game, hardware and settings,
  country and region, and crash reports. Only in games whose Steam page links the policy; not the
  released ones.
- **On by default, opt-out on the web:** on fourgames.se/privacy (Steam sign-in, works on a phone
  without the game). The
  opt-out lives on the server per Steam account, and the game learns it at every session start.
- **Pseudonymous storage:** the server never stores a raw SteamID next to game data. A player is
  `pid = HMAC-SHA256(PEPPER, "steam:" + steamid64)` (hex, first 32 chars). The pepper lives only in
  `/etc/fourgames/gamedata.env`. The same steamid always gives the same pid, so sign-in finds a
  player's data without a lookup table.
- **Players' rights:** see a summary, download everything (JSON in a zip), opt out / back in, and
  **anonymise**: every row of that pid gets a random new pid that nothing links to any more, and the
  player is marked opted out. After that the player can't download that data any more (it's no longer
  theirs to find), which the page says before they confirm.
- **Retention:** everything stays linked to the pid for 24 months after the player's last session
  (`GAMEDATA_LINK_MONTHS`); then a job anonymises that player automatically (same as anonymise:
  a fresh random id, no link back) and keeps the data. Nothing is deleted automatically.
- **Country and region:** derived at session start from the IP with a local DB-IP Lite database;
  only country + region are stored, the IP is never stored or logged.
- **Never trust the client:** every session starts with a Steam Web API auth ticket that the server
  checks with Steam. Size caps, rate limits, and schema checks on everything.

## Server: `https://api.fourgames.se/gamedata/v1`

Python 3.13 aiohttp service `gamedata` on `127.0.0.1:8103`; Caddy routes `/gamedata/*` to it (the
service accepts paths with or without the `/gamedata` prefix). Errors are JSON
`{"ok": false, "error": "<code>", "message": "..."}` with proper status codes.

### Game endpoints (the plugin calls these)

**`POST /v1/session/start`** (JSON)
```json
{
  "app_id": 5207970,
  "ticket": "<hex from Steam.getAuthTicketForWebApi(\"fourgames-gamedata\")>",
  "game_version": "1.0.2", "build_id": "26413834", "godot_version": "4.7.0",
  "platform": "windows", "locale": "en",
  "consent": {"gameplay": true, "hardware": true},
  "hardware": { "os": "Windows 11", "cpu": "...", "cpu_cores": 8, "ram_mb": 16384,
                "gpu": "...", "gpu_driver": "...", "renderer": "forward_plus",
                "screen": [2560, 1440], "refresh_hz": 144, "steam_deck": false },
  "settings": { "...": "game-specific, flat key → scalar" },
  "previous_crash": null
}
```
The server verifies the ticket with `ISteamUserAuth/AuthenticateUserTicket` (identity
`fourgames-gamedata`, the publisher key from `STEAM_PUBLISHER_KEY`) and checks `app_id` is one of
`GAMEDATA_APP_IDS` and that the player owns it (`ownersteamid` / `ISteamUser/CheckAppOwnership`).
Reply:
```json
{ "ok": true, "session_id": "<uuid4>", "token": "<signed, 24 h>", "opted_out": false,
  "upload_every_s": 60, "max_batch_kb": 256, "privacy_url": "https://fourgames.se/privacy" }
```
If the player opted out (server-side) or `consent.gameplay` is false: `opted_out: true`, no session
is created, and the plugin stores nothing and sends nothing until the next launch.
`hardware`/`settings` are stored only when `consent.hardware` is true.

**`POST /v1/events`** (`Authorization: Bearer <token>`, body gzip JSON, `Content-Encoding: gzip`)
```json
{ "session_id": "...", "seq": 12, "events": [
    {"t": 12.345, "type": "action", "name": "plant_seed", "data": {"x": 3, "y": 7, "crop": "carrot"}},
    {"t": 15.0, "type": "snapshot", "data": {"...": "small game-state summary"}},
    {"t": 20.1, "type": "progress", "data": {"day": 4, "coins": 120}}
] }
```
`t` = seconds since session start (game time, unpaused). `seq` starts at 0 per session and makes
uploads idempotent (a repeat `seq` returns ok without storing twice). Types: `action` (a player
action, named by the game), `snapshot` (state every ~30 s, for replay), `progress` (how far they
are), `rng` (seed changes), `error` (non-fatal script errors), `custom`. Max 256 KB gzipped per
batch, 2000 events per batch.

**`POST /v1/session/end`** (Bearer) `{"session_id": "...", "seq": 40, "playtime_s": 1834, "summary": {...}}`

**`POST /v1/crash`** (Bearer token from the *new* session, sent at the next launch)
```json
{ "crashed_session_id": "<the old session id, if it had one>", "game_version": "...",
  "log_tail": "<last ≤64 KB of the game's log>", "last_events": [ ... up to 500 ... ],
  "signal": "SIGSEGV or 'unclean exit'", "os": "..." }
```

### Player endpoints (the privacy page calls these, with a cookie)

- `GET /v1/auth/steam?return=/privacy` → redirect to Steam OpenID 2.0
  (`https://steamcommunity.com/openid/login`, `openid.mode=checkid_setup`, return_to
  `https://api.fourgames.se/gamedata/v1/auth/callback`). `return` must be a path on fourgames.se.
- `GET /v1/auth/callback` → verifies with Steam (`openid.mode=check_authentication`), reads the
  steamid from `openid.claimed_id`, sets cookie `fg_privacy` (signed, HttpOnly, Secure,
  SameSite=None, Domain `api.fourgames.se`, 1 h), redirects to `https://fourgames.se<return>`.
- `GET /v1/me` → `{"ok":true,"signed_in":true,"opted_out":false,"games":[{"app_id":..,"sessions":..,"playtime_s":..,"first_seen":..,"last_seen":..}]}`
  (`signed_in:false` without a valid cookie).
- `POST /v1/me/optout` `{"opted_out": true|false}`
- `GET /v1/me/export` → `application/zip` with everything stored for that pid (sessions, events,
  hardware, settings, crashes) as JSON, plus a README.txt explaining the fields.
- `POST /v1/me/anonymise` `{"confirm": true}` → anonymises (see above), clears the cookie.
- `POST /v1/auth/signout`.
CORS: `Access-Control-Allow-Origin: https://fourgames.se`, `Allow-Credentials: true`; POSTs also
require `Origin: https://fourgames.se` (CSRF) and JSON bodies.

### Internal lookup (the feedback loop and dashboards, localhost only)

`POST /v1/internal/lookup` with header `X-Internal-Key: <GAMEDATA_INTERNAL_KEY>`, only from
127.0.0.1 (Caddy answers 404 for `/gamedata/v1/internal/*` from outside): `{"steamids": [...]}` (max
200) → each player's per-game summary, so a Steam review or discussion post can be shown next to its
author's game data. Opted-out or anonymised players return only `{"opted_out": true}`.

## The Godot plugin: `addons/fourgames_data`

An autoload `GameData` the game calls; it never breaks the game (every failure is silent and logged).
- `GameData.start(app_id, settings_dict)` after Steam is up; `GameData.action(name, data)`,
  `GameData.progress(data)`, `GameData.snapshot(data)`, `GameData.set_setting(key, value)`,
  `GameData.opted_out() -> bool`, `GameData.set_opt_out(bool)` (optional, for a game that wants a switch),
  `GameData.PRIVACY_URL`.
- Steam through `Engine.get_singleton("Steam")` only (a build without GodotSteam must still parse).
  Ticket via `getAuthTicketForWebApi("fourgames-gamedata")` and its `get_ticket_for_web_api` signal.
- Queue to disk (`user://fourgames_data/queue/`), upload every `upload_every_s` and at quit, retry
  with backoff, drop the oldest when the queue passes 20 MB. Offline play works and uploads later.
- Crash detection: writes `user://fourgames_data/running.json` at start and removes it on a clean
  quit; also keeps the last 500 events in a ring file. If `running.json` is there at the next launch,
  it sends `/v1/crash` with Godot's log tail (`user://logs/godot.log`) and the ring.
- Hardware/settings from `OS`, `RenderingServer`, `DisplayServer`; Steam Deck from
  `Steam.isSteamRunningOnSteamDeck()`. Only what finding hardware-specific bugs needs: OS, CPU model
  and cores, GPU and driver, RAM, screen and refresh, renderer, Steam Deck, the game's settings. Never
  serial numbers, MAC addresses, `OS.get_unique_id()` or other device identifiers.
- Off in debug runs, tests and the editor unless `FOURGAMES_DATA_DEV=1`, and the base URL is
  overridable for testing.

## The privacy page: `fourgames.se/privacy`

The policy in plain language (all five site languages) and, below it, "Your data": sign in with Steam,
then see the summary, opt out / in, download, anonymise (with a confirm). Linked from the footer and each
game's Steam store page; an in-game link is optional. Controller: Danny Karlsson (sole trader until Four Games AB
exists), contact privacy@ → set up as an alias of danny@ (or support@ until then).
