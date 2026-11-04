"""Steam's replies (shapes taken from real ones, 2026-11) into plain values, and the requests sent."""

import json

import pytest

from steamdata import steam
from steamdata.net import Throttled, Transient

from .conftest import details, item

# Trimmed from a real IStoreBrowseService/GetItems reply.
BROTATO = {
    "item_type": 0, "id": 1942280, "success": 1, "visible": True, "name": "Brotato",
    "store_url_path": "app/1942280/Brotato", "appid": 1942280, "type": 0,
    "tagids": [1716, 4182, 4885],
    "categories": {"supported_player_categoryids": [2, 1, 9], "feature_categoryids": [22, 29],
                   "controller_categoryids": [28]},
    "reviews": {"summary_filtered": {"review_count": 112908, "percent_positive": 95, "review_score": 9,
                                     "review_score_label": "Overwhelmingly Positive"},
                "summary_language_specific": {"review_count": 32844, "percent_positive": 96, "review_score": 9}},
    "basic_info": {"short_description": "Brotato is a top-down arena shooter roguelite.",
                   "publishers": [{"name": "Blobfish", "creator_clan_account_id": 44280697}],
                   "developers": [{"name": "Blobfish", "creator_clan_account_id": 44280697}]},
    "tags": [{"tagid": 4182, "weight": 607}, {"tagid": 1716, "weight": 705}, {"tagid": 4885, "weight": 592}],
    "release": {"steam_release_date": 1687514379, "original_steam_release_date": 1664297723},
    "platforms": {"windows": True, "mac": True, "steamos_linux": True, "vr_support": {},
                  "steam_deck_compat_category": 3},
    "best_purchase_option": {"packageid": 699833, "final_price_in_cents": "249",
                             "original_price_in_cents": "499", "discount_pct": 50,
                             "formatted_final_price": "$2.49"},
}


def test_parse_item_real_reply():
    s = steam.parse_item(BROTATO)
    assert (s.appid, s.type, s.name) == (1942280, "game", "Brotato")
    assert (s.reviews, s.positive_pct, s.review_score) == (112908, 95, 9)
    assert (s.price, s.price_original, s.discount) == (249, 499, 50)
    assert s.tags == (1716, 4182, 4885)  # strongest first
    assert s.categories == (1, 2, 9, 22, 28, 29)
    assert s.release_ts == 1687514379 and s.original_release_ts == 1664297723
    assert (s.windows, s.mac, s.linux, s.deck) == (True, True, True, 3)
    assert s.developers == ("Blobfish",) and s.publishers == ("Blobfish",)
    assert not s.coming_soon and not s.is_free


def test_parse_item_free_hidden_dlc_and_coming_soon():
    free = steam.parse_item({**item(440, "TF2", free=True), "type": 0})
    assert free.is_free and free.price == 0 and free.price_original is None
    assert steam.parse_item(item(1, "", success=15)) is None
    dlc = steam.parse_item({**item(2868390, "Brotato: Abyssal Terrors", kind=4),
                            "related_items": {"parent_appid": 1942280}})
    assert dlc.type == "dlc" and dlc.parent_appid == 1942280
    soon = steam.parse_item(item(5, "Soon", coming_soon=True, price=None, reviews=0))
    assert soon.coming_soon and soon.price is None and soon.release_display == "date_quarter"
    full_price = steam.parse_item(item(6, "Six", price=1999))
    assert full_price.price == 1999 and full_price.price_original is None and full_price.discount == 0


def test_get_items_request_and_missing_ids(http, web):
    web.items[10] = item(10, "Ten")
    out = steam.get_items(http, [10, 11], "US")
    assert out[10].name == "Ten" and out[11] is None
    request = json.loads(web.calls[0][3]["input_json"])
    assert request["ids"] == [{"appid": 10}, {"appid": 11}]
    assert request["context"]["country_code"] == "US"
    assert request["data_request"]["include_reviews"] is True


def test_app_list_page(http, web):
    web.listed = [10, 20, 30]
    web.page_size = 2
    apps, more, last = steam.app_list_page(http, "KEY", 0, since=None)
    assert [a.appid for a in apps] == [10, 20] and more and last == 20
    params = web.calls[0][3]
    assert params["key"] == "KEY" and params["include_games"] == "true" and params["include_dlc"] == "false"
    assert "if_modified_since" not in params
    apps, more, last = steam.app_list_page(http, "KEY", last, since=5)
    assert web.calls[1][3]["if_modified_since"] == "5"


def test_current_players(http, web):
    web.players[10] = 1234
    assert steam.current_players(http, 10) == 1234
    assert steam.current_players(http, 11) is None  # Steam's 404


def test_app_details_replies(http, web):
    web.details[10] = details("Ten")
    assert steam.app_details(http, 10, "US")["name"] == "Ten"
    assert web.calls[0][3] == {"appids": "10", "cc": "us", "l": "english"}
    assert steam.app_details(http, 11, "US") is None  # success: false
    web.fail["/api/appdetails"] = [(200, {}, b'{"12": null}'), (403, {}, b""), (429, {}, b"")]
    with pytest.raises(Transient):
        steam.app_details(http, 12, "US")
    with pytest.raises(Throttled):  # the store's 403 means slow down too
        steam.app_details(http, 12, "US")
    with pytest.raises(Throttled):
        steam.app_details(http, 12, "US")


def test_parse_details():
    d = steam.parse_details({**details("Ten", legal="Uses <b>Godot</b> Engine", genres=((1, "Action"), (23, "Indie"))),
                             "demos": [{"appid": 77, "description": ""}], "metacritic": {"score": 81}})
    assert d.type == "game" and d.genres == ((1, "Action"), (23, "Indie"))
    assert d.categories == ((2, "Single-player"),)
    assert d.languages == "English*,French"
    assert d.demos == (77,) and d.dlc_count == 2 and d.achievements == 12 and d.metacritic == 81
    assert d.release_text == "Jun 23, 2023"
    assert d.texts["legal_notice"] == "Uses Godot Engine"
    assert "OpenGL 3.3" in d.texts["requirements"]


@pytest.mark.parametrize("raw, clean", [
    ("English, French, German", "English,French,German"),
    ("English<strong>*</strong>, Japanese<strong>*</strong><br><strong>*</strong>languages with full audio support",
     "English*,Japanese*"),
    ("Spanish - Spain &amp; more", "Spanish - Spain & more"),
    (None, ""),
])
def test_clean_languages(raw, clean):
    assert steam.clean_languages(raw) == clean


def test_tag_list(http):
    assert steam.tag_list(http) == [(19, "Action"), (492, "Indie")]
