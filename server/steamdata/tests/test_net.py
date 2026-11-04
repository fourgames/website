"""Http: JSON, gzip, and sorting errors into throttled / try later / give up, without leaking keys."""

import gzip
import json

import pytest

from steamdata.net import Http, HttpError, Throttled, Transient


def make(reply):
    seen = []

    def transport(url, headers, timeout):
        seen.append((url, headers))
        if isinstance(reply, Exception):
            raise reply
        return reply

    return Http("agent/1.0", transport=transport), seen


def test_json_and_headers():
    http, seen = make((200, {}, b'{"a": 1}'))
    assert http.get_json("https://api.example.com/x/", {"q": "1 2"}) == {"a": 1}
    url, headers = seen[0]
    assert url == "https://api.example.com/x/?q=1+2"
    assert headers["User-Agent"] == "agent/1.0" and headers["Accept-Encoding"] == "gzip"
    assert http.take_counts()["api.example.com"]["ok"] == 1
    assert http.take_counts() == {}


def test_gzip_reply():
    body = gzip.compress(json.dumps({"big": [1] * 100}).encode())
    http, _ = make((200, {"content-encoding": "gzip"}, body))
    assert http.get_json("https://h/x") == {"big": [1] * 100}


def test_429_is_throttled_with_retry_after():
    http, _ = make((429, {"retry-after": "120"}, b""))
    with pytest.raises(Throttled) as caught:
        http.get_json("https://h/x")
    assert caught.value.retry_after == 120
    assert http.counts["h"]["throttled"] == 1


def test_403_only_throttled_where_asked():
    http, _ = make((403, {}, b""))
    with pytest.raises(Throttled):
        http.get_json("https://store/x", throttle_codes=(429, 403))
    with pytest.raises(HttpError) as caught:
        http.get_json("https://api/x")
    assert not isinstance(caught.value, (Throttled, Transient)) and caught.value.status == 403


@pytest.mark.parametrize("reply", [(503, {}, b"down"), (200, {}, b"<html>store front</html>"),
                                   TimeoutError("slow"), ConnectionResetError("reset")])
def test_transient(reply):
    http, _ = make(reply)
    with pytest.raises(Transient):
        http.get_json("https://h/x")


def test_404_is_an_error_with_status():
    http, _ = make((404, {}, b""))
    with pytest.raises(HttpError) as caught:
        http.get_json("https://h/x")
    assert caught.value.status == 404


def test_errors_never_show_the_query_string():
    http, _ = make((500, {}, b""))
    with pytest.raises(Transient) as caught:
        http.get_json("https://api.steampowered.com/IStoreService/GetAppList/v1/", {"key": "SECRET123"})
    assert "SECRET123" not in str(caught.value)
    assert str(caught.value) == "HTTP 500 from api.steampowered.com/IStoreService/GetAppList/v1"
