"""Whether a creator's channel is big and active enough to get a key without anyone looking at it.

Pure functions on already-fetched numbers (lookups.py does the fetching), so they're easy to test.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass(frozen=True)
class Thresholds:
    min_youtube_subscribers: int = 1000
    min_twitch_followers: int = 500
    max_days_since_upload: int = 60


@dataclass
class Channel:
    """One verified YouTube or Twitch connection, with what the platform's API said about it."""

    platform: str  # "youtube" or "twitch"
    id: str
    name: str
    url: str
    # Subscribers (YouTube) or followers (Twitch). None when hidden or the lookup failed.
    audience: int | None = None
    # The newest upload (YouTube only). None when there are none or the lookup failed.
    last_upload: datetime | None = None
    # Why the lookup failed, shown on the admin card.
    error: str | None = None

    def summary(self, now: datetime | None = None) -> str:
        """One line for the admin card and the handout log."""
        if self.error:
            return f"lookup failed: {self.error}"
        parts = []
        unit = "subscribers" if self.platform == "youtube" else "followers"
        parts.append(f"{self.audience:,} {unit}" if self.audience is not None else f"{unit} hidden")
        if self.platform == "youtube":
            if self.last_upload is None:
                parts.append("no uploads")
            else:
                parts.append(f"last upload {days_since(self.last_upload, now)} days ago")
        return ", ".join(parts)

    @classmethod
    def from_dict(cls, data: dict) -> "Channel":
        last = data.get("last_upload")
        return cls(data["platform"], data["id"], data.get("name") or "", data.get("url") or "",
                   audience=data.get("audience"),
                   last_upload=datetime.fromisoformat(last) if last else None,
                   error=data.get("error"))

    def to_dict(self) -> dict:
        return {
            "platform": self.platform,
            "id": self.id,
            "name": self.name,
            "url": self.url,
            "audience": self.audience,
            "last_upload": self.last_upload.isoformat() if self.last_upload else None,
            "error": self.error,
        }


@dataclass
class Decision:
    approved: bool
    # The channel that qualified, when approved.
    channel: Channel | None = None
    # Why each channel fell short, for the admin card.
    reasons: list[str] = field(default_factory=list)


def days_since(when: datetime, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    return max(0, (now - when).days)


def check_channel(channel: Channel, t: Thresholds, now: datetime | None = None) -> tuple[bool, str]:
    """(qualifies, why not). The reason is empty when it qualifies."""
    if channel.error:
        return False, f"{channel.platform}: lookup failed ({channel.error})"
    if channel.platform == "youtube":
        if channel.audience is None:
            return False, "YouTube: subscriber count is hidden"
        if channel.audience < t.min_youtube_subscribers:
            return False, f"YouTube: {channel.audience:,} subscribers (needs {t.min_youtube_subscribers:,})"
        if channel.last_upload is None:
            return False, "YouTube: no uploads"
        days = days_since(channel.last_upload, now)
        if days > t.max_days_since_upload:
            return False, f"YouTube: last upload {days} days ago (needs {t.max_days_since_upload} or fewer)"
        return True, ""
    if channel.platform == "twitch":
        if channel.audience is None:
            return False, "Twitch: follower count unknown"
        if channel.audience < t.min_twitch_followers:
            return False, f"Twitch: {channel.audience:,} followers (needs {t.min_twitch_followers:,})"
        return True, ""
    return False, f"{channel.platform}: not a platform we check"


def evaluate(channels: list[Channel], t: Thresholds, now: datetime | None = None) -> Decision:
    """Approved when any one channel meets its platform's thresholds."""
    if not channels:
        return Decision(False, reasons=["No verified YouTube or Twitch connection on Discord"])
    reasons = []
    for channel in channels:
        ok, why = check_channel(channel, t, now)
        if ok:
            return Decision(True, channel=channel)
        reasons.append(why)
    return Decision(False, reasons=reasons)
