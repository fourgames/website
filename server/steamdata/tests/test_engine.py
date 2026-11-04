"""Engine hints: store text and PCGamingWiki pages."""

from steamdata import engine, pcgw

from .conftest import GODOT_PAGE, MENTION_PAGE


def signals(**texts):
    return {(s.engine, s.source): s for s in engine.scan(texts)}


def test_godot_in_the_legal_notice():
    found = signals(legal_notice="Godot Engine is licensed under the MIT license.")
    assert found[("godot", "store_legal")].strength == engine.STRONG
    assert "Godot Engine" in found[("godot", "store_legal")].evidence


def test_godot_in_the_description_needs_a_made_with_phrase():
    assert signals(description="A tribute to Waiting for Godot, the play.") == {}
    assert ("godot", "store_text") in signals(description="Proudly made with Godot 4!")
    assert ("godot", "store_text") in signals(description="Built in the Godot engine by two friends.")
    assert ("godot", "store_text") in signals(short_description="#MadeWithGodot")


def test_other_engines():
    found = signals(legal_notice="Unity® is a trademark of Unity Technologies.",
                    description="Developed using Unreal Engine 5.")
    assert ("unity", "store_legal") in found and ("unreal", "store_text") in found
    assert signals(description="The unity of the clans is broken.") == {}


def test_pcgw_infobox_engine_is_strong():
    page = pcgw.parse_page(1, "Brotato", 5, GODOT_PAGE % 1942280, "Godot")
    assert page.appids == (1942280,)  # not the "steam appid side" (DLC)
    assert page.strength == engine.STRONG
    assert page.evidence == "PCGamingWiki infobox: Godot 3 (3.7.0.0) - Brotato"


def test_pcgw_link_only_is_a_mention():
    page = pcgw.parse_page(2, "Victoria II", 6, MENTION_PAGE % 42960, "Godot")
    assert page.appids == (42960,) and page.strength == engine.MENTION


def test_pcgw_several_app_ids_and_engine_key():
    page = pcgw.parse_page(3, "X", 1, "|steam appid = 10, 20\n{{Infobox game/row/engine|Godot}}", "Godot")
    assert page.appids == (10, 20) and page.strength == engine.STRONG
    assert pcgw.engine_key("Godot") == "godot" and pcgw.engine_key("RPG Maker") == "rpgmaker"


def test_pcgw_requests(http, web):
    web.pcgw_pages = {7: ("Brotato", 70, GODOT_PAGE % 1942280)}
    refs, cont = pcgw.backlinks(http, "Godot")
    assert refs == [pcgw.PageRef(7, "Brotato", 70)] and cont is None
    params = web.calls[0][3]
    assert params["gbltitle"] == "Engine:Godot" and params["gblnamespace"] == "0" and params["prop"] == "info"
    texts = pcgw.contents(http, [7])
    assert texts[7][:2] == ("Brotato", 70) and "Infobox game/row/engine" in texts[7][2]
    assert web.calls[1][3]["pageids"] == "7"
