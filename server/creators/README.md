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

## The tables

One SQLite file, `/srv/fourgames/creators/creators.db`:

| Table | What's in it |
| --- | --- |
| `youtube_channels` | One row per channel: title, handle, description, country, language, subscribers (NULL when hidden), videos, views, when it was made, `emails` and `links` (JSON) from the description, and `revealed_email` / `revealed_at` for the email behind YouTube's "View email address" button, saved by the creator-emails skill, and `email_button` (1/0, NULL not checked) / `button_checked_at` |
| `youtube_videos` | Every kept video, per game it names: channel, title, published, views, likes, comments, length, language |
| `channel_games` (view) | Per channel and game: videos, the latest, total views. What matching will score on |
| `searches` | Each game searched: when, when it's due again, results and kept |
| `quota` | Units spent per Pacific day |

## Hidden emails

Many channels keep their business email behind YouTube's **View email address** button (signed in,
plus a captcha). The `creator-emails` Claude skill gets them in the user's own Chrome, with
`python -m creators.reveal` as its server side:

- `check N`: channels without a public email whose button isn't checked yet, best first. The skill
  fetches each About page (no captcha) and saves whether the button is there (`email_button`).
- `reveal N`: channels with the button and no email yet, best first. The skill opens them, the
  user ticks the captcha and presses Submit, and the email goes to `revealed_email`.
- `save`: JSON lines on stdin (see `reveal.py`).

Best first, until per-game matching exists: a video of one of our games, then 1k–300k subscribers,
then a video in the last 30 days, then more games, then more subscribers. Nobody but the user
solves the captcha.

## About the emails

Only addresses the creator published in their own channel description are collected, the ones they
put there for business contact. Under GDPR, writing to a published business address one at a
time about something relevant to their channel, with an easy way to say no, is generally fine
(legitimate interest). Adding them to a newsletter without consent is not. The data stays on our
server and isn't shared.
