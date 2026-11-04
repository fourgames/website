"""Which engine a game is made with: Steam doesn't say, so this collects public hints.

Each hint is a row in engine_signals (appid, engine, source, strength, evidence). Sources so far:

- pcgamingwiki: the game's PCGamingWiki infobox lists the engine (strength 2), or the page only
  links the engine somewhere else, e.g. a fan port (strength 1). See pcgw.py.
- store_legal / store_text: the store page's legal notice or description names the engine in a
  "made with Godot" sort of way (strength 2). Found in the appdetails reply we fetch anyway, so it
  costs no extra requests; only the match and a short snippet are kept.
- manual: added by hand (see the README).

A game is in the Godot set (apps.godot = 1, sampled most often) when it has a Godot signal of
strength 2 from any source. New sources only need to write rows here and call
Store.refresh_godot().
"""

from __future__ import annotations

import re
from dataclasses import dataclass

STRONG, MENTION = 2, 1


@dataclass(frozen=True)
class Signal:
    engine: str
    source: str
    strength: int
    evidence: str


_MADE = r"(?:made|built|developed|created|crafted|powered|running|runs|written)\s+(?:with|in|using|on|by)\s+(?:the\s+)?"

# engine -> (patterns for the legal notice, patterns for the description), matched ignoring case.
PATTERNS: dict[str, tuple[list[str], list[str]]] = {
    "godot": ([r"\bgodot\b"],
              [_MADE + r"godot\b", r"\bgodot\s+engine\b", r"\bgodot\s+[34](?:\.\d+)*\b",
               r"#madewithgodot", r"\bmade\s+with\s+godot\b"]),
    "unity": ([r"\bunity\s+technologies\b", r"\bunity\s*®", r"\bunity\s+engine\b",
               r"\bpowered\s+by\s+unity\b"],
              [_MADE + r"unity\b(?!\s+of\b)", r"\bunity\s+engine\b", r"#madewithunity"]),
    "unreal": ([r"\bunreal\s*®", r"\bunreal\s+engine\b", r"\bepic\s+games,\s+inc\..{0,40}unreal"],
               [_MADE + r"unreal(?:\s+engine)?\b", r"\bunreal\s+engine\s*[345]?\b"]),
    "gamemaker": ([r"\bgame\s*maker\b"], [_MADE + r"game\s*maker\b", r"\bgame\s*maker\s+studio\b"]),
    "rpgmaker": ([r"\brpg\s*maker\b"], [_MADE + r"rpg\s*maker\b"]),
    "renpy": ([r"\bren'?py\b"], [_MADE + r"ren'?py\b", r"\bren'py\b"]),
}
_COMPILED = {engine: ([re.compile(p, re.I) for p in legal], [re.compile(p, re.I) for p in text])
             for engine, (legal, text) in PATTERNS.items()}


def _snippet(text: str, match: re.Match, width: int = 60) -> str:
    start, end = max(0, match.start() - width), min(len(text), match.end() + width)
    return (("…" if start else "") + text[start:end].strip() + ("…" if end < len(text) else ""))[:200]


def scan(texts: dict[str, str]) -> list[Signal]:
    """Engine hints in an app's store text (from steam.parse_details: legal_notice, description,
    short_description, requirements). One signal per engine and source, the first match."""
    found: dict[tuple[str, str], Signal] = {}
    legal = (texts.get("legal_notice") or "")
    other = " ".join(texts.get(k) or "" for k in ("short_description", "description", "requirements"))
    for engine, (legal_patterns, text_patterns) in _COMPILED.items():
        for source, text, patterns in (("store_legal", legal, legal_patterns),
                                       ("store_text", other, text_patterns)):
            for pattern in patterns:
                match = pattern.search(text)
                if match:
                    found[(engine, source)] = Signal(engine, source, STRONG, _snippet(text, match))
                    break
    return list(found.values())
