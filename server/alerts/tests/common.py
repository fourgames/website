"""What the tests share: settings and a stand-in for the check scheduler."""

from alerts.config import Config

YOUTUBE_SECRET = "y" * 32
TWITCH_SECRET = "t" * 32
ENV = {
    "PUBLIC_BASE_URL": "https://api.fourgames.se/alerts/",
    "YOUTUBE_WEBSUB_SECRET": YOUTUBE_SECRET,
    "TWITCH_EVENTSUB_SECRET": TWITCH_SECRET,
    "TWITCH_CLIENT_ID": "client-id",
    "TWITCH_CLIENT_SECRET": "client-secret",
}


def config(**changes) -> Config:
    return Config.from_env({**ENV, **changes})


class FakeChecks:
    """Records what asked for a check instead of running one."""

    def __init__(self):
        self.reasons = []

    def request(self, reason):
        self.reasons.append(reason)

    def health(self):
        return {"runs": 0}
