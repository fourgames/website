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


class DraftReply(BaseModel):
    text: str = Field(description="One friendly sentence from the developer, in the player's language.")
    english: str = Field(description="What that sentence means in English.")


class Triage(BaseModel):
    language: str = Field(description="Language the post is written in, as an English name, e.g. 'Japanese'.")
    english: str = Field(description="The full post translated to English (unchanged if it already is English).")
    summary: str = Field(description="One short English sentence: what the player is saying.")
    category: Literal["bug", "suggestion", "question", "praise"]
    urgency: Literal["low", "medium", "high", "urgent"]
    area: str = Field(description="The part of the game it's about, 1-3 words, e.g. 'controls', 'performance', 'level 3'.")
    existing_issue: Optional[str] = Field(description="ID of the open issue this repeats, or null.")
    new_issue_title: Optional[str] = Field(
        description="For a bug or suggestion that matches no listed issue: a short English title for a new issue. Else null."
    )
    details: Optional[str] = Field(
        description="For a bug: what a developer needs to reproduce it (steps, hardware, settings, when it happens). Else null."
    )
    reply: Optional[DraftReply] = Field(description="A reply worth posting, or null when none is needed.")


TRIAGE_SYSTEM = """You triage player feedback for an indie game studio's Steam games. Each message is one post: \
a Steam review, a discussion thread's opening post, or a reply in a thread.

- Translate the whole post to English, keeping the player's meaning and tone.
- category: "bug" for anything broken (crashes, errors, glitches, performance problems, things not working as \
intended); "suggestion" for requests, ideas and complaints about design, balance, price or content; "question" \
when the player mainly asks something; "praise" for posts that are mostly positive with nothing to act on.
- urgency: "urgent" only for crashes on start, lost saves or progress, the game being unplayable, or many players \
blocked; "high" for serious bugs or a strongly negative review that names a fixable problem; "medium" for ordinary \
bugs and popular requests; "low" for everything else.
- Duplicates: the user message lists the game's open issues. If the post reports the same underlying problem or \
request as one of them, in any language, set existing_issue to that issue's ID. A reply such as "same here" or \
"me too" in a thread whose opening post belongs to an issue repeats that issue. Otherwise, for a bug or \
suggestion, give new_issue_title. Questions and praise get neither.
- reply: draft one short, warm, specific sentence the developer could post back, in the player's own language, \
when a reply would help (a bug report, a question, a negative review, a thoughtful suggestion). Never promise \
dates or features. Null for posts that need no answer."""


def triage(game_name, item, issues, context=None):
    """Returns a Triage for one post. `issues` are the game's open issues ({id, kind, title, area, mentions})."""
    if DRY_RUN:
        return _dry_triage(item)
    issue_lines = "\n".join(f"{i['id']} [{i['kind']}, {i['area']}] {i['title']} ({i['mentions']} mentions)" for i in issues)
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
    response = client().messages.parse(
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
    return Triage(
        language="English",
        english=text,
        summary=text[:120],
        category="bug" if bug else ("praise" if item.get("votedUp", True) else "suggestion"),
        urgency="high" if bug else "low",
        area="general",
        existing_issue=None,
        new_issue_title=("Dry-run issue: " + text[:60]) if bug or not item.get("votedUp", True) else None,
        details=None,
        reply=None,
    )


class Fix(BaseModel):
    issue: str = Field(description="The issue's ID.")
    reason: str = Field(description="Short reason, quoting the patch-notes line.")


class ReleaseMatch(BaseModel):
    fixed: list[Fix]


def match_release(game_name, release, issues):
    """IDs (with a one-line reason) of the open issues the patch notes most likely address."""
    if not issues:
        return []
    if DRY_RUN:
        return []
    issue_lines = "\n".join(
        f"{i['id']} [{i['kind']}, {i['area']}] {i['title']}: {i.get('details') or i.get('summary') or ''}" for i in issues
    )
    prompt = (
        f"These are the patch notes for {game_name} {release['version'] or release['name']}:\n\n"
        f"<patch_notes>\n{release['body'][:20000]}\n</patch_notes>\n\n"
        f"These are the open player-reported issues:\n\n<issues>\n{issue_lines}\n</issues>\n\n"
        "List the issues that a line in the patch notes most likely fixes or implements, each with a short reason "
        "quoting that line. Only include clear matches; leave out anything the notes don't address."
    )
    response = client().messages.parse(
        model=MODEL,
        max_tokens=4000,
        messages=[{"role": "user", "content": prompt}],
        output_format=ReleaseMatch,
    )
    if response.stop_reason != "end_turn" or response.parsed_output is None:
        raise RuntimeError(f"release matching stopped with {response.stop_reason}")
    known = {i["id"] for i in issues}
    return [m.model_dump() for m in response.parsed_output.fixed if m.issue in known]
