# The Steam data collector

Records Steam market data every day, from now on: history that can't be fetched later (review counts,
prices and discounts, player counts, release dates moving). It runs on the server as
`steamdata.service`: one Python process (standard library only) that asks Steam's official
endpoints for one thing at a time, slowly, and writes everything to one SQLite file,
`/srv/fourgames/steamdata/steam.db`. Once a day `steamdata-market.timer` works out what the
dashboard's Market section shows from it (trends and alerts, Steam's growth, the gap finder, the hit
index, the Godot finder and leads): see *The Market numbers*.

Only official Steam endpoints and PCGamingWiki's public API, nothing scraped (no SteamDB: its terms
forbid it). The data is for our own analysis: don't republish it (see *Using the data*).

## What it collects

| What | From | How often |
| --- | --- | --- |
| Every game on the store (id, name, last change) | `IStoreService/GetAppList` (Web API key) | changed apps every 6 hours, the whole list daily |
| **The daily snapshot** of every game: review count, % positive and score, price, discount, user tags, release date (and coming soon / early access), platforms, Steam Deck rating, developers, publishers | `IStoreBrowseService/GetItems`, 100 games per request | once per UTC day, from 00:05 |
| Players right now | `ISteamUserStats/GetNumberOfCurrentPlayers` | from hourly to monthly, by how many play (below) |
| Full metadata: genres, languages, age rating, controller support, Metacritic, achievements, DLC count, demos, the store's release-date text | store `api/appdetails` | new games first (newest first), then every 30 days |
| User tag names | `IStoreService/GetTagList` | weekly |
| Which games are made with Godot | PCGamingWiki, and the store text above | weekly / with the metadata |

Only games: the app list asks for games only, and anything the snapshot or metadata says isn't a
game (DLC, demo, soundtrack, tool...) is dropped from collection. Review texts are never fetched or
stored, only the totals.

Review counts come from the snapshot, which is the store's own summary: the count the store page
shows (all languages, review bombs filtered out) and the percent positive, rounded. So the positive
and negative counts in the `daily` view are estimates, within half a percent of the total. (The
store's `appreviews/<appid>?json=1` endpoint, which has exact counts, redirected to the store front
when this was written, and fetching it for every game daily would be 150,000 requests a day.)

### Player counts

| Players at the last sample | Most games | The Godot set |
| --- | --- | --- |
| 100 or more | every 4 hours | every hour |
| 10 to 99 | every 12 hours | every hour |
| 1 to 9 | every day | every 2 hours |
| nobody (or no count) | 2 days, then 4, 8, 16, at most 30 | every 6 hours |
| released in the last 14 days | at least every 4 hours | every hour |
| coming soon | not sampled; starts the day it's released | |

Each gap varies by ±10%, so samples move around the clock instead of always hitting the same hour.
A game in the slow lane that gains reviews in the daily snapshot is sampled again right away. The
first sample of a newly found game waits by its review count (1,000+: now, 100+: within the hour,
10+: 6 hours, 1+: a day, none: 3 days), so the first pass over the whole store starts with the games
people play. Each day's highest sample goes in `app_daily.players_peak`.

## The budget

Each host has its own limiter: a fixed gap between requests, and on a 429 (or the store's 403) a
pause (1 minute on the Web API, 5 on the store, doubling while it goes on), then 50% slower, back
to normal step by step after 200 good requests. 5xx and timeouts wait 10 s, 20 s, 40 s... and an item
that fails 3 times is tried again later (an hour; a day for metadata). The `http_log` table counts
requests, throttles and failures per host per day, so the real limits show up there over time.
Lanes sharing a host take turns in a fixed order (the daily snapshot before player counts), and
when there's more due than the budget allows, the most overdue goes first, so cadences stretch
evenly instead of the pace going up.

The numbers below assume what Steam looks like: about 150,000 games, ~2,500 with 100+ players at
any time, ~7,000 with 10-99, ~15,000 with 1-9, ~700 released in the last 14 days, and a Godot set of
~10,000 (since SteamDB's list; ~1,500 of them with anyone playing). `python -m steamdata.stats` shows the real counts and the backlog after the first week.

**api.steampowered.com**, `WEBAPI_PER_MINUTE=60`: at most 86,400 a day; the Steam Web API terms
allow 100,000.

| | requests a day |
| --- | --- |
| App list (10,000 apps per page) | ~25 |
| Daily snapshot, 150,000 games / 100 | 1,500 |
| Player counts: 2,500 × 6 + 7,000 × 2 + 15,000 × 1 + ~125,000 nobody / ~25 days + new releases ~4,000 + Godot set: ~100 × 24 + ~400 × 12 + ~1,000 × 6 + ~8,500 nobody / ~5 days | ~70,000 |
| **Total** | **~71,500** (~50 a minute) |

**store.steampowered.com/api/appdetails**, `APPDETAILS_PER_5MIN=120` (Steam allows about 200): at
most 34,560 a day. The first pass over 150,000 games takes about 4.5 days, newest first. After that:
every game every 30 days (~5,000 a day) plus new games and fresh releases: about 15% of the budget.

**www.pcgamingwiki.com**, one request per 10 s, weekly: one request lists the pages linking
Engine:Godot (259 in November 2026), and only new or edited pages are read, 20 per request. The first
pass is 14 requests; after that a handful a week.

**The first day**: the app list (~20 requests), then the snapshot of every game (~25 minutes), then
player counts start (a first sample of all 150,000 games takes about two days at the pace above,
popular games first) while the metadata pass runs alongside on its own host.

## Storage

Measured with 180,000 made-up games: a daily row is ~25 bytes, a player sample ~17-23 bytes, an app
~600 bytes.

| | rows a year | size a year |
| --- | --- | --- |
| `app_daily` (~150,000 games with reviews or a price, every day) | 55 million | ~1.4 GB |
| `players` (~65,000 samples a day) | 24 million | ~0.5 GB |
| `apps`, `app_changes`, the rest | | ~0.1-0.2 GB |
| **Total** | | **~2 GB a year** |

`SAMPLES_KEEP_DAYS=400` keeps the raw samples to about 0.5 GB (the daily peaks stay). The WAL file
stays under 64 MB. Each write is one short transaction, so a crash loses at most the request in
flight; what's due next is stored with each game, so a restart carries on where it stopped (the app
list even mid-list, page by page). Measured: ~8 ms to write a 100-game snapshot, 0.2 ms per player
sample, ~70 MB of memory, a few KB/s of network (a few hundred MB a day, gzipped).

## The tables

| Table | What's in it |
| --- | --- |
| `apps` | One row per app: the latest of everything (see the comments in `db.py`), and when each fetch is due |
| `app_daily` | One row per game per UTC day (`day` = days since 1970: `date(day * 86400, 'unixepoch')`): reviews, % positive, score, price, original price (while discounted), discount, players peak. Only days with something to record. |
| `players` | Every player-count sample (appid, unix time, players) |
| `app_changes` | What changed between snapshots or metadata fetches: release date, coming soon → released, name, developers, tags, Steam Deck rating, platforms, genres, languages, hidden, gone from the app list |
| `engine_signals` | Engine hints per game (below) |
| `pcgw_pages` | The PCGamingWiki pages read, so unchanged ones aren't read again |
| `tags`, `genres`, `categories` | Names for the ids in `apps` |
| `http_log` | Requests per day and host: ok, throttled, failed, bytes |

Views for reading: `daily` (dates, names, estimated positive and negative counts), `player_samples`
(readable times), `godot_games` (the Godot set with where it came from). Prices are in cents of the
`COUNTRY` currency (US dollars); 0 is free, NULL not for sale.

## Engines: which games are Godot

Steam doesn't say which engine a game uses, so `engine_signals` collects public hints, each with a
source, a strength (2 = stated, 1 = only mentioned) and the evidence:

- **pcgamingwiki**: the game's PCGamingWiki infobox lists Godot (2), or the page only links Godot
  elsewhere, e.g. "open source reimplementation in Godot" (1). PCGamingWiki's Cargo queries are only
  for signed-in users, so the collector uses two plain MediaWiki API queries instead: the pages
  linking Engine:Godot, then their wikitext. It adds Godot games the app list doesn't have.
- **store_legal / store_text**: the store's legal notice names an engine, or the description says
  "made with Godot", "Godot Engine", "Godot 4" and the like (2). This scans the appdetails reply the
  metadata pass fetches anyway, so it costs nothing; only the match is kept. It also notes Unity,
  Unreal, GameMaker, RPG Maker and Ren'Py the same way, for comparisons.
- **manual**: added by hand:

  ```bash
  cd /srv/fourgames/own/server && /srv/fourgames/steamdata-venv/bin/python -c "
  import time; from steamdata.db import Store
  s = Store('/srv/fourgames/steamdata/steam.db'); s.add_manual_signal(1942280, 'godot', 'the developer said so', time.time()); s.close()"
  ```

- **steamdb**: SteamDB's Godot list, copied by hand from your own browser (2). SteamDB knows
  the engine from each game's file list (Godot games ship a `.pck`), so it has far more than the
  sources above. Nothing here visits SteamDB: you open the page, and a bookmarklet copies the app
  ids of the games on it. For the internal dashboard only; don't publish numbers built on it.

  1. Once: make a bookmark in your browser with this as its address:

     ```
     javascript:(()=>{const s=new Set();document.querySelectorAll('tr[data-appid]').forEach(r=>s.add(r.dataset.appid));document.querySelectorAll('table a[href*="/app/"]').forEach(a=>{const m=a.getAttribute('href').match(/\/app\/(\d+)/);if(m)s.add(m[1])});const t=[...s].join('\n');navigator.clipboard.writeText(t).then(()=>alert(s.size+' app ids copied'),()=>prompt('Copy these:',t))})()
     ```

  2. Open [steamdb.info/tech/Engine/Godot](https://steamdb.info/tech/Engine/Godot/), show all
     rows (or sort by release date for just the recent ones), and click the bookmark.
  3. On the Mac, with the ids on the clipboard:

     ```bash
     pbpaste | ssh fourgames-server 'cd /srv/fourgames/own/server && /srv/fourgames/steamdata-venv/bin/python -m steamdata.importids godot steamdb'
     ```

  It only adds (a shorter list later doesn't remove anyone), games we didn't know become stub
  apps the snapshot fills in, and the dashboard shows "SteamDB" as the evidence. Again every month
  or so, with the newest games.

A game with any strength-2 Godot signal is in the **Godot set** (`apps.godot = 1`) and gets player
counts most often. A new source only has to write `engine_signals` rows and call
`Store.refresh_godot()`.

Ideas for more, not built (none downloads game files):

- **A PCGamingWiki account** (made by us, with a bot password) would allow Cargo queries: every
  game's engine field in a few requests, for all engines, not just the pages linking Godot.
- **Steam's PICS app info** (what the Steam client reads, anonymously): launch options and
  executable names, and depot manifests list file names, where Godot games show `.pck` files. That
  is how SteamDB knows. It means speaking the Steam client protocol (SteamKit / ValvePython), so
  read Valve's terms first.
- **Curated lists**: Godot's showcase (godotengine.org/showcase), the "Made with Godot" Steam curator,
  community lists on GitHub: imported by hand as `manual`, or a source of their own.
- **Developers**: a studio with one Godot game often makes the next one in Godot too (a weak
  signal, from `apps.developers`).

## The Market numbers

`python -m steamdata.market` (`market.py`, run daily at 03:00 UTC by `steamdata-market.timer`, after
the snapshot) reads steam.db read-only and writes five gzipped JSON files to `MARKET_DIR`
(`/srv/fourgames/steamdata/market`). The game-data API hands them to the signed-in owner
(`GET /v1/admin/market/<name>`, server/gamedata/admin.py), and the dashboard's **Market** entry
(src/lib/feedback/market.js) does the rest in the browser. Nothing here is public. About 10 seconds
and 250 MB, once a day.

| File | What | Used by |
| --- | --- | --- |
| `overview` | when it was built, how much history, counts, tag and genre names | everything |
| `growth` | releases (and those releases' reviews) per year since 2006 and per month for six years, for Steam and each tag and genre; and Steam's users online at the peak, for *new games vs Steam's players* | Growth |
| `games` | every game released in the last three years, one compact row: price, reviews, % positive, first 10 tags, flags (Linux, Mac, Deck, Early Access, Godot, demo, self-published), languages, hit index, reviews gained in 7 and 28 days, most players seen | Gap finder, Hit index |
| `godot` | the Godot set with everything the finder scores on, the studio's other games, the publisher's size and the engine evidence | Godot finder, Leads |
| `upcoming` | games coming soon with a date in the next 18 months (or a demo out), any engine: tags, flags, the studio's released games and best one's reviews, the outside publisher's catalog size | Scouting before release |
| `trends` | each tag's momentum, and the alerts | Trends |

Definitions (also under *How this works* in each view):

- **A game is a tag** when the tag is one of its first 5 user tags (the strongest).
- **Hit index**: a game's review count as a percentile among every game released within 7 days of it,
  with or without reviews; so games are only compared with games of the same age.
- **Trends**, per tag with 15+ releases in the last 90 days: *supply* (its share of releases now
  against the same 90 days a year ago), *hit rate* (the share of its games released 14–180 days ago
  with hit index 90+, against all new games; pulled toward Steam's rate by 30 made-up average
  games, so a tag with a handful of games and a few hits can't top the list) and *reviews* (its share of all new reviews in the
  latest 7 or 28 days against the window before; needs 14 days of history). *Heat* is their
  geometric mean.
- **Self-published**: no publisher besides the developers.
- **Alerts**: a tag with heat 2+ that both grows and hits (the 8 hottest a day at most); an indie breakout (hit index 99 within 30
  days of release, under $30, 300+ reviews or 100+ this week); a self-published Godot game taking off (hit index
  90+ within 90 days and 30+ reviews, or 30+ reviews this week). Each is noted once in
  `alerts-state.json` (a tag again after 30 days); the very first run only notes what's there.
  New ones go to Discord when `MARKET_DISCORD_WEBHOOK` is set in `/etc/fourgames/steamdata.env`.
- **Steam's users**: the most logged in at once. Before the server measured it, Steam's all-time
  record as of each year's end, as the press reported it (`USER_RECORDS` in market.py, with sources;
  SteamDB's charts can't be used, its terms forbid scraping). From November 2026 the daily job also
  reads Steam's own stats feed (`store.steampowered.com/stats/userdata.json`, the last 48 hours, one
  request a day) and keeps each whole UTC day's peak in `MARKET_DIR/steam-users.json`; a period uses
  that when it's higher than the record. Like steam.db it can't be fetched again: back it up with it.
- **Revenue** (in the browser): reviews × sales per review (30 by default, adjustable) × the game's
  price × 0.5 (Steam's cut, VAT, refunds, discounts). A rough guide, not sales data.

Install, once (after `git pull` in `/srv/fourgames/own`):

```bash
sudo install -m 644 /srv/fourgames/own/server/steamdata-market.service /srv/fourgames/own/server/steamdata-market.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now steamdata-market.timer
sudo systemctl start steamdata-market && journalctl -u steamdata-market -n 5   # "market files built in ..."
sudo systemctl restart gamedata                                                 # for the new route
```

Test the dashboard locally against a copy: build the files from a copy of steam.db, unzip them into
`<dir>/market/<name>.json` next to an `index.json` of `{"games":[]}`, serve `<dir>` with CORS, and open
`/fb-dash?data=<that url>#app=market`.

## Using the data

- Steam: the Steam Web API Terms of Use (among other things, at most 100,000 calls a day). The
  store endpoints are used at a slow pace, the way the store itself uses them.
- PCGamingWiki: CC BY-NC-SA 3.0. Fine for our own analysis; publishing anything built from it
  needs attribution, non-commercial use and the same licence, so don't.
- So: analyses and decisions from this data, yes; republishing the data or lists made from it, no.

## The Web API key

`IStoreService/GetAppList` needs a key (the old keyless `ISteamApps/GetAppList` is gone: 404). The
key only goes to that method, about 25 times a day.

The server's `STEAM_PUBLISHER_KEY` would work: Valve's docs say publisher keys can call public
methods as well as publisher ones (as long as its IP allowlist includes the server). But it's the
key to our sales data, so keep it to the feedback loop and give this an ordinary key: sign in to
Steam, [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey), domain `fourgames.se`
(Steam only gives keys to accounts that have spent at least $5). Without a key the collector still runs,
on the games already in the database plus PCGamingWiki's.

## On the server

After `feedback-setup.sh` (it makes the `/srv/fourgames/own` checkout and `/etc/fourgames/`):

```bash
ssh fourgames-server
cd /srv/fourgames/own && git pull
uv venv --python 3.13 /srv/fourgames/steamdata-venv   # nothing to install: standard library only
install -d -m 750 /srv/fourgames/steamdata
sudo install -m 640 -o root -g fourgames server/steamdata/steamdata.env.example /etc/fourgames/steamdata.env
sudo nano /etc/fourgames/steamdata.env                # STEAM_WEB_API_KEY (see above)
# A half-minute trial into a throwaway database: the app list, then a few snapshot batches.
cd /srv/fourgames/own/server
( set -a; . /etc/fourgames/steamdata.env; set +a
  DB_PATH=/tmp/steamdata-trial.db /srv/fourgames/steamdata-venv/bin/python -m steamdata --max-requests 30 --lanes applist,snapshot
  DB_PATH=/tmp/steamdata-trial.db /srv/fourgames/steamdata-venv/bin/python -m steamdata.stats )
rm -f /tmp/steamdata-trial.db*
sudo install -m 644 /srv/fourgames/own/server/steamdata.service /etc/systemd/system/steamdata.service
sudo systemctl daemon-reload && sudo systemctl enable --now steamdata
journalctl -u steamdata -f                            # "app list (full): ... apps" means it's up
```

## Day to day

| | |
| --- | --- |
| Logs | `journalctl -u steamdata -f` (a summary every 10 minutes; warnings when a host pushes back) |
| What's in it, what's due | `cd /srv/fourgames/own/server && /srv/fourgames/steamdata-venv/bin/python -m steamdata.stats` |
| Restart | `sudo systemctl restart steamdata` (it carries on where it stopped) |
| Code changes | the feedback loop pulls `/srv/fourgames/own` every 5 minutes, but the collector runs what it started with: restart it after a change |
| Pace | `WEBAPI_PER_MINUTE`, `APPDETAILS_PER_5MIN` in `/etc/fourgames/steamdata.env`, then restart |
| Backup | one file, and history that can't be fetched again: add it to the backups when they exist. While it runs: `sqlite3 /srv/fourgames/steamdata/steam.db ".backup /path/steam-backup.db"` |
| Disk | ~2 GB a year (see *Storage*); `SAMPLES_KEEP_DAYS` trims the raw player samples |
| Market numbers | `sudo systemctl start steamdata-market` builds them now; `journalctl -u steamdata-market` |
| Tests | `cd server && python -m pytest steamdata/tests` (with pytest; no network) |

The code: `collector.py` (the lanes and the loop), `steam.py` (Steam's endpoints and replies),
`pcgw.py` (PCGamingWiki), `engine.py` (engine hints), `market.py` (the Market numbers), `cadence.py` (how often), `importids.py` (hand-copied engine lists), `db.py` (the
schema and writes), `limiter.py`, `net.py` (HTTP), `stats.py`, `config.py`. Settings are in
`steamdata.env.example`.
