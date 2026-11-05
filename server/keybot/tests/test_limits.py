"""Per-game settings, bans, stock warnings and export, at the database level."""

import threading
from collections import Counter

import pytest

from keybot.db import STOCK_LOW, STOCK_OK, STOCK_OUT, Store, role_ids, stock_level


@pytest.fixture
def path(tmp_path):
    return str(tmp_path / "keys.db")


@pytest.fixture
def store(path):
    s = Store(path)
    yield s
    s.close()


def make_game(store, name="Reforge Front", keys=5, **settings):
    game, _ = store.add_game(name, 99)
    store.add_keys(game["id"], [f"{name[:3].upper()}{i:02d}-AAAAA-BBBBB" for i in range(keys)])
    if settings:
        game = store.update_game_settings(game["id"], **settings)
    return game


def test_defaults(store):
    game = make_game(store)
    assert (game["per_user_limit"], game["public"], role_ids(game), game["stock_warning"]) == (1, 1, [], 0)


def test_higher_limit(store):
    game = make_game(store, per_user_limit=3)
    given = [store.give_key(game["id"], 1, reason) for reason in ("member", "creator", "manual")]
    assert all(g.status == "given" for g in given) and len({g.key_id for g in given}) == 3
    again = store.give_key(game["id"], 1, "member")
    assert again.status == "already" and again.key_id == given[-1].key_id  # their latest
    assert store.user_count(game["id"], 1) == 3 and store.at_limit(game["id"], 1)
    assert store.give_key(game["id"], 2, "member").status == "given"


def test_zero_means_no_limit(store):
    game = make_game(store, keys=4, per_user_limit=0)
    assert [store.give_key(game["id"], 1, "member").status for _ in range(5)] == ["given"] * 4 + ["none"]
    assert not store.at_limit(game["id"], 1)


def test_limit_bounds(store):
    game = make_game(store)
    for bad in (-1, 301):
        with pytest.raises(ValueError):
            store.update_game_settings(game["id"], per_user_limit=bad)
    assert store.update_game_settings(game["id"], per_user_limit=300)["per_user_limit"] == 300


def test_lowering_the_limit_keeps_given_keys(store):
    game = make_game(store, per_user_limit=2)
    store.give_key(game["id"], 1, "member")
    store.give_key(game["id"], 1, "member")
    store.update_game_settings(game["id"], per_user_limit=1)
    assert store.give_key(game["id"], 1, "member").status == "already"
    assert len(store.user_keys(1)) == 2


def test_roles_setting_round_trip(store):
    game = make_game(store, required_role_ids=[111, 222, 111])
    assert role_ids(game) == [111, 222]
    assert role_ids(store.update_game_settings(game["id"], required_role_ids=[])) == []
    # Leaving a setting out keeps it.
    game = store.update_game_settings(game["id"], public=False)
    assert game["public"] == 0 and game["per_user_limit"] == 1


def test_private_games_are_not_claimable_but_can_be_given(store):
    game = make_game(store, public=False)
    assert store.claimable_games(1) == []
    assert store.give_key(game["id"], 1, "manual").status == "given"


def test_game_ban(store):
    a = make_game(store, "A")
    b = make_game(store, "B")
    assert store.ban(1, a["id"], by="9")
    assert not store.ban(1, a["id"])  # once
    assert store.is_banned(1, a["id"]) and not store.is_banned(1, b["id"]) and not store.is_banned(1)
    assert store.give_key(a["id"], 1, "member").status == "banned"
    assert store.give_key(b["id"], 1, "member").status == "given"
    assert [g["name"] for g in store.claimable_games(1)] == []  # B: at the limit now; A: banned
    assert [g["name"] for g in store.claimable_games(2)] == ["A", "B"]
    assert store.unban(1, a["id"]) and not store.unban(1, a["id"])
    assert store.give_key(a["id"], 1, "member").status == "given"


def test_server_wide_ban(store):
    a = make_game(store, "A")
    b = make_game(store, "B")
    store.ban(1)
    store.ban(1, a["id"])
    assert store.is_banned(1) and store.is_banned(1, b["id"])
    assert store.give_key(b["id"], 1, "manual").status == "banned"
    assert store.claimable_games(1) == []
    # Lifting the server-wide ban leaves the game ban.
    assert store.unban(1)
    assert not store.is_banned(1) and store.is_banned(1, a["id"]) and not store.is_banned(1, b["id"])


def test_bans_listing(store):
    a = make_game(store, "A")
    b = make_game(store, "B")
    store.ban(1)
    store.ban(2, a["id"])
    store.ban(3, b["id"])
    assert {(r["user_id"], r["game"]) for r in store.bans()} == {("1", None), ("2", "A"), ("3", "B")}
    assert {(r["user_id"], r["game"]) for r in store.bans(a["id"])} == {("1", None), ("2", "A")}
    assert [r["game"] for r in store.user_bans(2)] == ["A"]


def test_stock_level():
    assert stock_level(0, 0) == STOCK_OK
    assert stock_level(0, 10) == STOCK_OUT
    assert stock_level(1, 10) == STOCK_LOW
    assert stock_level(2, 10) == STOCK_OK
    assert stock_level(10, 100) == STOCK_LOW and stock_level(11, 100) == STOCK_OK
    assert stock_level(1, 3) == STOCK_OK  # 10% of 3 rounds down to nothing


def test_stock_warnings_once_per_level_until_restocked(store):
    game = make_game(store, keys=10, per_user_limit=0)
    warnings = []
    for _ in range(10):
        store.give_key(game["id"], 1, "member")
        warnings.append(store.next_stock_warning(game["id"]))
    assert warnings == [None] * 8 + [STOCK_LOW, STOCK_OUT]
    assert store.next_stock_warning(game["id"]) is None
    # Putting one back and taking it again doesn't warn twice.
    key = store.user_key(game["id"], 1)
    store.undo_give(key["id"], 1)
    store.give_key(game["id"], 1, "member")
    assert store.next_stock_warning(game["id"]) is None
    # Restocked: it can warn again. 20 imported in all now, so 10% is 2 left.
    store.add_keys(game["id"], [f"NEW{i:02d}-AAAAA-BBBBB" for i in range(10)])
    assert store.game(game["id"])["stock_warning"] == STOCK_OK
    levels = []
    for _ in range(10):
        store.give_key(game["id"], 1, "member")
        levels.append(store.next_stock_warning(game["id"]))
    assert levels == [None] * 7 + [STOCK_LOW, None, STOCK_OUT]


def test_export_lists_only_unclaimed(store):
    game = make_game(store, keys=3)
    given = store.give_key(game["id"], 1, "member")
    unclaimed = store.unclaimed_keys(game["id"])
    assert len(unclaimed) == 2 and given.value not in unclaimed


def test_lookup_by_value_and_id(store):
    game = make_game(store)
    given = store.give_key(game["id"], 5, "member")
    row = store.key_by_value(f"  {given.value.lower()} ")
    assert row["id"] == given.key_id and row["given_to"] == "5" and row["game"] == "Reforge Front"
    assert store.key_by_id(given.key_id)["value"] == given.value
    assert store.key_by_value("NOPE-NOPE-NOPE") is None


def test_given_never_shows_the_key_in_repr(store):
    game = make_game(store)
    given = store.give_key(game["id"], 1, "member")
    assert given.value not in repr(given)


def run_threads(n, target):
    barrier = threading.Barrier(n)
    errors = []

    def wrapped(i):
        try:
            barrier.wait()
            target(i)
        except Exception as error:  # pragma: no cover - shows up as a failure below
            errors.append(error)

    threads = [threading.Thread(target=wrapped, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors


def test_concurrent_claims_by_one_user_respect_a_higher_limit(path):
    setup = Store(path)
    game = make_game(setup, keys=20, per_user_limit=3)
    setup.close()
    results = []

    def claim(_):
        store = Store(path)
        try:
            results.append(store.give_key(game["id"], 42, "member"))
        finally:
            store.close()

    run_threads(12, claim)
    given = [r for r in results if r.status == "given"]
    assert len(given) == 3 and len({r.key_id for r in given}) == 3
    assert sum(r.status == "already" for r in results) == 9
    check = Store(path)
    assert check.available_count(game["id"]) == 17 and check.user_count(game["id"], 42) == 3
    check.close()


def test_concurrent_claims_by_many_users_with_limit_two(path):
    setup = Store(path)
    game = make_game(setup, keys=10, per_user_limit=2)
    setup.close()
    results = []

    def claim(i):
        store = Store(path)
        try:
            user = i % 8  # 8 people, 4 tries each: 16 wanted, 10 keys
            results.append((user, store.give_key(game["id"], user, "member")))
        finally:
            store.close()

    run_threads(32, claim)
    given = [(u, r) for u, r in results if r.status == "given"]
    assert len(given) == 10
    assert len({r.key_id for _, r in given}) == 10  # never the same key twice
    assert max(Counter(u for u, _ in given).values()) <= 2
    check = Store(path)
    assert check.available_count(game["id"]) == 0
    assert all(check.user_count(game["id"], u) <= 2 for u in range(8))
    check.close()
