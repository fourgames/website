# The fan mailing list

A list of fans' email addresses that Four Games owns, so we can tell people about new games, big updates and sales (a few emails a year at most) even if
YouTube, Steam or Discord ever cut us off. People sign up in the footer of fourgames.se. It runs on
the server as `news.service`: one small Python web server (aiohttp) on `localhost:8104`, behind Caddy
at `https://api.fourgames.se/news`, with the list in one SQLite file, `/srv/fourgames/news/news.db`.

Opt-in only, double opt-in, easy to leave:

1. The footer form posts the address. It's stored **unconfirmed**, and an email with a confirm link
   goes out (from `news@fourgames.se`, through the same Strato mailbox as the creator outreach).
2. The link opens a page with one **Yes, add me** button. Only pressing it confirms (a link alone
   isn't enough, because mail scanners open links). Only confirmed addresses are on the list.
3. Unconfirmed addresses are **deleted after 7 days**, so typos and addresses someone else typed in
   just disappear.
4. Every email has an **unsubscribe link** (a page with one button) and the `List-Unsubscribe`
   headers, so Gmail and Apple Mail show their own one-click *Unsubscribe*. Unsubscribing **deletes**
   the address.

Sending news to the list isn't built yet: `Store.confirmed_emails()` gives (email, language,
unsubscribe token) for when it is. Each email must then include `mail.unsubscribe_url(...)` and the
same two headers as the confirm email.

| Route | What it does |
| --- | --- |
| `POST /news/subscribe` | The footer form, as JSON or form data: `email`, `lang` (en, ja, ko, zh-cn, zh-tw), `_gotcha` (honeypot), `_elapsed` (ms since the form appeared). `{"ok": true}` for any valid address (new, already on the list, or a link sent recently), so the form can't tell anyone who's subscribed. 400 bad address or too fast, 403 another site, 429 too many, 502 the email didn't go out. |
| `GET /news/confirm?t=…` | The confirm page (one button), or "this link doesn't work any more" (404). |
| `POST /news/confirm` | The button: confirms, then "You're on the list". |
| `GET /news/unsubscribe?t=…` | The unsubscribe page (one button). |
| `POST /news/unsubscribe` | The button, or the mail app's one-click POST (RFC 8058): deletes the address. |
| `GET /news/health` | `{"ok": true}` |

## Spam and privacy

- **Honeypot** and **time to fill in** (at least 1.5 s), like the contact form.
- **Per IP**: at most 5 signups an hour. **Per address**: at most 3 confirm emails, 15 minutes apart,
  so nobody can use the form to flood a stranger. **In all**: at most 200 confirm emails a day
  (`NEWS_DAILY_MAX`), to keep the mailbox's reputation safe.
- **Origin**: only `https://fourgames.se` may post.
- **Logs** show only the outcome and a salted hash of the IP, never an address or a link's token;
  aiohttp's access log is off.
- **The dashboard** (fourgames.se/fb-dash, Creators) shows only numbers: `stats.json` (confirmed,
  waiting to confirm, per language, signups/confirms/unsubscribes per day), served signed-in by the
  game-data API at `/gamedata/v1/admin/news`.
- The privacy page (fourgames.se/privacy, "This website and Discord") says what's kept and why.

The code: `web.py` (routes), `store.py` (the SQLite list and stats.json), `mail.py` (the confirm
email), `pages.py` and `texts.py` (the pages and words, in the site's five languages), `config.py`.
It reuses the contact form's email check, rate limiter and form reader (`server/contact`).

## Setup on the server

1. In Strato: add the alias `news@fourgames.se` to the mailbox in `/etc/fourgames/outreach.env`
   (`MAIL_USER`). Without it Strato refuses to send as news@.
2. Then:

```bash
cd /srv/fourgames/own && git pull
uv venv --python 3.13 /srv/fourgames/news-venv && uv pip install --python /srv/fourgames/news-venv/bin/python -r server/news/requirements.txt
sudo install -d -m 750 -o fourgames -g fourgames /srv/fourgames/news
sudo install -m 640 -o root -g fourgames server/news/news.env.example /etc/fourgames/news.env
sudo install -m 644 server/news.service /etc/systemd/system/news.service
sudo systemctl daemon-reload && sudo systemctl enable --now news
sudo cp server/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
sudo systemctl restart gamedata   # for the dashboard's /admin/news
curl https://api.fourgames.se/news/health   # {"ok": true}
```

## Day to day

| | |
| --- | --- |
| Logs | `journalctl -u news -f` |
| Restart | `sudo systemctl restart news` (after a code change) |
| How many | the dashboard, or `sqlite3 /srv/fourgames/news/news.db "select count(*) from subscribers where confirmed is not null"` |
| Tests | `cd server && python -m pytest news/tests` (aiohttp and pytest; no network, SMTP is faked) |
| Trying the form locally | add `http://localhost:5173` to `NEWS_ALLOWED_ORIGINS` |
