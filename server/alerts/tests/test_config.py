"""Settings from the environment."""

import pytest

from alerts.config import Config, ConfigError

from .common import ENV


def test_defaults():
    config = Config.from_env(ENV)
    assert config.public_base_url == "https://api.fourgames.se/alerts"
    assert config.youtube_callback == "https://api.fourgames.se/alerts/youtube"
    assert config.twitch_callback == "https://api.fourgames.se/alerts/twitch"
    assert config.youtube_topic == "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCGf6yX8yYzo1FBzhmKhFduA"
    assert config.twitch_login == "fourgamesab"
    assert config.check_delays == (30.0, 150.0)
    assert (config.host, config.port) == ("127.0.0.1", 8102)
    assert config.feedback_dir == "/srv/fourgames/own/feedback"
    assert config.feedback_python == "/srv/fourgames/venv/bin/python"
    assert config.youtube_enabled and config.twitch_enabled


def test_blank_values_mean_defaults():
    config = Config.from_env({**ENV, "PORT": "", "CHECK_DELAYS": "", "TWITCH_LOGIN": "", "RENEW_HOURS": ""})
    assert (config.port, config.check_delays, config.twitch_login, config.renew_hours) == (8102, (30.0, 150.0), "fourgamesab", 72.0)


def test_each_platform_can_be_off():
    youtube_only = Config.from_env({**ENV, "TWITCH_EVENTSUB_SECRET": ""})
    assert youtube_only.youtube_enabled and not youtube_only.twitch_enabled
    twitch_only = Config.from_env({**ENV, "YOUTUBE_WEBSUB_SECRET": ""})
    assert twitch_only.twitch_enabled and not twitch_only.youtube_enabled
    with pytest.raises(ConfigError, match="YOUTUBE_WEBSUB_SECRET, TWITCH_EVENTSUB_SECRET"):
        Config.from_env({**ENV, "TWITCH_EVENTSUB_SECRET": "", "YOUTUBE_WEBSUB_SECRET": ""})


def test_missing_and_bad_values():
    with pytest.raises(ConfigError, match="PUBLIC_BASE_URL"):
        Config.from_env({k: v for k, v in ENV.items() if k != "PUBLIC_BASE_URL"})
    with pytest.raises(ConfigError, match="https"):
        Config.from_env({**ENV, "PUBLIC_BASE_URL": "http://api.fourgames.se/alerts"})
    with pytest.raises(ConfigError, match="YOUTUBE_WEBSUB_SECRET"):
        Config.from_env({**ENV, "YOUTUBE_WEBSUB_SECRET": "short"})
    with pytest.raises(ConfigError, match="TWITCH_EVENTSUB_SECRET"):
        Config.from_env({**ENV, "TWITCH_EVENTSUB_SECRET": "x" * 101})
    with pytest.raises(ConfigError, match="TWITCH_CLIENT_SECRET"):
        Config.from_env({**ENV, "TWITCH_CLIENT_SECRET": ""})
    with pytest.raises(ConfigError, match="CHECK_DELAYS"):
        Config.from_env({**ENV, "CHECK_DELAYS": "soon"})
    with pytest.raises(ConfigError, match="PORT"):
        Config.from_env({**ENV, "PORT": "eighty"})


def test_delays_are_sorted():
    assert Config.from_env({**ENV, "CHECK_DELAYS": "120, 20,60"}).check_delays == (20.0, 60.0, 120.0)


def test_the_example_file_matches_the_defaults():
    from pathlib import Path

    lines = (Path(__file__).resolve().parents[1] / "alerts.env.example").read_text().splitlines()
    example = dict(line.split("=", 1) for line in lines if line and not line.startswith("#"))
    filled = {**example, "YOUTUBE_WEBSUB_SECRET": "y" * 64, "TWITCH_EVENTSUB_SECRET": "t" * 64,
              "TWITCH_CLIENT_ID": "id", "TWITCH_CLIENT_SECRET": "secret"}
    assert Config.from_env(filled) == Config.from_env({k: v for k, v in filled.items() if k in (
        "PUBLIC_BASE_URL", "YOUTUBE_WEBSUB_SECRET", "TWITCH_EVENTSUB_SECRET", "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET")})
