"""Hand-copied engine lists: python -m steamdata.importids."""

from steamdata.importids import parse_ids

from .conftest import NOW


def test_parse_ids_takes_lines_json_and_links():
    text = "1942280\n[413150, 1942280]\nhttps://steamdb.info/app/2379780/charts/ 4.5 2026-11-05"
    assert parse_ids(text) == [1942280, 413150, 2379780]


def test_import_adds_signals_stubs_and_the_godot_set(store):
    first = store.import_signals([10, 20], "godot", "steamdb", "copied", NOW)
    assert first == {"games": 2, "new_signals": 2, "new_apps": 2, "godot_changed": 2}
    rows = store.db.execute("SELECT appid, godot FROM apps ORDER BY appid").fetchall()
    assert [tuple(r) for r in rows] == [(10, 1), (20, 1)]
    # A later, shorter list only adds: 10 stays Godot.
    second = store.import_signals([20, 30], "godot", "steamdb", "copied", NOW + 60)
    assert second == {"games": 2, "new_signals": 1, "new_apps": 1, "godot_changed": 1}
    assert store.db.execute("SELECT godot FROM apps WHERE appid = 10").fetchone()[0] == 1
    assert store.db.execute("SELECT sources FROM godot_games WHERE appid = 30").fetchone()[0] == "steamdb"
