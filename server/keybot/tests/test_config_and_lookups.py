"""Settings from the environment, and reading the platform APIs' answers (no network)."""

import pytest

from keybot.config import Config, ConfigError
from keybot.lookups import parse_twitch, parse_youtube, verified_connections

BASE = {
    "DISCORD_BOT_TOKEN": "t", "DISCORD_CLIENT_ID": "1", "DISCORD_CLIENT_SECRET": "s", "GUILD_ID": "10",
    "ADMIN_CHANNEL_ID": "20", "PUBLIC_BASE_URL": "https://api.fourgames.se/keybot/", "STATE_SECRET": "x" * 64,
}


def test_defaults():
    config = Config.from_env(BASE)
    assert config.member_role == "YouTube Member"
    assert config.admin_role_id is None
    assert config.redirect_uri == "https://api.fourgames.se/keybot/callback"
    assert config.thresholds.min_youtube_subscribers == 1000
    assert config.thresholds.min_twitch_followers == 500
    assert config.thresholds.max_days_since_upload == 60
    assert (config.low_stock, config.port, config.host) == (5, 8100, "127.0.0.1")
    assert config.db_path == "/srv/fourgames/keybot/keys.db"


def test_blank_values_mean_defaults():
    config = Config.from_env({**BASE, "MIN_TWITCH_FOLLOWERS": "", "MEMBER_ROLE": "", "ADMIN_ROLE_ID": ""})
    assert config.thresholds.min_twitch_followers == 500 and config.member_role == "YouTube Member"


def test_missing_and_bad_values():
    with pytest.raises(ConfigError, match="GUILD_ID"):
        Config.from_env({k: v for k, v in BASE.items() if k != "GUILD_ID"})
    with pytest.raises(ConfigError, match="STATE_SECRET"):
        Config.from_env({**BASE, "STATE_SECRET": "short"})
    with pytest.raises(ConfigError, match="PORT"):
        Config.from_env({**BASE, "PORT": "eighty"})


def test_only_verified_youtube_and_twitch():
    connections = [
        {"type": "youtube", "id": "UC1", "verified": True},
        {"type": "youtube", "id": "UC2", "verified": False},
        {"type": "twitch", "id": "55", "verified": True},
        {"type": "steam", "id": "7", "verified": True},
    ]
    assert [c["id"] for c in verified_connections(connections)] == ["UC1", "55"]


def test_parse_youtube():
    channels = {"items": [{
        "snippet": {"title": "Chan", "customUrl": "@chan"},
        "statistics": {"subscriberCount": "4321", "hiddenSubscriberCount": False},
        "contentDetails": {"relatedPlaylists": {"uploads": "UU1"}},
    }]}
    playlist = {"items": [{"contentDetails": {"videoPublishedAt": "2026-11-01T10:00:00Z"}}]}
    channel = parse_youtube("UC1", "fallback", channels, playlist)
    assert (channel.name, channel.url, channel.audience) == ("Chan", "https://www.youtube.com/@chan", 4321)
    assert channel.last_upload.isoformat() == "2026-11-01T10:00:00+00:00"


def test_parse_youtube_hidden_and_missing():
    hidden = {"items": [{"snippet": {}, "statistics": {"hiddenSubscriberCount": True}}]}
    assert parse_youtube("UC1", "x", hidden, None).audience is None
    assert parse_youtube("UC1", "x", {"items": []}, None).error


def test_parse_twitch():
    channel = parse_twitch("55", "chan", {"data": [{"id": "55", "login": "chan", "display_name": "Chan"}]},
                           {"total": 812, "data": []})
    assert (channel.name, channel.url, channel.audience) == ("Chan", "https://www.twitch.tv/chan", 812)
    assert parse_twitch("55", "chan", {"data": []}, {}).error
