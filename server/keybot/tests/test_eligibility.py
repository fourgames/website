"""When a creator gets a key without review."""

from datetime import datetime, timedelta, timezone

from keybot.eligibility import Channel, Thresholds, check_channel, evaluate

NOW = datetime(2026, 11, 4, 12, tzinfo=timezone.utc)
T = Thresholds(min_youtube_subscribers=1000, min_twitch_followers=500, max_days_since_upload=60)


def yt(subs, days_ago=1):
    last = NOW - timedelta(days=days_ago) if days_ago is not None else None
    return Channel("youtube", "UC1", "Chan", "https://www.youtube.com/@chan", audience=subs, last_upload=last)


def tw(followers):
    return Channel("twitch", "1", "chan", "https://www.twitch.tv/chan", audience=followers)


def test_youtube_boundaries():
    assert check_channel(yt(1000, 60), T, NOW)[0]
    assert not check_channel(yt(999, 1), T, NOW)[0]
    assert not check_channel(yt(5000, 61), T, NOW)[0]


def test_youtube_hidden_or_no_uploads():
    assert "hidden" in check_channel(yt(None), T, NOW)[1]
    assert "no uploads" in check_channel(yt(5000, None), T, NOW)[1]


def test_twitch_boundaries():
    assert check_channel(tw(500), T, NOW)[0]
    assert not check_channel(tw(499), T, NOW)[0]
    assert not check_channel(tw(None), T, NOW)[0]


def test_failed_lookup_never_approves():
    channel = yt(10**6)
    channel.error = "YouTube API error"
    assert not check_channel(channel, T, NOW)[0]


def test_any_channel_is_enough():
    decision = evaluate([yt(10), tw(800)], T, NOW)
    assert decision.approved and decision.channel.platform == "twitch"


def test_none_qualify_gives_reasons():
    decision = evaluate([yt(10), tw(20)], T, NOW)
    assert not decision.approved and len(decision.reasons) == 2


def test_no_connections():
    decision = evaluate([], T, NOW)
    assert not decision.approved and decision.reasons


def test_custom_thresholds():
    assert evaluate([tw(100)], Thresholds(min_twitch_followers=50), NOW).approved


def test_channel_round_trip_and_summary():
    channel = yt(1234, 3)
    again = Channel.from_dict(channel.to_dict())
    assert again == channel
    assert again.summary(NOW) == "1,234 subscribers, last upload 3 days ago"
