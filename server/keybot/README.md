# The key bot

Hands out Steam keys in the Four Games Discord, in place of the third-party KeyBot. It runs on the
server as `keybot.service`: one Python process with the Discord bot and a small web server for
creator verification on `localhost:8100`, behind Caddy at `https://api.fourgames.se/keybot/`.

| Who | Command | What happens |
| --- | --- | --- |
| YouTube members (the **YouTube Member** role from Discord's YouTube integration) | `/claim` (pick from a list, or `game:`) | The key comes by DM. One key per game per person, for good: lapsing and rejoining doesn't give another. If their DMs are closed, no key is used and they're told to open them. Non-members get a link to [join](https://www.youtube.com/@FourGamesAB/join). |
| Anyone with a key | `/mykeys` | Shows their keys again, only to them. |
| Content creators | `/request game:` | A one-time **Verify your channel** link (15 minutes). They sign in with Discord, which shows us their *verified* YouTube and Twitch connections. A YouTube channel with 1,000+ subscribers and an upload in the last 60 days, or a Twitch channel with 500+ followers, gets the key by DM at once; anything else goes to the admin channel. |
| Press | `/request-press game: outlet: email:` | Always goes to the admin channel. The email isn't checked yet; once the company mail exists, the bot could send a confirmation link first. |
| The team (Manage Server, or the `ADMIN_ROLE_ID` role) | `/keys add game: file:` | Adds keys from a .txt (one per line) or .csv (finds the key column itself, e.g. a Steamworks download). Skips keys it already has and says how many it added. |
| | `/keys games [name:] [steam_app_id:]` | Lists the games, or adds one / sets its Steam app id. |
| | `/keys status` | Per game: keys left, given out by reason (member, creator, press), open requests. |
| | `/keys log [count:]` | The latest handouts: who, which game, why, and the key's id (never the key). |

Requests in the admin channel are cards with the person, their channels and numbers, why it wasn't
approved by itself, and **Approve** / **Deny** buttons that keep working after a restart. Approve
DMs the key; Deny DMs a polite no. Each person can have 3 requests waiting at a time. The admin
channel also hears when a game drops below 5 keys (`LOW_STOCK`) and when it runs out.

Everything is in one SQLite file, `/srv/fourgames/keybot/keys.db`: games, keys (with who got each,
when and why), requests and verify links. Handouts happen in a single write transaction, and the
database itself refuses a second key of the same game for one person, so two claims at the same
moment can't get the same key. The logs show key ids, never keys.

The code: `bot.py` (commands, buttons, handouts), `web.py` (the verify login), `db.py`,
`lookups.py` (YouTube and Twitch), `eligibility.py` (the thresholds), `keyfile.py`, `state.py`
(the signed verify links), `config.py`. Settings are in `keybot.env.example`.

## 1. The Discord application

On [discord.com/developers/applications](https://discord.com/developers/applications), under your
own account:

1. **New Application**, name it **Four Games**, and add the logo under *General Information*. Copy
   the **Application ID**: that's `DISCORD_CLIENT_ID`.
2. **Bot**: *Reset Token* and copy it (`DISCORD_BOT_TOKEN`; Discord shows it once). Turn **Public
   Bot** off, so only you can add it to servers. Leave all three *Privileged Gateway Intents* off:
   the bot doesn't need them.
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
6. Optional: *Server Settings → Integrations → Four Games* lets you hide `/keys` from everyone
   but the team in the command list. The bot checks either way.

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
3. In Discord, once per game: `/keys games name:Game Name steam_app_id:1234560`.
4. `/keys add game:Game Name file:` and attach the download. The answer (only you see it) says how
   many were added and skipped. Delete the downloaded file afterwards; the bot has the keys now.

Adding the same file twice adds nothing the second time.

## 4. The Active Developer badge

Running one of the bot's slash commands (any, e.g. `/keys status`) makes you, as the application's
owner, eligible for Discord's **Active Developer** badge. Discord can take up to a day to notice;
then claim it at [discord.com/developers/active-developer](https://discord.com/developers/active-developer).
It asks for a Community server you manage, for developer news. The badge stays while the app has
had a command used in the last 30 days, which the members' claims take care of.

## 5. Switching from the old KeyBot

1. Set this bot up, add the games and keys, and try `/claim` with a member account and `/request`
   with a creator account (yours) before telling anyone.
2. In the old KeyBot, take out the keys it still has (its dashboard or export) and add them here
   with `/keys add`, so none are left behind. Who already claimed what with the old bot doesn't
   carry over: those members could claim the same game here once more.
3. Tell the server the commands are now `/claim`, `/mykeys`, `/request` and `/request-press`, and
   update any pinned messages or channel topics that mention the old ones.
4. *Server Settings → Integrations → KeyBot → Remove Integration* (or kick it from the member list),
   then delete its leftover role under *Roles*, if any.

## Day to day

| | |
| --- | --- |
| Logs | `journalctl -u keybot -f` |
| Restart | `sudo systemctl restart keybot` |
| Code changes | the feedback loop pulls `/srv/fourgames/own` every 5 minutes, but the bot runs what it started with: restart it after a change |
| New dependency | `uv pip install --python /srv/fourgames/keybot-venv/bin/python -r /srv/fourgames/own/server/keybot/requirements.txt` |
| Backup | one file; while it runs, copy it safely with `sqlite3 /srv/fourgames/keybot/keys.db ".backup /path/keys-backup.db"` |
| Tests | `cd server && python -m pytest keybot/tests` (with pytest and the requirements installed; no network) |
