# Player feedback

Collects player feedback for every Four Games title on Steam, triages it with Claude, posts alerts to Discord and feeds the private dashboard at [fourgames.se/fb-dash](https://fourgames.se/fb-dash/). It runs from `.github/workflows/feedback.yml`. The website build doesn't use any of it.

## What a run does

1. **Games.** It gets the game list from the same publisher data the site uses. `games.mjs` reads `SITE.steam.publisher`/`.developer` and `GAMES`, and `steam.py` runs the same store search as `scripts/fetch-data.mjs`. New store pages are picked up automatically.
2. **Reviews.** It reads new and edited reviews from the Steamworks `IUserReviewsService/GetAppReviews` endpoint with the publisher key and the *Updated* filter, in all languages. It retries on HTTP 429 and stops at the last review it has already seen.
   - An edit keeps the old text in `versions`.
   - A changed recommendation is recorded in `flips`.
3. **Discussions.** It reads new threads and new replies in every subforum.
4. **Players.** It records the current player count.
5. **Media** (`media.py`). It finds who's talking about the game outside Steam:
   - **Twitch:** streams live right now in the game's category, checked every run. The category is found through IGDB by the Steam app id, else by name. A game Twitch has no category for yet can't be followed.
   - **YouTube:** new videos that name the game, about once an hour per game (the free quota is 10,000 units a day and a search costs 100, so it searches less often with more than 3 games). Views, likes and comments of the last two weeks' videos are kept current.
   - **News:** Google News search, every 30 minutes, plus any Google Alerts feeds you add (they also cover blogs and other sites).
   - **Reddit:** threads from Google Alerts like `site:reddit.com "Game name"`, listed under their subreddit. Never alerted. Reddit's own API isn't used: it needs Reddit's approval, and its rules don't allow sharing what it returns (this repo is public).

   **Names:** once a day it reads the game's name in each of Steam's 30 languages from its store page and keeps every name it has ever had (a changed translation still finds what was written under the old one). YouTube searches use the English name and a few localized ones at a time, in turn; Google News is searched in each language's country edition, every 2 hours, by the English name and that language's names (the US edition every 30 minutes). Names waiting for Valve to set them aren't on the store yet, so they're picked up once they are.

   Search results must name the game exactly and be about a game (YouTube's Gaming category, or words like *gameplay*, *Steam* or *trailer*, also in the other languages: *Spiel*, *jeu*, 게임, ゲーム…), since a game's name can also be a place or a product. Your own channel's videos and posts are listed but never alerted. A source's first search for a game only records what's already out there; only new finds get alerts, and only when they're from the last 3 days. When each source last searched is kept in `feedback/.cache`, so a fresh workflow run searches once more.
6. **Community** (`community.py`, no keys). Hourly, each game's **followers** on Steam (its community hub, which moves with wishlists) and the studio's **Discord** members and members online (from the invite link in `src/data/site.js`, kept in `index.json`). Daily, each game's **achievements**: name, icon and the share of players who unlocked each, from its public stats page.
7. **Triage.** It sends each new or edited post to Claude Haiku 4.5, with no extended thinking. Haiku:
   - translates the post to English;
   - sorts it as bug, suggestion, question or praise;
   - sets urgency and the game area;
   - merges duplicates, across languages, into *issues* with mention counts. A mention is one distinct player.
8. **Issues.** Every issue gets a priority score. Every bug issue gets a ready-to-paste Claude Code fix prompt.
9. **Releases.** When a game publishes an update or patch-notes event, Claude Haiku 4.5 compares the patch notes with what players said about each open issue. A line that does exactly what they asked marks the issue **likely fixed in vX**; a line that only helps marks it **partly addressed**. It becomes **still happening** only when a player says the problem is still there after the fix.
   - For every negative review and every thread in an issue that a release fixed, Claude drafts a one- or two-sentence reply in the player's language, saying what was fixed and in which version. Steam's moderation guide suggests replying only in cases like that. The drafts show in the dashboard's **Replies** view until you reply on Steam.
10. **Discord.** It posts webhook embeds that link to the original post for:
   - urgent issues;
   - every new negative review, and every new post that reports a bug;
   - reviews flipped to negative;
   - repeated reports, at 3, 5, 10, 25… players;
   - someone going live on Twitch (every new stream), a new YouTube video or article, with a link to join the chat or comment.

   Every alert @mentions `DISCORD_MENTION`.

   A game's first run only records a baseline, so the backfill doesn't flood Discord.

Every post's text is stored, so a post deleted on Steam isn't lost here. A file is rewritten only when its content changed, and the workflow commits only when something did.

## Schedule

Each workflow run does a full run every 10 minutes for about 4 hours (`loop.sh`), then starts the next run; the schedule starts one if none is going. A run with nothing new only reads from Steam: the review list, player count and update posts, and the first page of each discussion forum (threads are opened only when they have new activity). Claude is only called for new or edited posts.

When anything the website shows from a game's store page changes (a new public store page, a release, a sale, new text, capsule or screenshots), the run also starts the site's *Build and deploy* workflow, so the website shows it within minutes instead of at the daily rebuild.

Starting the workflow by hand (*Run workflow*) replaces the current run.

## Secrets

Set these under *Settings → Secrets and variables → Actions*. None of them is ever written to `data/` or the dashboard.

| Secret | What it is |
| --- | --- |
| `STEAM_PUBLISHER_KEY` | Steamworks Web API publisher key (Users & Permissions → Manage Groups → your group → Web API key), with the *General* permission |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `DISCORD_WEBHOOK_URL` | The channel's webhook URL |
| `DISCORD_MENTION` | Who to ping: `<@USER_ID>`, `<@&ROLE_ID>` or a bare user ID (optional) |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | A Twitch app from [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps): *Register Your Application*, OAuth redirect `http://localhost`, category *Analytics Tool*, client type *Confidential*. Also used for IGDB |
| `YOUTUBE_API_KEY` | In [Google Cloud Console](https://console.cloud.google.com/): make a project, enable *YouTube Data API v3*, then *Credentials → Create credentials → API key* (restrict it to that API) |
| `GOOGLE_ALERTS_FEEDS` | Optional. At [google.com/alerts](https://www.google.com/alerts), alerts per game for `"Game name"` (the web) and `site:reddit.com "Game name"` (Reddit), with *Show options → Deliver to: RSS feed*; paste the feed URLs (the RSS icon next to each alert), one per line |

## Data

- `data/index.json` holds the game list and the status of each service.
- `data/games/<appid>.json` holds one game:
  - `items`: every post, keyed `r<id>` (review), `t<id>` (thread) or `c<id>` (reply);
  - `issues`;
  - `players`: `[time, count]`, stored only when the count changes;
  - `reviewTotals`: per day;
  - `releases`.
  - `manualFixes`: Claude's verdict on each fix you marked.
  - `followers`: `[time, count]`, stored only when it changes.
  - `achievements`: `{at, list: [{name, desc, icon, percent}]}`.
  - `media`: `items` (streams, videos, articles and Reddit posts, keyed `tw`, `yt`, `nw`, `rd`), the game's Twitch `category`, and when each source `started`.
- `data/cleared.json` holds what you marked fixed on the dashboard, per game.

This repo is public, so this data is too. It's all public on Steam anyway.

## Dashboard

`/fb-dash` is a page of the site (`src/views/FeedbackView.vue`, with the dashboard itself in `src/lib/feedback/`, loaded only on that page). Nothing links to it except a header link that appears in browsers that have opened it once, it's `noindex`, and it isn't in the sitemap. It reads `feedback/data` straight from the repo on raw.githubusercontent.com, so new data shows up without a site redeploy (allow for a few minutes of CDN cache).

- **Claude costs:** every Claude call's tokens are counted per game, per day and per task (sorting posts, translating your posts, checking patch notes and your fixes, merging duplicates, drafting replies), with the cost estimated at list price (`PRICES` in `triage.py`; it matches the bill when the collector is all that uses the key). The time before counting started is estimated once from the saved posts (`estimate_past_usage` in `run.py`), on the low side. The Claude card shows credit left and what it's cost; clicking it opens a 30-day chart and the breakdown per game. Set your credit balance there from the billing page whenever you top up (`data/credit.json`, written only by the dashboard); it counts down from that, and Discord pings you once when it's below $2.
- **Status bar:** folded into one line (each service's mark and a dot) while everything works; it opens by itself when anything needs attention, and stays open in your browser once you open it. It shows which services the last run could and couldn't reach (Claude, Steam, discussions, Discord, Twitch, YouTube, news), each with a button to the fix; a missing key also gets a button to where it's made. "Out of Anthropic API credit" links straight to billing. It's recorded in `data/index.json` → `status` only when something changes.
- **Steam links:** buttons for the store page, reviews, discussions, news, Steamworks and the Steamworks sales report (sales aren't mirrored here).
- **Stat cards:** players now, positive reviews, followers on Steam, Discord members, open bugs and new posts. Players, reviews, followers and Discord open their chart (with update dates, sales and media marked) when clicked; followers and Discord show the change over 7 and 30 days.
- **Achievements:** the share of players who unlocked each, most common first, with the biggest step down marked: where many players stop.
- **In-game:** a placeholder for data the games will send themselves (sessions, where players quit, crashes, hardware). Nothing is collected yet.
- **Steam links on the site** carry `utm_source=fourgames.se&utm_medium=website` (`src/lib/games.js`), so Steamworks' **UTM Analytics** for each game counts the visits that came from the website.
- **Issues:** bug issues sorted by priority. Each has *Copy fix prompt* and the original posts with their translations and Steam links.
- **Suggestions:** the same view for suggestions.
- **Marking fixed:** each bug and idea has a round ✓. It asks what you changed (prefilled as a patch-notes line) and where the fix is: *in the next update*, or *already out in* an update you pick. The card leaves the list at once (the *Marked fixed* filter shows it; click the ✓ again to undo). The next run has Claude judge your line like patch notes, against just that issue (`apply_manual_fixes` in `run.py`): a real fix marks it **likely fixed**, with reply drafts and **still happening** as after a release; anything less marks it **partly addressed** and puts it back on the list. A fix in the next update takes that update's name when it's posted, and its reply drafts wait until then. A player reporting it again brings it back. It's saved in `data/cleared.json`, which only the dashboard writes, through GitHub's API with a fine-grained token (this repo only, *Contents: Read and write*) that you paste once per browser and that stays in that browser. Those commits say `[skip ci]`, so they don't redeploy the site. With `?data=` (a test copy), nothing is saved.
- **New on views:** a view with something from the last 48 hours that's newer than when you last opened it (in this browser, per game) is tagged *New*, like a new post.
- **Overview:** the week in one line, what needs attention, and the latest posts.
- **Bugs / Ideas sorting:** by priority, by negative reviews (what's costing you reviews), by most players, or only what came up in the first 2 hours of play (Steam's refund window). Each card has a *Copy patch-note line* button, e.g. "Fixed: … (reported by 3 players)".
- **Loved:** praise grouped like ideas, most players first, with a button to copy the list for store pages and trailers.
- **Media:** who's live on Twitch now, then every stream, video, article and Reddit post, newest first, with the channel's size, views and a button to join the chat or comment. What's live and what's new this week also show on the overview, and everything is marked along the bottom of the player and review charts (a stream as a bar for as long as it ran, anything else as a dot sized by its reach), so a jump in players shows what caused it.
- **Updates:** each update with negative reviews before and after it, what it fixed (from the patch notes or your ✓) and whether those reports stopped, and what came up since, crossed out once a later update fixed it.
- **Replies:** negative reviews and threads about something an update has since fixed, each with a drafted reply (Copy reply, Reply on Steam, Done).
- **Feed:** every post, newest first, with filters and search.

To point it at another copy of the data, add `?data=<base url>`, e.g. a local test run served by the dev server.

## Listening to posts

Each post and reply has a **Select** button that highlights its text; press your Speak Selection key (⌥ Esc by default, under System Settings → Accessibility → Read & Speak) to hear it in your own voice. A web page can't start macOS speech itself, and running a Shortcut from a link always brings the Shortcuts app to the front.

## Running it locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r feedback/requirements.txt
FEEDBACK_DATA_DIR=/tmp/fb/data FEEDBACK_DRY_RUN=1 .venv/bin/python feedback/run.py
```

- `FEEDBACK_DRY_RUN=1` skips Claude.
- Without `STEAM_PUBLISHER_KEY`, reviews come from the public, keyless host.
- Without `DISCORD_WEBHOOK_URL`, Discord payloads are printed instead of sent.
