"""Claude calls: per-post translation and triage, and matching open issues against a release's patch
notes. Both use Claude Haiku 4.5, the cheapest current model, with no extended thinking (Haiku 4.5
has no effort setting; leaving out `thinking` is its lowest). Set FEEDBACK_DRY_RUN=1 to run without
an API key."""

import os
from typing import Literal, Optional

from pydantic import BaseModel, Field

MODEL = "claude-haiku-4-5"
DRY_RUN = os.environ.get("FEEDBACK_DRY_RUN") == "1"

_client = None


def client():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic(max_retries=4)
    return _client


# What each model costs, in dollars per million tokens (input, output). Update when MODEL changes.
PRICES = {"claude-haiku-4-5": (1.00, 5.00)}

# Tokens used by the Claude calls of this process, added up, in total and per task; run.py reads it
# before and after each game to keep a running total per game, per day and per task.
USAGE = {"input": 0, "output": 0, "calls": 0, "cost": 0.0, "tasks": {}}


def _parse(task, **kwargs):
    """messages.parse, counting what the call used under `task` (a failed parse was still billed)."""
    response = client().messages.parse(**kwargs)
    usage = response.usage
    tokens_in = usage.input_tokens + (usage.cache_creation_input_tokens or 0) + (usage.cache_read_input_tokens or 0)
    price_in, price_out = PRICES.get(kwargs["model"], (0, 0))
    used = {"input": tokens_in, "output": usage.output_tokens, "calls": 1, "cost": (tokens_in * price_in + usage.output_tokens * price_out) / 1e6}
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
    still_after_fix: bool = Field(
        description="True only if the issue this point joins is listed as likely fixed, and the point says the problem "
        "is still there in the fixed version. Mentioning the old problem, or an older experience, is not enough."
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
    note: Optional[str] = Field(
        description="Usually null. Only when the English would mislead on its own: one short sentence explaining a meme, "
        "slang term, sarcasm or reference. Never your reading of the player's opinion."
    )


TRIAGE_SYSTEM = """You triage player feedback for an indie game studio's Steam games. Each message is one post: \
a Steam review, a discussion thread's opening post, or a reply in a thread.

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
doesn't join a dynamite one): start a new issue instead. Points in one post that are \
about the same thing share one title. A reply such as "same here" in a thread whose opening post belongs to issues \
repeats them. Praise points likewise join a "what players love" item (listed with kind "praise"), e.g. "Satisfying \
chainsaw digging"; each such item is one specific thing (the digging, the sound, the developer's quick updates), \
never a catch-all like "fun gameplay", so praise for something else starts its own item. Questions join nothing. Each point also gets its own urgency, on the scale above.
- Some listed issues say they were likely fixed in an update, and how. A point that joins one sets still_after_fix \
only when it clearly says the problem persists after that fix (e.g. "still no explanation even after the update"); \
a player describing the old problem, or playing an older version, doesn't count.
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
    if context:
        meta.append(context)
    text = (f"Title: {item['title']}\n\n" if item.get("title") else "") + (item.get("text") or "")
    content = (
        "\n".join(meta)
        + f"\n\nOpen issues:\n{issue_lines or '(none yet)'}"
        + f"\n\n<post>\n{text[:12000]}\n</post>"
    )
    response = _parse("sort",
        model=MODEL,
        max_tokens=4000,
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
                      new_issue_title="Dry-run issue: " + text[:60], still_after_fix=False)],
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
        model=MODEL,
        max_tokens=1000,
        system=FIX_REPLY_SYSTEM,
        messages=[{"role": "user", "content": content}],
        output_format=FixReply,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"fix reply stopped with {response.stop_reason}")
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
        model=MODEL,
        max_tokens=4000,
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
        "about different items. Only list groups of two or more; leave everything else out."
    )
    response = _parse("merge",
        model=MODEL,
        max_tokens=2000,
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
        model=MODEL,
        max_tokens=4000,
        system="Translate the developer's post on Steam to English, keeping its meaning and tone. If it is already "
        "in English, leave english empty: don't copy it.",
        messages=[{"role": "user", "content": f"<post>\n{text[:12000]}\n</post>"}],
        output_format=Translation,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"translation stopped with {response.stop_reason}")
    return response.parsed_output
