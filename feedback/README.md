# Player feedback

Collects player feedback for every Four Games title on Steam, triages it with Claude, posts alerts to Discord and feeds the private dashboard at [fourgames.se/fb-dash](https://fourgames.se/fb-dash/). It runs from `.github/workflows/feedback.yml`. The website build doesn't use any of it.

## What a run does

1. **Games.** It gets the game list from the same publisher data the site uses. `games.mjs` reads `SITE.steam.publisher`/`.developer` and `GAMES`, and `steam.py` runs the same store search as `scripts/fetch-data.mjs`. New store pages are picked up automatically.
2. **Reviews.** It reads new and edited reviews from the Steamworks `IUserReviewsService/GetAppReviews` endpoint with the publisher key and the *Updated* filter, in all languages. It retries on HTTP 429 and stops at the last review it has already seen.
   - An edit keeps the old text in `versions`.
   - A changed recommendation is recorded in `flips`.
3. **Discussions.** It reads new threads and new replies in every subforum.
4. **Players.** It records the current player count.
5. **Triage.** It sends each new or edited post to Claude Haiku 4.5, with no extended thinking. Haiku:
   - translates the post to English;
   - sorts it as bug, suggestion, question or praise;
   - sets urgency and the game area;
   - drafts an optional one-sentence reply in the player's language, with its English meaning;
   - merges duplicates, across languages, into *issues* with mention counts. A mention is one distinct player.
6. **Issues.** Every issue gets a priority score. Every bug issue gets a ready-to-paste Claude Code fix prompt.
7. **Releases.** When a game publishes an update or patch-notes event, which `/ship` does, Claude matches the open issues against the patch notes and marks matches **likely fixed in vX**. If new reports of a likely-fixed issue arrive after that release, the issue becomes **still happening**.
8. **Discord.** It posts webhook embeds that link to the original post for:
   - urgent issues (with an @mention);
   - reviews flipped to negative;
   - repeated reports, at 3, 5, 10, 25… players (with an @mention);
   - one daily report, sent on the first run after 07:00 UTC.

   A game's first run only records a baseline, so the backfill doesn't flood Discord.

Every post's text is stored, so a post deleted on Steam isn't lost here. A file is rewritten only when its content changed, and the workflow commits only when something did.

## Schedule

The workflow fires every 20 minutes. `run.py --gate` is stdlib-only and finishes in seconds. It starts a full run when one of these is true:

- 4 hours have passed since the last full run;
- a game published an update less than 48 hours ago, so every tick is a full run;
- a game has an update the data doesn't know yet;
- someone started the workflow by hand (*Run workflow*).

The time of the last full run lives in the Actions cache (`feedback/.cache/`), not in git.

## Secrets

Set these under *Settings → Secrets and variables → Actions*. None of them is ever written to `data/` or the dashboard.

| Secret | What it is |
| --- | --- |
| `STEAM_PUBLISHER_KEY` | Steamworks Web API publisher key (Users & Permissions → Manage Groups → your group → Web API key). Tick *General*, and *Financial* for sales |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `DISCORD_WEBHOOK_URL` | The channel's webhook URL |
| `STEAM_FINANCIAL_KEY` | Only if sales need a different key than `STEAM_PUBLISHER_KEY` (optional) |
| `DISCORD_MENTION` | Who to ping: `<@USER_ID>`, `<@&ROLE_ID>` or a bare user ID (optional) |

## Data

- `data/index.json` holds the game list and the time of the last daily report.
- `data/games/<appid>.json` holds one game:
  - `items`: every post, keyed `r<id>` (review), `t<id>` (thread) or `c<id>` (reply);
  - `issues`;
  - `players`: `[time, count]`, stored only when the count changes;
  - `reviewTotals`: per day;
  - `releases`.

- `data/sales.json` holds Steam sales from `IPartnerFinancialsService`: one total per day and game, with net and gross USD, units, refunds, the discount and countries. Package sales count toward the package's primary app.
  - Days are Pacific time.
  - Steam restates days as payments settle; each run rebuilds the days Steam reports as changed.
  - "Net" is after refunds and tax, before Steam's cut.

This repo is public, so this data is too. Valve lets developers share their own sales data "as they see fit". It's all public on Steam anyway.

## Dashboard

`/fb-dash` is a page of the site (`src/views/FeedbackView.vue`, with the dashboard itself in `src/lib/feedback/`, loaded only on that page). Nothing links to it except a header link that appears in browsers that have opened it once, it's `noindex`, and it isn't in the sitemap. It reads `feedback/data` straight from the repo on raw.githubusercontent.com, so new data shows up without a site redeploy (allow for a few minutes of CDN cache).

- **Top bar:** players now, review score, open bugs, issues still happening, new posts, and the latest update.
- **Issues:** bug issues sorted by priority. Each has *Copy fix prompt*, the original posts with their translations and Steam links, and the draft replies with copy buttons.
- **Suggestions:** the same view for suggestions.
- **Feed:** every post, newest first, with filters and search.
- **Sales:** net revenue per day or week, with updates and discounts marked, plus units sold, refund rate, lifetime totals and top countries. It's filled in once the Steam key has the *Financial* permission.
- **Stats:** concurrent players and new reviews over time, with every update marked, plus posts by category and by language.

To point it at another copy of the data, add `?data=<base url>`, e.g. a local test run served by the dev server.

## Running it locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r feedback/requirements.txt
FEEDBACK_DATA_DIR=/tmp/fb/data FEEDBACK_DRY_RUN=1 .venv/bin/python feedback/run.py
```

- `FEEDBACK_DRY_RUN=1` skips Claude.
- Without `STEAM_PUBLISHER_KEY`, reviews come from the public, keyless host.
- Without `DISCORD_WEBHOOK_URL`, Discord payloads are printed instead of sent.
