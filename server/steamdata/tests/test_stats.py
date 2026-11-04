"""python -m steamdata.stats: counts and what's due, read-only."""

import sqlite3
from pathlib import Path

from steamdata import stats
from steamdata.collector import Collector

from .test_collector import run_for, world


def test_report_after_a_run(config, store, http, web, clock, rng, db_path):
    world(web)
    run_for(Collector(config, store, http, clock=clock, rng=rng), clock, 3600)
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    text = stats.report(db, Path(db_path), now=clock.now)
    db.close()
    assert "Apps: 5 (game 5)" in text
    assert "Godot set: 3 apps (pcgamingwiki 2, store_legal 1); 1 more only mention Godot" in text
    assert "Rows: daily 4 (4 today) since 2026-11-04" in text
    assert "Due now: snapshot 0" in text
    assert "Requests today (UTC): api.steampowered.com" in text


def test_main_without_a_database(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "none.db"))
    assert stats.main([]) == 1
    assert "No database" in capsys.readouterr().out


def test_main_prints(db_path, store, monkeypatch, capsys):
    monkeypatch.setenv("DB_PATH", db_path)
    assert stats.main([]) == 0
    out = capsys.readouterr().out
    assert "Apps: 0" in out and "Next: app list changes now" in out
