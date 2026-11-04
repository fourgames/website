"""python -m keybot.admin: importing KeyBot's exports, recording its claims, listing (temp database)."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from keybot import admin
from keybot.db import Store

SERVER = Path(__file__).resolve().parents[2]
KEYS = [f"RFG{i:02d}-AAAAA-BBBBB" for i in range(5)]


@pytest.fixture
def db(tmp_path, monkeypatch):
    path = str(tmp_path / "keys.db")
    monkeypatch.setenv("DB_PATH", path)
    return path


def test_db_path_from_env():
    assert admin.db_path({"DB_PATH": " /x/keys.db "}) == "/x/keys.db"
    assert admin.db_path({}) == admin.DEFAULT_DB_PATH


def test_import_keys_creates_game_and_skips_duplicates(db, tmp_path, capsys):
    txt = tmp_path / "pool.txt"
    txt.write_text("\n".join(KEYS[:3] + [KEYS[0]]) + "\n")
    csv = tmp_path / "export.csv"
    csv.write_text("Key,Claimed\n" + "\n".join(f"{k},no" for k in KEYS[2:]) + "\n")
    assert admin.main(["import-keys", "--game", "Reforge Front", "--steam-app-id", "4242", str(txt), str(csv)]) == 0
    out = capsys.readouterr().out
    assert "Created game 'Reforge Front'" in out and "Steam app 4242" in out
    assert "3 added" in out and "1 repeated in the file" in out  # the .txt
    assert "2 added, 1 already in the database" in out  # the .csv
    assert "Added 5, skipped 1. Available now: 5." in out
    assert not any(k in out for k in KEYS)  # counts only, never keys
    # Again: nothing new.
    assert admin.main(["import-keys", "--game", "reforge front", str(txt)]) == 0
    assert "Using game 'Reforge Front'" in capsys.readouterr().out
    store = Store(db)
    game = store.game_by_name("Reforge Front")
    assert game["steam_app_id"] == 4242 and store.available_count(game["id"]) == 5
    store.close()


def test_import_missing_file(db, tmp_path, capsys):
    assert admin.main(["import-keys", "--game", "G", str(tmp_path / "nope.txt")]) == 1
    assert "couldn't read it" in capsys.readouterr().err


def test_mark_claimed_counts_for_the_limit(db, tmp_path, capsys):
    txt = tmp_path / "pool.txt"
    txt.write_text("\n".join(KEYS) + "\n")
    admin.main(["import-keys", "--game", "Reforge Front", str(txt)])
    user = "364076254812438538"
    assert admin.main(["mark-claimed", "--game", "Reforge Front", "--user", user, "--note", "KeyBot"]) == 0
    assert "They have 1 for it now (limit 1)" in capsys.readouterr().out
    store = Store(db)
    game = store.game_by_name("Reforge Front")
    assert store.give_key(game["id"], int(user), "member").status == "already"
    assert store.claimable_games(int(user)) == []
    assert store.available_count(game["id"]) == 5
    store.close()


def test_mark_claimed_errors(db, capsys):
    assert admin.main(["mark-claimed", "--game", "Nope", "--user", "1"]) == 1
    assert "No game named 'Nope'" in capsys.readouterr().err
    assert admin.main(["mark-claimed", "--game", "Nope", "--user", "@bob"]) == 2


def test_list(db, tmp_path, capsys):
    assert admin.main(["list"]) == 0
    assert "No games yet." in capsys.readouterr().out
    txt = tmp_path / "pool.txt"
    txt.write_text("\n".join(KEYS) + "\n")
    admin.main(["import-keys", "--game", "Reforge Front", str(txt)])
    admin.main(["mark-claimed", "--game", "Reforge Front", "--user", "5"])
    capsys.readouterr()
    assert admin.main(["list"]) == 0
    out = capsys.readouterr().out
    assert "Reforge Front: 5 available, 0 given, 1 KeyBot claim(s)" in out and "public, limit 1" in out


def test_runs_as_a_module(db):
    result = subprocess.run([sys.executable, "-m", "keybot.admin", "list"], cwd=SERVER, capture_output=True,
                            text=True, env={**os.environ, "DB_PATH": db}, timeout=60)
    assert result.returncode == 0, result.stderr
    assert "No games yet." in result.stdout
