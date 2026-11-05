# The key bot

Hands out Steam keys in the Four Games Discord. It runs on the server as `keybot.service`: one
Python process with the Discord bot and a small web server for creator verification on
`localhost:8100`, behind Caddy at `https://api.fourgames.se/keybot/`.

There are three commands: `/claim` and `/request` for everyone, `/keys …` for the team.

| Who | Command | What happens |
| --- | --- | --- |
| YouTube members (the **YouTube Member** role from Discord's YouTube integration, or a game's own roles) | `/claim game:` | The key shows up in the reply, which only they can see, with a Steam link that fills it in (`store.steampowered.com/account/registerkey?key=…`). A copy goes by DM as a receipt; if their DMs are closed they still get the key, and the reply says so. One key per game per person by default, for good: lapsing and rejoining doesn't give another. Non-members get a link to [join](https://www.youtube.com/@FourGamesAB/join). |
| Everyone | `/claim` (no game) | Only to them: the public games with keys left (keys per person, keys left, which roles can claim them), then their own keys with a Steam link each. Pages of 10 lines, and a menu of the games they can claim right now. |
| Content creators | `/request game: type:creator` | A one-time **Verify your channel** link (15 minutes). They sign in with Discord, which shows us their *verified* YouTube and Twitch connections. A YouTube channel with 1,000+ subscribers and an upload in the last 60 days, or a Twitch channel with 500+ followers, gets the key by DM at once; anything else goes to the admin channel. |
| Press | `/request game: type:press` | Opens a short form (outlet and work email, both required), then goes to the admin channel. The email isn't checked yet; once the company mail exists, the bot could send a confirmation link first. |
| The team (Manage Server, or the `ADMIN_ROLE_ID` role) | `/keys status [game:] [count:]` | Per game: keys left, given out by reason (member, creator, press, manual), open requests, settings and Steam app id; then the latest handouts (10 by default, up to 25 with `count:`): who, which game, why, and the key's id (never the key). With `game:`, only that game. |
| | `/keys add file: game:` / `/keys add file: name: [steam_app_id:]` | Adds keys from a .txt (one per line) or .csv (finds the key column itself, e.g. a Steamworks download) to a game the bot has (`game:`), or adds a new game with them (`name:`, and its Steam app id if you have it). Skips keys it already has and says how many it added. |
| | `/keys grant game: user:` | One key to that person by DM (also from private games). Keeps to the game's per-person limit and refuses banned people. If their DMs are closed, no key is used and you're told. |
| | `/keys grant game: role:` | One key by DM to everyone with the role, after a confirmation that shows how many people have it, how many can get one and how many keys are left. Skips the banned and those at the limit, and says how many got one. Give `user:` or `role:`, not both. `role:` is refused unless `GRANTROLE_ENABLED=1` (see below). |
| | `/keys game game: [public:] [per_user_limit:] [add_role:] [remove_role:] [clear_roles:] [steam_app_id:] [export:]` | Shows a game's settings, or changes them (see below). `export:True` also sends that game's unclaimed keys as a .txt, one per line, only to you; the keys stay in the bot. |
| | `/keys find user:` / `key:` | Every key someone got (ids, games, and the keys themselves, only to you) and their bans; or who has a key (by the key or `#id`). |
| | `/keys ban action:ban user: [game:]` / `action:unban user: [game:]` | Stops (or lets again) someone getting keys for one game, or every game without `game:`: no `/claim`, `/request`, `/keys grant` or approval. Keys they already have stay theirs. |
| | `/keys ban action:list [game:]` | Every ban, or the ones that apply to a game (its own and the every-game ones). |

Discord only shows `/keys` to people with **Manage Server** (its default permission). If the team
has the `ADMIN_ROLE_ID` role instead, let that role see it under *Server Settings → Integrations →
Four Games → /keys*. The bot checks every `/keys` command itself either way.

On every start the bot replaces the server's command list with these three, so commands from older
versions (`/mykeys`, `/pools`, `/request-press`, `/grant`, `/grantrole`) and the old `/keys` subcommands
(`games`, `log`, `settings`, `grant-role`, `lookup`, `export`, `unban`, `bans`) disappear by themselves. It
only uses server commands; if it finds global ones (it never made any), it removes them.

### Per-game settings

Each game has three settings, changed with `/keys game` (with no changes it just shows them, and its
Steam app id, which `steam_app_id:` sets):

- **Public / private** (`public:`, default public). Private games aren't in `/claim`; the team hands them
  out with `/keys grant` (to a user or a role) or by approving a request. `/keys status` lists them.
- **Keys per person** (`per_user_limit:`, 0 to 300, default 1; 0 means no limit). It counts every key of
  that game the person has, whatever the reason. Lowering it doesn't take keys back.
- **Roles that can claim it** (`add_role:`, `remove_role:`, `clear_roles:`). Any one of the roles is
  enough. With none set, the `MEMBER_ROLE` setting decides, as before.

### /keys grant role: and the Server Members intent

`/keys grant role:` needs the list of everyone with a role, which Discord only gives a bot with the privileged
**Server Members Intent**. It's off by default, so the bot asks for no privileged intents. To turn it on:
Developer Portal → the application → **Bot** → *Privileged Gateway Intents* → **Server Members Intent**
on and save; then `GRANTROLE_ENABLED=1` in `/etc/fourgames/keybot.env` and restart the bot. (With the
setting on but the intent off in the portal, the bot can't log in.) The `role:` option is always there,
but until it's on the bot answers that it's turned off.

Requests in the admin channel are cards with the person, their channels and numbers, why it wasn't
approved by itself, and **Approve** / **Deny** buttons that keep working after a restart. Approve
DMs the key (the DM is the only way it reaches them there, so if their DMs are closed no key is used
and the request stays open); Deny DMs a polite no. Each person can have 3 requests waiting at a time.
A request nobody answers closes by itself after 14 days (`REQUEST_EXPIRE_DAYS`, 0 = never): the
person gets a polite DM without a reason, the card says it closed and loses its buttons, and the
slot is free again. The bot checks once an hour.
The admin channel also hears when a game drops below 5 keys (`LOW_STOCK`), when it's down to 10% of
all the keys imported for it, and when it runs out: each once, until the game gets more keys.

Everything is in one SQLite file, `/srv/fourgames/keybot/keys.db`: games, keys (with who got each,
when and why), requests, verify links and bans. A handout is one write transaction that checks bans
and the per-person limit and takes the key under the same lock, so two claims at the same moment
can't get the same key or go over the limit. The logs show key ids, never keys. A database from an
older version is updated in place when the bot starts (new settings get their defaults; nothing is
lost).

The code: `bot.py` (commands, buttons, handouts), `web.py` (the verify login), `db.py`,
`admin.py` (the command line for the server), `lookups.py` (YouTube and Twitch), `eligibility.py`
(the thresholds), `keyfile.py`, `state.py` (the signed verify links), `config.py`. Settings are in
`keybot.env.example`.

## 1. The Discord application

On [discord.com/developers/applications](https://discord.com/developers/applications), under your
own account:

1. **New Application**, name it **Four Games**, and add the logo under *General Information*. Copy
   the **Application ID**: that's `DISCORD_CLIENT_ID`.
2. **Bot**: *Reset Token* and copy it (`DISCORD_BOT_TOKEN`; Discord shows it once). Turn **Public
   Bot** off, so only you can add it to servers. Leave all three *Privileged Gateway Intents* off:
   the bot doesn't need them (only `/keys grant role:` does, see above).
3. **OAuth2**: *Reset Secret* and copy it (`DISCORD_CLIENT_SECRET`). Under **Redirects**, add
   `https://api.fourgames.se/keybot/callback` and save.
4. **Invite it** with no server-wide permissions (the slash commands and DMs don't need any):

   ```
   https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot+applications.commands&permissions=0
   ```

   Open it, pick the Four Games server, *Authorize*.
5. **The admin channel**: make a private channel for the team (press requests include email
   addresses). *Edit Channel → Permissions → Add members or roles*, pick the **Four Games** bot,
   and allow **View Channel**, **Send Messages** and **Embed Links**. That's all the access it has.
   Right-click the channel → *Copy Channel ID* for `ADMIN_CHANNEL_ID` (with *Developer Mode* on in
   User Settings → Advanced). Copy the team's role id the same way for `ADMIN_ROLE_ID` if the team
   doesn't all have Manage Server.
6. `/keys` is hidden from everyone without Manage Server. If the team uses `ADMIN_ROLE_ID` instead,
   *Server Settings → Integrations → Four Games → /keys* lets that role see it. The bot checks either way.

## 2. On the server

After `feedback-setup.sh` (it makes the `/srv/fourgames/own` checkout and `/etc/fourgames/`):

```bash
ssh fourgames-server
cd /srv/fourgames/own && git pull
uv venv --python 3.13 /srv/fourgames/keybot-venv && uv pip install --python /srv/fourgames/keybot-venv/bin/python -r server/keybot/requirements.txt
install -d -m 700 /srv/fourgames/keybot
sudo install -m 640 -o root -g fourgames server/keybot/keybot.env.example /etc/fourgames/keybot.env
sudo nano /etc/fourgames/keybot.env   # the values from step 1, a new STATE_SECRET (openssl rand -hex 32),
                                      # and the YouTube and Twitch keys from /etc/fourgames/feedback.env
sudo install -m 644 server/keybot.service /etc/systemd/system/keybot.service
sudo systemctl daemon-reload && sudo systemctl enable --now keybot
journalctl -u keybot -f               # "commands synced to guild …" means it's up
```

**Caddy**: the `api.fourgames.se` block in `server/Caddyfile` needs the key bot's route (it's there,
commented out):

```
api.fourgames.se {
	handle /keybot/* {
		reverse_proxy localhost:8100
	}
}
```

The bot answers with or without the `/keybot` prefix, so `handle_path` works too. Then
`sudo cp /srv/fourgames/own/server/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`,
and `curl https://api.fourgames.se/keybot/health` should say `{"ok": true, …}`.

## 3. Keys from Steamworks

1. On [partner.steamgames.com](https://partner.steamgames.com), open the game → *Request Steam
   Product Keys*, ask for a batch (for streamers and press), and wait for Valve to approve it.
2. Download the batch from the same page. The .csv or .txt is fine as it is: the bot finds the key
   column (a header with "Key" in it, or the column that looks like `XXXXX-XXXXX-XXXXX`).
3. In Discord, the first batch of a game: `/keys add file: name:Game Name steam_app_id:1234560` and
   attach the download; that adds the game too. Later batches: `/keys add file: game:Game Name`. The
   answer (only you see it) says how many were added and skipped. Delete the downloaded file
   afterwards; the bot has the keys now.

Adding the same file twice adds nothing the second time. On the server, `python -m keybot.admin
import-keys` does the same from the command line (see below).

### The command line

On the server, as the bot's user, from the checkout (it uses `DB_PATH`, by default
`/srv/fourgames/keybot/keys.db`, and is fine to run while the bot runs). It prints counts, never keys.

```bash
cd /srv/fourgames/own/server
/srv/fourgames/keybot-venv/bin/python -m keybot.admin list
/srv/fourgames/keybot-venv/bin/python -m keybot.admin import-keys --game "Game Name" [--steam-app-id 1234560] FILE...
```

`import-keys` adds the game if it's new, reads .txt or .csv files like `/keys add`, and skips keys
it has.

## 4. The Active Developer badge

Running one of the bot's slash commands (any, e.g. `/claim` or `/keys status`) makes you, as the
application's owner, eligible for Discord's **Active Developer** badge. It counts commands of an app
you own. Discord can take up to a day to notice; then claim it at
[discord.com/developers/active-developer](https://discord.com/developers/active-developer). It asks
for a Community server you manage, for developer news. The badge stays while the app has had a
command used in the last 30 days, which the members' claims take care of.

## Day to day

| | |
| --- | --- |
| Logs | `journalctl -u keybot -f` |
| Restart | `sudo systemctl restart keybot` |
| Code changes | the feedback loop pulls `/srv/fourgames/own` every 5 minutes, but the bot runs what it started with: restart it after a change |
| New dependency | `uv pip install --python /srv/fourgames/keybot-venv/bin/python -r /srv/fourgames/own/server/keybot/requirements.txt` |
| Backup | one file; while it runs, copy it safely with `sqlite3 /srv/fourgames/keybot/keys.db ".backup /path/keys-backup.db"` |
| Tests | `cd server && python -m pytest keybot/tests` (with pytest and the requirements installed; no network) |
| Keys from the shell | `python -m keybot.admin list` (see *The command line*) |
