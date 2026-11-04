# The server

A Strato VPS S (1 vCore, 2 GB RAM, 60 GB, Ubuntu 26.04, IP 82.165.18.23) for what needs to run all the time: the player
feedback loop (instead of GitHub Actions), the subdomains' short links with HTTPS, and later the
player data API and Discord bots. The website itself stays on GitHub Pages, and the data stays in
the `fourgames/feedback-data` repo.

Everything on the server comes from this folder, so a new server is set up again from it in minutes.
Nothing lives only on the server yet, so there are no backups; add them (Cloudflare R2) once
something does, like the player data API's database.

| File | What it is |
| --- | --- |
| `setup.sh` | First-time setup, run once as root: user `fourgames`, SSH with keys only, firewall, automatic updates, swap, Node 22, gh, Caddy, uv |
| `feedback-setup.sh` | The feedback loop: checkouts, deploy key, Python 3.13, secrets, the services |
| `feedback@.service` | `feedback/loop.sh` as a systemd service, one instance per part (`own`, `research`) |
| `feedback@research.service.d/` | The research part's longer run limit |
| `feedback.env.example` | Which secrets go in `/etc/fourgames/feedback.env` |
| `contact/`, `contact.service` | The website's contact form backend (in place of Formspree), mailing messages to support@: [contact/README.md](contact/README.md) |
| `alerts/`, `alerts.service` | Push notifications from YouTube and Twitch that start the loop's announce check at once, so new videos and streams reach Discord within a minute: [alerts/README.md](alerts/README.md) |
| `steamdata/`, `steamdata.service` | The Steam market-data collector: a daily snapshot of every game (reviews, price, discount, tags, release), player counts, metadata and which games are Godot, into one SQLite file: [steamdata/README.md](steamdata/README.md) |
| `gamedata/`, `gamedata.service`, `gamedata-geo.service`, `gamedata-geo.timer` | The player game-data API at `api.fourgames.se/gamedata`: sessions, game actions, hardware, settings and crash reports from the games under a pseudonym, and the privacy page's sign-in, download, opt-out and anonymise; plus the monthly update of its country/region database: [gamedata/README.md](gamedata/README.md) |
| `Caddyfile` | The subdomains: `discord`, `youtube`, `steam`, `github` (short links) and `api` (status, key bot) |
| `status-page/` | The public status page at `status.fourgames.se`: static files Caddy serves from `/srv/fourgames/own/server/status-page` |

## 1. Log in with your key

The key on your Mac is `~/.ssh/id_ed25519_server`. Add this to `~/.ssh/config` on the Mac
(with the server's IP):

```
Host fourgames-server
  HostName SERVER_IP
  User fourgames
  IdentityFile ~/.ssh/id_ed25519_server
  IdentitiesOnly yes
```

If Strato let you add the public key when setting up the server, root can already log in with it.
Otherwise, once, with the root password from Strato's email (typed in the terminal yourself):

```bash
ssh-copy-id -i ~/.ssh/id_ed25519_server.pub root@SERVER_IP
```

## 2. Base setup

```bash
ssh -i ~/.ssh/id_ed25519_server root@SERVER_IP 'bash -s' < server/setup.sh
```

After this root and passwords can't log in any more; `ssh fourgames-server` can.

## 3. The feedback loop

```bash
ssh fourgames-server 'curl -fsSL https://raw.githubusercontent.com/fourgames/website/main/server/feedback-setup.sh | bash'
```

It stops twice, and you run it again after each:

1. **Deploy key.** It prints a key: add it to
   [feedback-data → Settings → Deploy keys](https://github.com/fourgames/feedback-data/settings/keys)
   with *Allow write access*.
2. **Secrets.** `ssh fourgames-server`, then `sudo nano /etc/fourgames/feedback.env` and fill in the
   same values as the Actions secrets (GitHub doesn't show them again, so take them from where you
   made them), plus a fine-grained `GH_TOKEN` (see the file). With a fixed IP, the Steam financial
   key's IP list can now be locked to the server's.

The last run checks node, Python, the token and the deploy key, without collecting or sending
anything.

## 4. Switch over

GitHub Actions and the server must never collect at the same time: Discord would get every alert
twice, and both would commit the same data.

```bash
gh workflow disable feedback.yml
gh workflow disable feedback-research.yml
gh run list -w feedback.yml -s in_progress            # cancel what's still running:
gh run list -w feedback-research.yml -s in_progress   # gh run cancel RUN_ID
ssh fourgames-server 'sudo systemctl enable --now feedback@own feedback@research'
ssh fourgames-server 'journalctl -u feedback@own -f'
```

The dashboard's **GitHub** status reads the server's `api.fourgames.se/status/own.json` (written by
`loop.sh` after each run) while it's fresh, and the Actions runs otherwise, so it's right on both
sides of the switch.

**Back to GitHub:** `sudo systemctl disable --now feedback@own feedback@research` and
`rm /srv/fourgames/status/*.json` on the server (or the dashboard reports the server as stopped),
then `gh workflow enable` both workflows and start them (*Run workflow*). The Sales API (financial) key is locked to the server's IP in Steamworks, so on GitHub the sales and wishlist numbers fail until that lock is lifted; the alerts service (`server/alerts`) must be stopped too, since GitHub's runs don't see its pending file.

## 5. Subdomains with HTTPS

In Strato's *Domänadministration*, for each of `discord`, `youtube`, `steam` and `github`: remove the
redirect and set an **A record** to the server's IP (the package has 5 subdomains; `join` and `press`
can go). Then:

```bash
ssh fourgames-server 'sudo cp /srv/fourgames/own/server/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy'
```

Caddy gets each certificate the first time the subdomain is opened. After that `discord.fourgames.se`
works over HTTPS, and `src/data/site.js` can link to it.

## Day to day

| | |
| --- | --- |
| Logs | `journalctl -u feedback@own -f` (or `@research`) |
| Restart | `sudo systemctl restart feedback@own` |
| Code changes | none needed: `loop.sh` pulls `main` every 5 minutes, and a changed `loop.sh` itself takes effect when it restarts every 4 hours |
| New dependency | `uv pip install --python /srv/fourgames/venv/bin/python -r /srv/fourgames/own/feedback/requirements.txt` |
| Updates | automatic, rebooting at 04:00 when needed; the services start again by themselves |
