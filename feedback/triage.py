"""Claude calls: per-post translation and triage, and matching open issues against a release's patch
notes. They all use the newest Claude Haiku the API key can use (`model()`), the cheapest tier: a new
Haiku is picked up by itself, and Claude Haiku 5.5 is used if the model list can't be read. Effort is
`low`, the least thinking, where the model has an effort setting. Set FEEDBACK_DRY_RUN=1 to run
without an API key."""

import os
from typing import Literal, Optional

from pydantic import BaseModel, Field

FALLBACK_MODEL = "claude-haiku-5-5"
DRY_RUN = os.environ.get("FEEDBACK_DRY_RUN") == "1"

_client = None
_model = None


def client():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic(max_retries=4)
    return _client


def model():
    """{id, effort} of the newest Haiku the key can use, looked up once per run; `effort` is whether
    it takes an effort setting (Haiku 4.5 doesn't)."""
    global _model
    if _model is None:
        _model = {"id": FALLBACK_MODEL, "effort": True}
        if not DRY_RUN:
            try:
                haikus = [m for m in client().models.list() if m.id.startswith("claude-haiku-") and m.capabilities["structured_outputs"]["supported"]]
                if haikus:
                    newest = max(haikus, key=lambda m: m.created_at)
                    _model = {"id": newest.id, "effort": bool(newest.capabilities["effort"]["low"]["supported"])}
            except Exception as error:  # noqa: BLE001 - the fallback works too
                print(f"[claude] couldn't list the models ({type(error).__name__}: {error}); using {FALLBACK_MODEL}")
        print(f"[claude] using {_model['id']}")
    return _model


# What each model costs, in dollars per million tokens: (input, output), and above `over` prompt
# tokens the (input, output) beyond it. A Haiku newer than these is counted at the newest one's price
# until it's added here.
PRICES = {
    "claude-haiku-4-5": {"base": (1.00, 5.00)},
    "claude-haiku-5-5": {"base": (0.10, 0.50), "over": 100_000, "beyond": (0.50, 2.50)},
}


def cost(model_id, tokens_in, tokens_out):
    price = PRICES.get(model_id) or PRICES[FALLBACK_MODEL]
    price_in, price_out = price["beyond"] if tokens_in > price.get("over", float("inf")) else price["base"]
    return (tokens_in * price_in + tokens_out * price_out) / 1e6


# Tokens used by the Claude calls of this process, added up, in total and per task; run.py reads it
# before and after each game to keep a running total per game, per day and per task.
USAGE = {"input": 0, "output": 0, "calls": 0, "cost": 0.0, "tasks": {}}


def _parse(task, **kwargs):
    """messages.parse on the newest Haiku at low effort, counting what the call used under `task` (a
    failed parse was still billed)."""
    m = model()
    if m["effort"]:
        kwargs["output_config"] = {"effort": "low"}
    response = client().messages.parse(model=m["id"], **kwargs)
    usage = response.usage
    tokens_in = usage.input_tokens + (usage.cache_creation_input_tokens or 0) + (usage.cache_read_input_tokens or 0)
    used = {"input": tokens_in, "output": usage.output_tokens, "calls": 1, "cost": cost(m["id"], tokens_in, usage.output_tokens)}
    for bucket in (USAGE, USAGE["tasks"].setdefault(task, {"input": 0, "output": 0, "calls": 0, "cost": 0.0})):
        for k, v in used.items():
            bucket[k] += v
    return response


def describe_error(error):
    """(message for the dashboard, whether retrying this run is pointless) for a failed Claude call."""
    import anthropic

    if isinstance(error, anthropic.BadRequestError) and "credit balance" in str(error):
        return "Out of Anthropic API credit.", True
    if isinstance(error, anthropic.AuthenticationError):
        return "The ANTHROPIC_API_KEY secret is invalid or was revoked.", True
    if isinstance(error, anthropic.PermissionDeniedError):
        return "The Anthropic API key isn't allowed to use this model.", True
    if isinstance(error, anthropic.RateLimitError):
        return "Anthropic rate-limited the requests; they'll be retried next run.", True
    if isinstance(error, anthropic.APIConnectionError):
        return "Couldn't reach the Anthropic API.", True
    return f"Claude calls are failing ({type(error).__name__}).", False


class Point(BaseModel):
    kind: Literal["bug", "complaint", "suggestion", "question", "praise"]
    quote: str = Field(description="The player's own words this point comes from: a short exact excerpt of the post, in its original language.")
    text: str = Field(description="The point in one short English sentence, as a developer would note it, saying only what the quote says.")
    urgency: Literal["low", "medium", "high", "urgent"]
    existing_issue: Optional[str] = Field(description="For a bug, complaint, suggestion or praise: the ID of the listed issue it repeats, or null.")
    new_issue_title: Optional[str] = Field(
        description="For a bug, complaint, suggestion or praise matching no listed issue: a short, general English title "
        "other players' posts about the same thing would fit. Null for questions."
    )
    at: Optional[str] = Field(
        description="Only for notes on a YouTube video: the time in brackets on the line this point comes from, as "
        "written there, e.g. '12:30' or '1:02:30'. Null for every other post."
    )
    still_after_fix: bool = Field(
        description="True only if the issue this point joins is listed as likely fixed, and the point says the problem "
        "is still there in the fixed version. Mentioning the old problem, or an older experience, is not enough. "
        "A complaint about what the fix added (the issue asked for something, the point says the new thing is too "
        "much, too harsh or badly tuned) is not this issue at all: start a new one."
    )


class Triage(BaseModel):
    language: str = Field(description="Language the post is written in, as an English name, e.g. 'Japanese'.")
    english: str = Field(description="The full post translated to English, or an empty string if it is already in English.")
    summary: str = Field(description="One short English sentence: what the player is saying.")
    category: Literal["bug", "suggestion", "question", "praise"]
    urgency: Literal["low", "medium", "high", "urgent"]
    area: str = Field(description="The part of the game it's about, 1-3 words, e.g. 'controls', 'performance', 'level 3'.")
    details: Optional[str] = Field(
        description="For a bug: what a developer needs to reproduce it (steps, hardware, settings, when it happens). Else null."
    )
    tone: Literal["sincere", "joke", "sarcastic", "mixed"] = Field(
        description="How the post is meant: a joke or meme, sarcasm (the words mean the opposite), or sincere."
    )
    points: list[Point] = Field(
        description="Every point the post makes, at least one even for a one-liner, most actionable first (bugs, "
        "then complaints and suggestions, then questions, then praise)."
    )
    about_game: bool = Field(
        description="False only when the post says nothing about the game itself: a YouTube comment that's only about "
        "the video, the creator or something else (\"great video\", \"first\", a joke about the creator), or a refund note that "
        "only says they bought it by accident or changed their mind. Steam reviews and threads: true."
    )
    note: Optional[str] = Field(
        description="Usually null. Only when the English would mislead on its own: one short sentence explaining a meme, "
        "slang term, sarcasm or reference. Never your reading of the player's opinion."
    )


TRIAGE_SYSTEM = """You triage player feedback for an indie game studio's Steam games. Each message is one post: \
a Steam review, a discussion thread's opening post, a reply in a thread, a comment under a YouTube video about \
the game, a note a player left when refunding the game, or notes on what a YouTube creator said while playing it (a summary and the points, with times).

- Translate the whole post to English, keeping the player's meaning and tone. If the post is already in English, \
leave english empty: don't copy it.
- category: "bug" for anything broken (crashes, errors, glitches, performance problems, things not working as \
intended); "suggestion" for requests, ideas and complaints about design, balance, price or content; "question" \
when the player mainly asks something; "praise" for posts that are mostly positive with nothing to act on.
- urgency: "urgent" only for crashes on start, lost saves or progress, the game being unplayable, or many players \
blocked; "high" for serious bugs or a strongly negative review that names a fixable problem; "medium" for ordinary \
bugs and popular requests; "low" for everything else.
- Issues: the user message lists the game's open issues (bugs and ideas). Every bug, complaint and suggestion \
point belongs to one: if it is the same underlying problem or request as a listed issue, in any language, set its \
existing_issue to that ID; otherwise give new_issue_title, a short, general title that other players' posts about \
the same thing would also fit (e.g. "Chainsaw upgrades feel meaningless", not a quote). A point about a different \
item, tool or feature never joins an issue just because the complaint sounds alike (a chainsaw upgrade complaint \
doesn't join a dynamite one): start a new issue instead. Nor does a point join an issue that asks for the \
opposite: "there's no limit" and "the limit is too strict" are two issues, even about the same item. Points in one post that are \
about the same thing share one title. A reply such as "same here" in a thread whose opening post belongs to issues \
repeats them. Praise points likewise join a "what players love" item (listed with kind "praise"), e.g. "Satisfying \
chainsaw digging"; each such item is one specific thing (the digging, the sound, the developer's quick updates), \
never a catch-all like "fun gameplay", so praise for something else starts its own item. Join a listed praise item \
only when the point praises that same specific thing, not just because the item's title is broad enough to fit. \
Praise for two things is two points (e.g. "quick updates, and the controls feel better now" is one point for the \
developer's responsiveness and one for the controls). Questions join nothing. Each point also gets its own urgency, on the scale above.
- Some listed issues say they were likely fixed in an update, and how. A point that joins one sets still_after_fix \
only when it clearly says the problem persists after that fix (e.g. "still no explanation even after the update"); \
a player describing the old problem, or playing an older version, doesn't count. A complaint about what the fix \
itself added, or the opposite of the issue (an issue asks for a limit or cost, the point says the new one is too \
harsh), is a new issue, not the old one still happening.
- Read the post the way a native speaker and Steam regular would. Steam reviews are full of memes and irony: a \
recommended review that only says "run away" (Korean "도망쳐") jokes that the game is addictive or hard, not a \
warning. Set tone accordingly and triage what the player actually means.
- note is for the rare post whose English would be misread without it (a meme, slang, a sarcastic line, a game \
reference). Leave it null otherwise; most posts need none. Don't use it to summarise, judge or interpret the post.
- points: break a long post into the separate things it says, for the developer reading it (not a buyer's TL;DR): \
each bug, complaint, suggestion, question and bit of praise as its own short line, most actionable first. Keep the \
player's specifics (numbers, places, items). Each point quotes the words it comes from and says only what they say: \
never attach a complaint to an item the player didn't name in it (if they complain about the sound, and separately \
call the dynamite a rip-off, that's two points: sound, and dynamite value). Every post gets at least one point, a one-liner included, so the \
developer can see at a glance whether it's a bug, complaint, suggestion, question or praise."""


def triage(game_name, item, issues, context=None):
    """Returns a Triage for one post. `issues` are the game's open issues ({id, kind, title, area, mentions})."""
    if DRY_RUN:
        return _dry_triage(item)
    issue_lines = "\n".join(
        f"{i['id']} [{i['kind']}, {i['area']}] {i['title']} ({i['mentions']} mentions)"
        + (f" (likely fixed in {i['fixedIn']}: {i['fixReason']})" if i.get("fixedIn") else "")
        for i in issues
    )
    meta = [f"Game: {game_name}", f"Post type: {item['kind']}"]
    if item["kind"] == "review":
        meta.append(f"Review: {'recommended' if item.get('votedUp') else 'NOT recommended'}, {item.get('playtime', 0)} h played")
    if item["kind"] == "video":
        meta.append("These are notes on what a YouTube creator said about the game in their video, not their own words: "
                    "triage each listed point as theirs, keeping its kind and its time.")
    if item["kind"] == "refund":
        meta.append(f"A note the player left when refunding the game on Steam (reason they picked: {item.get('refundReason') or 'unknown'}). "
                    "Treat it like a negative review: what made them want their money back. A note that says nothing about "
                    "the game itself (bought it by accident, changed their mind, a gift) is not about the game.")
    if item["kind"] == "comment":
        meta.append(f"A viewer's comment under the YouTube video \"{item.get('videoTitle') or ''}\". Only what it says about the "
                    "game counts; praise or jokes about the video or the creator aren't about the game.")
    if context:
        meta.append(context)
    text = (f"Title: {item['title']}\n\n" if item.get("title") else "") + (item.get("text") or "")
    content = (
        "\n".join(meta)
        + f"\n\nOpen issues:\n{issue_lines or '(none yet)'}"
        + f"\n\n<post>\n{text[:12000]}\n</post>"
    )
    response = _parse("sort",
        max_tokens=16000,
        system=TRIAGE_SYSTEM,
        messages=[{"role": "user", "content": content}],
        output_format=Triage,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"triage stopped with {response.stop_reason}")
    return response.parsed_output


def _dry_triage(item):
    text = item.get("text") or ""
    bug = any(w in text.lower() for w in ("crash", "bug", "broken", "freeze", "error"))
    kind = "bug" if bug else ("praise" if item.get("votedUp", True) else "complaint")
    return Triage(
        language="English",
        english=text,
        summary=text[:120],
        category="bug" if bug else ("praise" if item.get("votedUp", True) else "suggestion"),
        urgency="high" if bug else "low",
        area="general",
        details=None,
        tone="sincere",
        points=[Point(kind=kind, quote=text[:80], text=text[:120], urgency="high" if bug else "low", existing_issue=None,
                      new_issue_title="Dry-run issue: " + text[:60], still_after_fix=False, at=None)],
        about_game=True,
        note=None,
    )


class Fix(BaseModel):
    issue: str = Field(description="The issue's ID.")
    fit: Literal["direct", "partial"] = Field(
        description="direct: a line fixes or implements exactly what players asked for. partial: a line helps with it "
        "but doesn't do what they asked."
    )
    reason: str = Field(description="Short reason, quoting the patch-notes line.")


class ReleaseMatch(BaseModel):
    fixed: list[Fix]


class FixReply(BaseModel):
    text: str = Field(description="The reply, in the player's language.")
    english: str = Field(description="What the reply says, in English.")


FIX_REPLY_SYSTEM = """You write a developer's reply to a player on Steam, for one case only: the problem the \
player wrote about has since been fixed in an update. Steam's guidance is to reply only to address a specific \
issue or misinformation, clearly and concisely, so:
- One or two short sentences, in the player's own language.
- Say that the problem they described is fixed, name it in their own terms, and give the update version.
- Only say what the patch-notes line given to you says the update changed. Never invent or embellish features, \
mechanics or details; if the line is short, keep the reply short.
- Thank them for reporting it. If it's a negative review, you may invite them to give the game another try; never \
ask them to change their review.
- No promises, no excuses, no marketing, no arguing."""


def fix_reply(game_name, item, issue_title, version, change):
    """A short reply telling the player that what they reported is fixed in `version`; `change` is
    the patch-notes line that fixed it, the only thing the reply may describe."""
    if DRY_RUN:
        return FixReply(text=f"Thanks for reporting this! It's fixed in {version}.", english=f"Thanks for reporting this! It's fixed in {version}.")
    t = item.get("triage") or {}
    content = (
        f"Game: {game_name}\nFixed in: {version}\nWhat players reported: {issue_title}\n"
        f"What the patch notes say changed: {change}\n"
        f"Post type: {item['kind']}{' (negative review)' if item['kind'] == 'review' and not item.get('votedUp') else ''}\n"
        f"Player's language: {t.get('language') or 'unknown'}\n\n<post>\n{(item.get('text') or '')[:6000]}\n</post>"
    )
    response = _parse("reply",
        max_tokens=4000,
        system=FIX_REPLY_SYSTEM,
        messages=[{"role": "user", "content": content}],
        output_format=FixReply,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"fix reply stopped with {response.stop_reason}")
    return response.parsed_output


THANKS_REPLY_SYSTEM = """You write a developer's reply to a positive Steam review. The goal is a warm thank-you \
that gives the player a reason to come back and play again:
- Two or three short sentences, in the player's own language, sounding like a small indie developer, not a brand.
- Thank them, and mention one specific thing they said they liked, in their own terms.
- If an update came out after their review, mention it by name and invite them to jump back in and try it. You may \
name one or two changes from its patch notes, ideally ones related to what they liked; only describe what the notes \
actually say. Without an update, you may say more is coming, but promise nothing specific.
- If you're told a problem or wish from their review has since been fixed, say so first, in their own terms, with \
the version; only say what the given patch-notes line says changed. That's the best reason to come back.
- Any other problem or wish they mentioned: acknowledge it in a few words at most; never promise a fix or a date.
- Never ask them to change, edit or upvote their review, and no hard selling (no other games, no sales, no links)."""


def thanks_reply(game_name, item, name, since, fixes):
    """A short thank-you to a positive review that invites the player back for update `name`, when
    there is one; `since` is every update since the review, newest first, for its patch notes, and
    `fixes` the (complaint, version, patch-notes line) of what it reported that's since fixed."""
    if DRY_RUN:
        text = "Thanks so much for the review!" + "".join(f" {t} is fixed in {v}." for t, v, _ in fixes) + (f" {name} is out now, come take a look." if name else "")
        return FixReply(text=text, english=text)
    t = item.get("triage") or {}
    notes = "\n\n".join(f"{r['name']}:\n{r.get('notes') or ''}" for r in since)[:3000]
    update = f"Update to name: {name}\nPatch notes of every update since their review:\n{notes}" if name else "No update since their review."
    if fixes:
        update += "\nFixed since their review:" + "".join(f"\n- {t} (fixed in {v}; the patch notes say: {c})" for t, v, c in fixes)
    content = (
        f"Game: {game_name}\n{update}\n"
        f"Hours played when reviewing: {item.get('playtime') or 'unknown'}\n"
        f"Player's language: {t.get('language') or 'unknown'}\n\n<review>\n{(item.get('text') or '')[:6000]}\n</review>"
    )
    response = _parse("reply",
        max_tokens=4000,
        system=THANKS_REPLY_SYSTEM,
        messages=[{"role": "user", "content": content}],
        output_format=FixReply,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"thanks reply stopped with {response.stop_reason}")
    return response.parsed_output


def match_release(game_name, release, issues):
    """IDs (with a one-line reason) of the open issues the patch notes most likely address."""
    if not issues:
        return []
    if DRY_RUN:
        return []
    issue_lines = "\n".join(
        f"{i['id']} [{i['kind']}, {i['area']}] {i['title']}"
        + (f"\n   players said: {' | '.join(i['said'])}" if i.get("said") else f": {i.get('details') or i.get('summary') or ''}")
        for i in issues
    )
    prompt = (
        f"These are the patch notes for {game_name} {release['version'] or release['name']}:\n\n"
        f"<patch_notes>\n{release['body'][:20000]}\n</patch_notes>\n\n"
        f"These are the open player-reported issues:\n\n<issues>\n{issue_lines}\n</issues>\n\n"
        "List the issues a line in the patch notes addresses, each with a short reason quoting that line. Judge by "
        "what the players actually said: fit is direct only when the line fixes or implements exactly that (a missing "
        "tutorial needs a tutorial, hint or explanation; cheaper upgrades don't explain anything); a line that helps "
        "without doing what they asked is partial. Leave out everything else."
    )
    response = _parse("patch",
        max_tokens=16000,
        messages=[{"role": "user", "content": prompt}],
        output_format=ReleaseMatch,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"release matching stopped with {response.stop_reason}")
    known = {i["id"] for i in issues}
    return [m.model_dump() for m in response.parsed_output.fixed if m.issue in known]



class Duplicates(BaseModel):
    ids: list[str] = Field(description="Two or more issue IDs that are the same thing.")
    title: str = Field(description="A short, general title for the merged issue.")


class DuplicateGroups(BaseModel):
    groups: list[Duplicates]


def find_duplicates(game_name, issues):
    """Groups of issues that are the same underlying problem or request (or the same praised thing)."""
    if len(issues) < 2 or DRY_RUN:
        return []
    issue_lines = "\n".join(
        f"{i['id']} [{i['kind']}, {i['area']}] {i['title']} ({i['mentions']} mentions)"
        + (f"\n   players said: {' | '.join(i['said'])}" if i.get("said") else "")
        for i in issues
    )
    prompt = (
        f"These are the player-reported issues for {game_name}, sorted one post at a time, so some may be "
        f"duplicates:\n\n<issues>\n{issue_lines}\n</issues>\n\n"
        "Group the issues that are the same underlying problem, request or praised thing: ones one change would "
        "settle (e.g. \"game too short\" and \"needs more content\"). Don't group issues that are only related or "
        "about different items. Praise groups only when it's the same specific thing (\"satisfying digging\" and \"digging "
        "feels great\"), never into a broad theme like \"fun gameplay\". Bugs and ideas likewise never group into a theme "
        "(\"lacks progression\", \"needs polish\", \"UI problems\"): issues about different items, tools or features stay "
        "apart even when they share an area or sound alike, and the merged title must still name one specific thing. "
        "Only list groups of two or more; leave everything else out."
    )
    response = _parse("merge",
        max_tokens=16000,
        messages=[{"role": "user", "content": prompt}],
        output_format=DuplicateGroups,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"duplicate check stopped with {response.stop_reason}")
    known = {i["id"]: i["kind"] for i in issues}
    groups = []
    for g in response.parsed_output.groups:
        ids = list(dict.fromkeys(i for i in g.ids if i in known))
        # Praise never merges with bugs or ideas.
        if len(ids) >= 2 and len({known[i] == "praise" for i in ids}) == 1:
            groups.append({"ids": ids, "title": g.title})
    return groups


class Translation(BaseModel):
    language: str = Field(description="Language the text is written in, as an English name, e.g. 'German'.")
    english: str = Field(description="The text translated to English, or an empty string if it is already in English.")


def translate(text):
    """Just a translation, for the developer's own posts and replies (they aren't triaged)."""
    if DRY_RUN:
        return Translation(language="English", english="")
    response = _parse("translate",
        max_tokens=16000,
        system="Translate the developer's post on Steam to English, keeping its meaning and tone. If it is already "
        "in English, leave english empty: don't copy it.",
        messages=[{"role": "user", "content": f"<post>\n{text[:12000]}\n</post>"}],
        output_format=Translation,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"translation stopped with {response.stop_reason}")
    return response.parsed_output


class VideoPoint(BaseModel):
    kind: Literal["bug", "complaint", "suggestion", "question", "praise"]
    text: str = Field(description="The point in one short English sentence, as a developer would note it, keeping the specifics.")
    quote: str = Field(description="The creator's own words this point comes from: a short exact excerpt of the transcript, in its original language.")
    at: str = Field(description="The [time] mark of the transcript line the quote is in, as written there, e.g. '12:30' or '1:02:30'.")


class VideoReview(BaseModel):
    summary: str = Field(description="One or two short English sentences: what the video is (a let's play, a review, a stream, a short) and how the creator came across on the game overall.")
    verdict: Literal["positive", "mixed", "negative", "unclear"] = Field(description="How the creator felt about the game overall.")
    points: list[VideoPoint] = Field(
        description="Every bug, complaint, suggestion, question about the game and bit of specific praise, most actionable "
        "first (bugs, then complaints and suggestions, then questions, then praise). Empty if the video says nothing about the game."
    )


VIDEO_REVIEW_SYSTEM = """You watch YouTube videos about an indie studio's game for its developer, through the video's \
transcript, so they don't have to watch them. The transcript comes from captions, often generated by YouTube: expect \
misheard words, no punctuation and the game's name spelled wrong. Each line starts with a [time] mark.

- Pick out what the developer can use: bugs the creator runs into or reports (glitches, crashes, things not working, \
performance), complaints and confusion (what they didn't understand, where they got stuck, what felt bad, too slow, \
too hard, too expensive), suggestions and wishes ("I wish you could...", "it needs..."), questions they ask about the \
game, and specific praise (what they enjoyed, laughed at or kept coming back to). Confusion counts: a creator who \
can't find how to do something is telling the developer about the tutorial or UI.
- Only what's about this game. Skip channel talk, sponsors, chat banter and other games, unless the creator compares \
this game with another one.
- Read it the way the creator means it: let's players joke, exaggerate and play up reactions for the camera. Sarcasm \
or a scripted scream is not a complaint; a real "this is annoying" said three times is.
- One point per distinct thing; a thing the creator says many times is one point, with the time it first or most \
clearly comes up. Keep the specifics (items, places, numbers). Say only what the creator says, in one short English \
sentence each, with the exact words it comes from and the [time] mark of their line.
- The summary is for deciding whether the video is worth watching: what kind of video it is and how the creator \
came across on the game."""

VIDEO_TRANSCRIPT_LIMIT = 300_000  # characters: about 6 hours of talking; a longer stream is cut there


def _clock(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def parse_clock(text):
    """'1:02:30' or '12:30' → seconds, or None."""
    parts = (text or "").strip("[] ").split(":")
    if not 2 <= len(parts) <= 3 or not all(p.isdigit() for p in parts):
        return None
    return sum(int(p) * 60**i for i, p in enumerate(reversed(parts)))


def video_review(game_name, item, lines):
    """Returns a VideoReview for one video, from its transcript `lines` [(seconds, text)]."""
    if DRY_RUN:
        return VideoReview(summary="Dry-run review.", verdict="unclear", points=[])
    # A [time] mark about every 20 seconds, so each point can link to its moment in the video.
    rows, row, start = [], [], None
    for seconds, text in lines:
        if start is None:
            start = seconds
        row.append(text.replace("\n", " "))
        if seconds - start >= 20:
            rows.append(f"[{_clock(start)}] {' '.join(row)}")
            row, start = [], None
    if row:
        rows.append(f"[{_clock(start)}] {' '.join(row)}")
    text = "\n".join(rows)[:VIDEO_TRANSCRIPT_LIMIT]
    meta = [f"Game: {game_name}", f"Video: {item.get('title') or '(no title)'}", f"Channel: {item.get('author') or 'unknown'}"]
    if item.get("duration"):
        meta.append(f"Length: {_clock(item['duration'])}")
    if item.get("text"):
        meta.append(f"Description: {item['text']}")
    response = _parse("video",
        max_tokens=16000,
        system=VIDEO_REVIEW_SYSTEM,
        messages=[{"role": "user", "content": "\n".join(meta) + f"\n\n<transcript>\n{text}\n</transcript>"}],
        output_format=VideoReview,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"video review stopped with {response.stop_reason}")
    return response.parsed_output
