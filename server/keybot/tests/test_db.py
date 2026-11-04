"""Handouts: one key per game per person by default, never the same key twice, even under concurrent claims."""

import threading

import pytest

from keybot.db import Store


@pytest.fixture
def path(tmp_path):
    return str(tmp_path / "keys.db")


@pytest.fixture
def store(path):
    s = Store(path)
    yield s
    s.close()


def make_game(store, name="Hidden Ones", keys=3):
    game, created = store.add_game(name, 123)
    assert created
    store.add_keys(game["id"], [f"{name[:3].upper()}{i:02d}-AAAAA-BBBBB" for i in range(keys)])
    return game


def test_wal_mode(store):
    assert store.db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_one_key_per_game_per_user(store):
    game = make_game(store)
    first = store.give_key(game["id"], 1, "member")
    assert first.status == "given"
    again = store.give_key(game["id"], 1, "creator")  # any reason counts
    assert again.status == "already" and again.key_id == first.key_id and again.value == first.value
    assert store.available_count(game["id"]) == 2


def test_one_per_game_not_per_server(store):
    a = make_game(store, "A")
    b = make_game(store, "B")
    assert store.give_key(a["id"], 1, "member").status == "given"
    assert store.give_key(b["id"], 1, "member").status == "given"


def test_runs_out(store):
    game = make_game(store, keys=1)
    assert store.give_key(game["id"], 1, "member").status == "given"
    assert store.give_key(game["id"], 2, "member").status == "none"


def test_undo_puts_key_back_and_allows_claiming_again(store):
    game = make_game(store, keys=1)
    given = store.give_key(game["id"], 1, "member")
    assert store.undo_give(given.key_id, 1)
    assert store.available_count(game["id"]) == 1
    assert store.user_key(game["id"], 1) is None
    # Only the person it was given to can have it undone, and only once.
    again = store.give_key(game["id"], 1, "member")
    assert again.status == "given"
    assert not store.undo_give(again.key_id, 2)
    assert store.undo_give(again.key_id, 1)
    assert not store.undo_give(again.key_id, 1)


def test_unknown_reason_refused(store):
    game = make_game(store)
    with pytest.raises(ValueError):
        store.give_key(game["id"], 1, "friend")


def test_limit_is_checked_in_the_handout_not_by_an_index(store):
    # One key per game per person used to be a unique index; it's the game's per_user_limit now,
    # checked inside give_key's write transaction (see test_limits.py for the concurrent cases).
    names = {row[0] for row in store.db.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert "keys_one_per_user" not in names and "keys_by_user" in names
    game = make_game(store)
    assert game["per_user_limit"] == 1  # the default keeps the old rule
    store.give_key(game["id"], 1, "member")
    assert store.give_key(game["id"], 1, "manual").status == "already"


def test_add_keys_skips_duplicates_across_games(store):
    a, _ = store.add_game("A")
    b, _ = store.add_game("B")
    assert store.add_keys(a["id"], ["K1", "K2"]) == (2, 0)
    assert store.add_keys(a["id"], ["K2", "K3"]) == (1, 1)
    assert store.add_keys(b["id"], ["K1"]) == (0, 1)  # a key is never stocked twice
    assert store.available_count(a["id"]) == 3


def test_add_game_is_case_insensitive_and_updates_app_id(store):
    game, created = store.add_game("Ships Ahoy")
    again, created_again = store.add_game("ships ahoy", 4242)
    assert created and not created_again
    assert again["id"] == game["id"] and again["steam_app_id"] == 4242


def test_claimable_games(store):
    a = make_game(store, "A", keys=2)
    b = make_game(store, "B", keys=1)
    make_game(store, "Empty", keys=0)
    assert [g["name"] for g in store.claimable_games(1)] == ["A", "B"]
    store.give_key(a["id"], 1, "member")
    assert [g["name"] for g in store.claimable_games(1)] == ["B"]
    store.give_key(b["id"], 2, "member")  # B is now out of keys for everyone
    assert [g["name"] for g in store.claimable_games(1)] == []
    assert [g["name"] for g in store.claimable_games(3)] == ["A"]


def test_user_keys_and_log(store):
    game = make_game(store)
    store.give_key(game["id"], 7, "press")
    mine = store.user_keys(7)
    assert len(mine) == 1 and mine[0]["game"] == "Hidden Ones" and mine[0]["value"]
    log = store.recent_handouts()
    assert len(log) == 1 and log[0]["reason"] == "press"
    assert "value" not in log[0].keys()  # the log never carries key values


def test_status_summary(store):
    game = make_game(store, keys=4)
    store.give_key(game["id"], 1, "member")
    store.give_key(game["id"], 2, "creator")
    store.create_request("press", game["id"], 3)
    row = store.status_summary()[0]
    assert (row["available"], row["member"], row["creator"], row["press"], row["open_requests"]) == (2, 1, 1, 0, 1)


def test_concurrent_claims_never_share_a_key(path):
    setup = Store(path)
    game = make_game(setup, keys=10)
    setup.close()
    results, errors = [], []
    barrier = threading.Barrier(30)

    def claim(user_id):
        store = Store(path)  # its own connection, like a second process would have
        try:
            barrier.wait()
            results.append(store.give_key(game["id"], user_id, "member"))
        except Exception as error:  # pragma: no cover - shows up as a failure below
            errors.append(error)
        finally:
            store.close()

    threads = [threading.Thread(target=claim, args=(user,)) for user in range(30)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    given = [r for r in results if r.status == "given"]
    assert len(given) == 10
    assert len({r.key_id for r in given}) == 10
    assert sum(r.status == "none" for r in results) == 20


def test_concurrent_claims_by_one_user_get_one_key(path):
    setup = Store(path)
    game = make_game(setup, keys=10)
    setup.close()
    results = []
    barrier = threading.Barrier(10)

    def claim():
        store = Store(path)
        barrier.wait()
        results.append(store.give_key(game["id"], 42, "member"))
        store.close()

    threads = [threading.Thread(target=claim) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(r.status == "given" for r in results) == 1
    assert {r.key_id for r in results} == {next(r.key_id for r in results if r.status == "given")}
    check = Store(path)
    assert check.available_count(game["id"]) == 9
    check.close()


def test_requests_open_count_and_single_decision(store):
    game = make_game(store)
    ids = [store.create_request("creator", game["id"], 5) for _ in range(2)]
    store.create_request("press", game["id"], 5, status="approved", decided_by="auto")
    assert store.open_request_count(5) == 2
    assert store.open_request_for(5, game["id"]) is not None
    assert store.start_decision(ids[0])
    assert not store.start_decision(ids[0])  # a second admin's click
    assert store.open_request_count(5) == 2  # processing still counts as open
    store.finish_request(ids[0], "approved", "99", key_id=None)
    assert store.open_request_count(5) == 1
    assert store.start_decision(ids[1])
    assert store.recover() == 1  # a restart mid-approval reopens it
    assert store.request(ids[1])["status"] == "open"


def test_states_are_one_time(store):
    store.save_state("abc", 1, 2, expires_at=2000, now=1000)
    assert store.state_usable("abc")
    assert store.use_state("abc")
    assert not store.use_state("abc")
    assert not store.state_usable("abc")
    assert not store.use_state("never-made")


def test_old_states_are_pruned(store):
    store.save_state("old", 1, 2, expires_at=1000, now=1000)
    store.save_state("new", 1, 2, expires_at=200000, now=100000)
    assert store.db.execute("SELECT nonce FROM oauth_states").fetchall()[0][0] == "new"
