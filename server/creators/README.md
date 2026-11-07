# The creator collector

Builds a big list of YouTube creators who make videos of Steam games, so we can later pick the best
few hundred for each of our games and email them. Step 1 of the creator outreach plan: it only
collects (plus the hidden emails, below). Matching, the dashboard tab, Twitch and sending come next.

Every hour (`creators.timer` → `creators.service`, `python -m creators`) it:

1. Reads the games from the Steam data collector's `steam.db` (read only): **our own games** first
   (every 7 days: those in the website's game list and every game whose developer or publisher is "Four Games"), then every game with 30 to 50,000 reviews (bigger ones like Counter-Strike 2 bring channels far too big to answer us, and esports channels) and at most $30 full price (so a new AAA release without many reviews yet stays out), ordered by reviews gained in the last 28 days,
   with games that share tags with ours lifted up to 3×. Names under 4 letters or only digits are
   skipped (they find videos about something else).
2. Searches YouTube for each game's name in quotes, videos from the last 180 days (after that, since
   the last search), every 30 days.
3. Keeps only videos that really name the game: as whole words in the title or tags, or in the
   description of a Gaming-category video.
4. Reads each new channel's details: subscribers, videos, country, language, handle, and the
   description, where it finds **email addresses** (also "name [at] gmail [dot] com" and the like)
   and **links** to Twitch, X, Instagram, TikTok and Discord. Channels are read again every 30 days.

## The budget

YouTube's free quota is 10,000 units a day **per Google Cloud project**, reset at midnight Pacific.
A search costs 100; video and channel details 1 per 50. `DAILY_UNITS=9500` is about 90 game searches
a day, roughly 2,000–4,000 kept videos and several hundred new channels a day, more at the start.
Each hourly run spends about 1/24th, so a missed hour is made up later. If YouTube says the quota is
used up (403), nothing more is asked until the next Pacific day.

The feedback loop's key (`/etc/fourgames/feedback.env`) already spends ~7,500 units of its own project
a day on media searches, so this collector needs **a key from a new project**. More quota can be
requested from Google (the YouTube API audit form) once the list proves useful.

## Setup on the server

1. **The key** (your part, free): [console.cloud.google.com](https://console.cloud.google.com) →
   new project "fourgames-creators" → *APIs & Services → Library* → **YouTube Data API v3** → Enable
   → *Credentials → Create credentials → API key*. Restrict it to the YouTube Data API v3, and under
   application restrictions to the server's IP address.
2. Settings and the database folder:

   ```bash
   sudo install -d -m 750 -o fourgames -g fourgames /srv/fourgames/creators
   sudo install -m 640 -o root -g fourgames /srv/fourgames/own/server/creators/creators.env.example /etc/fourgames/creators.env
   sudo nano /etc/fourgames/creators.env     # paste the key after YOUTUBE_API_KEY=
   ```

3. A trial run of 2 searches, then the numbers:

   ```bash
   cd /srv/fourgames/own/server && sudo -u fourgames env $(sudo cat /etc/fourgames/creators.env | grep -v '^#' | xargs) /srv/fourgames/steamdata-venv/bin/python -m creators --searches 2
   sudo -u fourgames env $(sudo cat /etc/fourgames/creators.env | grep -v '^#' | xargs) /srv/fourgames/steamdata-venv/bin/python -m creators.stats
   ```

4. Start the hourly runs:

   ```bash
   sudo cp /srv/fourgames/own/server/creators.service /srv/fourgames/own/server/creators.timer /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now creators.timer
   ```

Logs: `journalctl -u creators`. Numbers: `python -m creators.stats` (as above).

## The dashboard page

After every hourly run `export.py` writes `/srv/fourgames/creators/export/creators.json.gz`, which the
dashboard's **Creators** page (fourgames.se/fb-dash, `src/lib/feedback/creators.js`) reads through the
game-data server, signed in as the owner only (`GET /gamedata/v1/admin/creators`). It holds each
channel's emails and where they came from, numbers, the games it covered, a type (indie variety,
variety, one game, a few games) and a genre profile from those games' Steam tags. The page works out
activity (newest upload, read for every channel every 14 days at 1 unit each), filters, and the best
creators for each of our games.

## The press list

Games press, aggregators (sites and newsletters that repost trailers and press releases) and YouTube
trailer channels worldwide, for launch announcements: the `press` table, shown on the Creators
page under **Press & trailers**. Each contact comes from the outlet's own contact page (kept as
`source`). The list isn't in this public repository; it's imported on the server from a JSON array
(`python -m creators.press import < press.json`, format in `press.py`); importing again updates by
address. `python -m creators.press stats` counts it.

## Outreach (sending)

Short one-to-one emails to the creators and press on the lists, in small daily drips:

1. **Draft** on the dashboard (Creators page, **Outreach**): a game, recipients (the best creators
   for it, or press filtered by country/language), a from name and address, a subject and a short
   body with `{name}`, `{game}`, `{steam}`, `{their_game}`. Each recipient gets their own filled-in
   message (`outreach.py`); addresses that opted out, bounced or were emailed in the last 90 days are
   left out, and an opt-out line is added if the body has none.
2. **Approve** after reading the previews. Nothing is sent before that.
3. **Sending** (`send.py`, `creators-send.timer` every 15 minutes): weekdays in `SEND_HOURS`, at most
   `DAILY_MAX` a day across campaigns (and each campaign's own limit), spread over the day, through
   the Strato mailbox with SMTP. Each email has a `List-Unsubscribe` header.
4. **Replies** (same run, IMAP, read only): a reply marks the message replied; "no", "not
   interested", "unsubscribe"... mark it opted out and the address is never emailed again; bounces
   too. The dashboard shows each campaign's counts and every message's status.

Each email has a plain-text part and an HTML part that looks like a normal email from a person
(no card, buttons or logo: designed cold emails read like marketing and land in spam more often),
with the game's gameplay GIF dropped in after the second paragraph:
`public/images/outreach/<game-name-slug>.gif`, served from fourgames.se, as small as it can be
(about 360 px, 8 fps, 32 colors, 3 s: ~350 KB), with a good first frame since Outlook shows only that. Without one, the Steam header image. No tracking pixels.
To make a GIF from a Steam trailer, on the server: get the trailer with
`ffmpeg -i <the hls_h264 address from Steam's appdetails movies> -c copy trailer.mp4`, then
`ffmpeg -ss 7.8 -t 3 -i trailer.mp4 -vf "fps=8,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=32:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 out.gif`.

**Audiences and languages:** a campaign goes to YouTubers (best fit for the game), streamers (the
same, only creators with a Twitch channel) or press (the Press tab's filters), each with its own short
template. On the dashboard, Localize asks Claude (`POST /admin/outreach/translate`, Sonnet) to write the
English email for each recipient language the way a native would, short and plain, keeping every
placeholder and link (one that changes them is refused). It uses the game's Steam name in that
language (fills {game}) and says the game is in their language when Steam lists it. The Steam link
stays plain: Steam already shows the store in the reader's language, and `?l=` would override their choice. The owner reads and can edit each; each person gets
their channel's or outlet's language, English otherwise. Replies saying no are recognized in those
languages too.

**Safety brake:** a campaign pauses itself (with the reason on the dashboard) once 10+ of its emails
are sent and more than 5% bounce or more than 8% say no, counted since it was last resumed.

**DMARC reports** (`dmarc.py`): with `_dmarc.fourgames.se` TXT `v=DMARC1;p=reject;rua=mailto:dmarc@fourgames.se`
and dmarc@ as an alias of the sending mailbox, receivers (Gmail, Outlook, Yahoo...) send a daily report of
mail they got from the domain and whether it passed. `send.py` saves them (`dmarc_reports`), moves those
emails (only mail to dmarc@) into a DMARC folder, and the Outreach tab's Mail health box shows 30 days.

The from address can be the game's (e.g. "Danny from Pomo Valley" <pomovalley@fourgames.se>): add it
in Strato as an **alias** of the sending mailbox, so Strato lets the mailbox send as it and replies land
in the same inbox. If Strato refuses the from address, sending stops and the log says so.

Setup on the server:

```bash
sudo install -m 640 -o root -g fourgames /srv/fourgames/own/server/creators/outreach.env.example /etc/fourgames/outreach.env
sudo nano /etc/fourgames/outreach.env      # MAIL_USER and MAIL_PASSWORD (yours to type in)
sudo cp /srv/fourgames/own/server/creators-send.service /srv/fourgames/own/server/creators-send.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now creators-send.timer
```

Logs: `journalctl -u creators-send`.

## The tables

One SQLite file, `/srv/fourgames/creators/creators.db`:

| Table | What's in it |
| --- | --- |
| `youtube_channels` | One row per channel: title, handle, description, country, language, subscribers (NULL when hidden), videos, views, when it was made, `emails` and `links` (JSON) from the description, and `revealed_email` / `revealed_at` for the email behind YouTube's "View email address" button, saved by the yt-email-unlock skill, and `email_button` (1/0, NULL not checked) / `button_checked_at` |
| `youtube_videos` | Every kept video, per game it names: channel, title, published, views, likes, comments, length, language |
| `channel_games` (view) | Per channel and game: videos, the latest, total views. What matching will score on |
| `channel_links` | The web pages each channel links to, from its description or About panel |
| `sites` | Each followed link: when, status, emails found. View `site_emails`: per channel |
| `press` | The press list: outlet, kind, country, language, email or contact page, reach, focus, notes, source |
| `outreach_campaigns`, `outreach_messages`, `outreach_suppress` | Outreach: each campaign, each filled-in message and its status, and addresses never to email again |
| `searches` | Each game searched: when, when it's due again, results and kept |
| `quota` | Units spent per Pacific day |

## Hidden emails

Many channels keep their business email behind YouTube's **View email address** button (signed in,
plus a captcha). The `yt-email-unlock` Claude skill gets them in the user's own Chrome, with
`python -m creators.reveal` as its server side:

- `check N`: channels without a public email whose button isn't checked yet, best first. The skill
  fetches each About page (no captcha) and saves whether the button is there (`email_button`).
- `reveal N`: channels with the button and no email yet, best first. The skill opens them 10 tabs
  at a time, the user clicks the button, ticks the captcha and presses Submit, and the email goes to `revealed_email`.
- `save`: JSON lines on stdin (see `reveal.py`).

Best first, until per-game matching exists: a video of one of our games, then 1k–300k subscribers,
then a video in the last 30 days, then more games, then more subscribers. Nobody but the user
solves the captcha, so revealing is kept for the best few.

## Emails from creators' links

Many creators without a public email on YouTube have one on their Linktree, Beacons or Carrd page or
their own website. After the YouTube part, every hourly run follows up to 150 links
(`python -m creators --links N`, or `python -m creators.sites N` alone), best channels first, from
channels without an email yet:

- links in the description (any `https://` address, and bare link-in-bio addresses like `linktr.ee/name`),
- the About panel's link list, which the API doesn't give; the skill's check reads it and saves it.

Big platforms (YouTube, Twitch, X, Instagram, Discord, Patreon, Ko-fi, shops...) are skipped: they
don't show emails to visitors. On their own website, if the first page has no email, up to two
contact/about pages on the same site are tried. Emails of the host or web tools (privacy@,
wixpress...) are dropped. Each link is followed again after 90 days. Results: `sites` (per link) and
the `site_emails` view (per channel); channels with one are left out of the captcha queue.

## About the emails

Only addresses the creator published in their own channel description are collected, the ones they
put there for business contact. Under GDPR, writing to a published business address one at a
time about something relevant to their channel, with an easy way to say no, is generally fine
(legitimate interest). Adding them to a newsletter without consent is not. The data stays on our
server and isn't shared.
