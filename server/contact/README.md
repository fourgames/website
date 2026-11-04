# The contact form

The backend for the "Send us a message" form on fourgames.se, in place of Formspree. It runs on the
server as `contact.service`: one small Python web server (aiohttp) on `localhost:8101`, behind Caddy at
`https://api.fourgames.se/contact`. Each message is emailed to `support@fourgames.se` over SMTP
(Strato, STARTTLS), with **Reply-To** set to the sender, so answering is just *Reply* in the mail app.
Nothing is stored on the server.

| Route | What it does |
| --- | --- |
| `POST /contact` (or `POST /`) | Takes the form, as form data or JSON: `email`, `message`, `_subject` (hidden, says the site language), `_gotcha` (the honeypot) and `_elapsed`. Answers `{"ok": true}`, or `{"ok": false, "error": "…"}` with 400 (bad fields, spam), 403 (another site), 413 (too big), 415 (not form data or JSON), 429 (too many) or 502 (the mail didn't go out). |
| `GET /health` | `{"ok": true}` |

The routes answer with or without the `/contact` prefix, so Caddy's `handle` and `handle_path` both work.

## Spam protection

- **Honeypot**: the form has a hidden `_gotcha` field people never see. If it's filled in, the answer
  is a normal `{"ok": true}` (so bots learn nothing), and nothing is sent.
- **Time to fill in**: the page's script puts the milliseconds since the form appeared in `_elapsed`
  when it's sent. Under 3 seconds (`CONTACT_MIN_SECONDS`), or missing, is refused. It's a duration, not
  a timestamp, so a visitor's wrong clock doesn't matter. (Without JavaScript the field is empty, so the
  form needs JavaScript now.)
- **Per IP**: at most 5 messages an hour from one IP (`CONTACT_RATE_LIMIT`, `CONTACT_RATE_WINDOW`), from
  the `X-Forwarded-For` Caddy sets (trusted only from localhost). In memory; a restart forgets.
- **Links**: more than 3 links, or forum/HTML link markup (`[url=`, `<a href`), is refused.
- **Origin**: only posts from `https://fourgames.se` (`CONTACT_ALLOWED_ORIGINS`) are taken; CORS lets
  only that origin read the answer.
- **Limits**: a valid-looking email (at most 254 characters), a message of 2 to 5,000 characters, a
  request body of at most 64 KB.

## Privacy

The logs show only the outcome and a short hash of the IP (salted per run, so it can't be turned back
into the IP), e.g. `sent for 66880d6aef5b` or `rejected 66880d6aef5b: sent too fast`. Never a message,
an email address or an IP; aiohttp's access log is off. The optional Discord notice says only
`New contact form message from someone at studio.com, subject: …`.

The code: `web.py` (the routes, CORS, IP and logging), `checks.py` (fields, honeypot, time, links, rate
limit), `mail.py` (the email and the Discord notice), `config.py`. Settings are in `contact.env.example`.

## 1. The mailbox

In Strato's *Email* settings, make (or pick) the mailbox that sends the messages, e.g.
`support@fourgames.se`, and set its password. That's `SMTP_USER` and `SMTP_PASSWORD`. Messages come
**from** that mailbox (or `CONTACT_FROM`, if it's one of its aliases) and go **to** `CONTACT_TO`
(default `support@fourgames.se`).

## 2. On the server

After `feedback-setup.sh` (it makes the `/srv/fourgames/own` checkout and `/etc/fourgames/`):

```bash
ssh fourgames-server
cd /srv/fourgames/own && git pull
uv venv --python 3.13 /srv/fourgames/contact-venv && uv pip install --python /srv/fourgames/contact-venv/bin/python -r server/contact/requirements.txt
sudo install -m 640 -o root -g fourgames server/contact/contact.env.example /etc/fourgames/contact.env
sudo nano /etc/fourgames/contact.env   # SMTP_USER and SMTP_PASSWORD; the rest is optional
sudo install -m 644 server/contact.service /etc/systemd/system/contact.service
sudo systemctl daemon-reload && sudo systemctl enable --now contact
journalctl -u contact -f               # "listening on 127.0.0.1:8101" means it's up
```

**Caddy**: the `api.fourgames.se` block in `server/Caddyfile` needs the route:

```
api.fourgames.se {
	handle /contact* {
		reverse_proxy localhost:8101
	}
}
```

Then `sudo cp /srv/fourgames/own/server/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`,
and `curl https://api.fourgames.se/contact/health` should say `{"ok": true}`. Send a test from the
form on fourgames.se and check the inbox.

## Day to day

| | |
| --- | --- |
| Logs | `journalctl -u contact -f` |
| Restart | `sudo systemctl restart contact` |
| Code changes | the feedback loop pulls `/srv/fourgames/own` every 5 minutes, but the service runs what it started with: restart it after a change |
| New dependency | `uv pip install --python /srv/fourgames/contact-venv/bin/python -r /srv/fourgames/own/server/contact/requirements.txt` |
| Tests | `cd server && python -m pytest contact/tests` (with pytest and the requirements installed; no network, SMTP is faked) |
| Trying the form locally | add `http://localhost:5173,http://localhost:4173` to `CONTACT_ALLOWED_ORIGINS` |
