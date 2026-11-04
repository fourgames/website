"""Country and region from the IP (with a tiny fake reader instead of DB-IP's file), and the
monthly updater (with a fake download)."""

from __future__ import annotations

import gzip
import logging
from datetime import datetime, timezone
from pathlib import Path

import pytest

from gamedata import geoupdate
from gamedata.geo import Geo, place
from gamedata.signing import make_pid

from .harness import ENV, STEAMID, run

PID = make_pid(ENV["GAMEDATA_PEPPER"], STEAMID)
SWEDEN = "81.2.69.160"
JAPAN = "203.0.113.200"  # (documentation range; the fake reader doesn't mind)

RECORDS = {
    SWEDEN: {"country": {"iso_code": "SE", "names": {"en": "Sweden"}},
             "subdivisions": [{"names": {"en": "Stockholm"}}],
             "city": {"names": {"en": "Stockholm"}}, "location": {"latitude": 59.3, "longitude": 18.1}},
    "8.8.8.8": {"country": {"iso_code": "US"}},
}


class FakeReader:
    def __init__(self, records):
        self.records = records
        self.closed = False

    def get(self, ip):
        return self.records.get(ip)

    def close(self):
        self.closed = True


def opener(records=RECORDS, log=None):
    def open_(path):
        if log is not None:
            log.append(path)
        return FakeReader(records)
    return open_


def with_db(tmp_path: Path) -> None:
    db = tmp_path / "data" / "geo" / "dbip-city-lite.mmdb"
    db.parent.mkdir(parents=True, exist_ok=True)
    db.write_bytes(b"fake")


def test_place():
    assert place(RECORDS[SWEDEN]) == ("SE", "Stockholm")
    assert place({"country": {"iso_code": "us"}}) == ("US", None)
    for odd in (None, [], {"country": "SE"}, {"country": {"iso_code": "SWE"}}, {"subdivisions": "x"},
                {"subdivisions": [{"names": {"en": "  "}}]}):
        assert place(odd)[0] is None


def test_session_start_keeps_country_and_region_never_the_ip(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    with_db(tmp_path)

    async def steps(w):
        response = await w.client.post("/gamedata/v1/session/start", headers={"X-Forwarded-For": f"10.0.0.1, {SWEDEN}"},
                                       json={"app_id": 5207970, "ticket": "14000000" + "ab" * 100,
                                             "consent": {"gameplay": True, "hardware": False}})
        body = await response.json()
        assert body["session_id"]
        row = w.store.rows("sessions", PID)[0]
        assert (row["country"], row["region"]) == ("SE", "Stockholm")
        cookie = await w.sign_in()
        me = await (await w.client.get("/gamedata/v1/me", headers=w.page(cookie))).json()
        assert me["games"][0]["countries"] == ["SE"]
        players = (await (await w.client.post("/gamedata/v1/internal/lookup", json={"steamids": [STEAMID]},
                                              headers={"X-Internal-Key": w.cfg.internal_key})).json())["players"]
        game = players[STEAMID]["games"][0]
        assert game["countries"] == ["SE"] and game["regions"] == [{"country": "SE", "region": "Stockholm"}]
    run(tmp_path, steps, geo_opener=opener())

    for path in (tmp_path / "data").rglob("*"):
        if path.is_file():
            assert SWEDEN.encode() not in path.read_bytes()
    text = "\n".join(r.getMessage() for r in caplog.records if r.name.startswith("gamedata"))
    assert SWEDEN not in text and "Stockholm" not in text


def test_private_and_bad_addresses_place_nowhere():
    geo = Geo("/nonexistent", opener=opener())
    for ip in ("127.0.0.1", "10.1.2.3", "192.168.1.1", "::1", "not an ip"):
        assert geo.locate(ip) == (None, None)


def test_no_database_means_nulls(tmp_path, caplog):
    caplog.set_level(logging.WARNING)

    async def steps(w):
        response = await w.client.post("/gamedata/v1/session/start", headers={"X-Forwarded-For": SWEDEN}, json={
            "app_id": 5207970, "ticket": "14000000" + "ab" * 100, "consent": {"gameplay": True, "hardware": True}})
        assert response.status == 200
        row = w.store.rows("sessions", PID)[0]
        assert (row["country"], row["region"]) == (None, None)
    run(tmp_path, steps, geo_opener=opener())
    assert "no geo database" in caplog.text


def test_reader_picks_up_a_new_file(tmp_path):
    path = tmp_path / "geo.mmdb"
    path.write_bytes(b"one")
    opened: list[str] = []
    now = [0.0]
    geo = Geo(str(path), opener=opener(log=opened), clock=lambda: now[0])
    assert geo.locate(SWEDEN) == ("SE", "Stockholm")
    first = geo.reader
    assert geo.locate("8.8.8.8") == ("US", None) and len(opened) == 1
    replacement = tmp_path / "new.mmdb"
    replacement.write_bytes(b"two")
    replacement.replace(path)
    import os
    os.utime(path, (1, 1))
    now[0] = 61
    geo.locate(SWEDEN)
    assert len(opened) == 2 and first.closed
    path.unlink()
    now[0] = 200
    assert geo.locate(SWEDEN) == (None, None)


def test_a_broken_reader_never_breaks_a_lookup(tmp_path):
    path = tmp_path / "geo.mmdb"
    path.write_bytes(b"x")

    def broken(_):
        raise ValueError("not an mmdb")
    assert Geo(str(path), opener=broken).locate(SWEDEN) == (None, None)


# The updater

NOV = datetime(2026, 11, 4, 12, tzinfo=timezone.utc).timestamp()


def test_months():
    assert geoupdate.months(NOV) == ["2026-11", "2026-10"]
    assert geoupdate.months(datetime(2027, 1, 2, tzinfo=timezone.utc).timestamp()) == ["2027-01", "2026-12"]


class FakeDownloads:
    def __init__(self, available: dict[str, bytes]):
        self.available = available
        self.asked: list[str] = []

    def __call__(self, url: str, dest: Path) -> bool:
        self.asked.append(url)
        for month, data in self.available.items():
            if url == geoupdate.URL.format(month=month):
                dest.write_bytes(gzip.compress(data))
                return True
        return False


def test_update_swaps_in_this_months_file(tmp_path):
    path = tmp_path / "geo" / "dbip-city-lite.mmdb"
    downloads = FakeDownloads({"2026-11": b"november"})
    checked = []
    result = geoupdate.update(path, now=NOV, fetch=downloads, check=lambda p: checked.append(p.read_bytes()),
                              month_of=lambda p: None)
    assert result == "updated to 2026-11"
    assert path.read_bytes() == b"november" and checked == [b"november"]
    assert downloads.asked == ["https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz"]
    assert sorted(p.name for p in path.parent.iterdir()) == ["dbip-city-lite.mmdb"]  # no temp files left


def test_update_falls_back_to_last_month_and_skips_when_current(tmp_path):
    path = tmp_path / "dbip-city-lite.mmdb"
    downloads = FakeDownloads({"2026-10": b"october"})
    assert geoupdate.update(path, now=NOV, fetch=downloads, check=lambda p: None,
                            month_of=lambda p: None) == "updated to 2026-10"
    assert path.read_bytes() == b"october"
    # Already this month's: nothing downloaded.
    downloads.asked.clear()
    assert geoupdate.update(path, now=NOV, fetch=downloads, check=lambda p: None,
                            month_of=lambda p: "2026-11") == "already the newest (2026-11)"
    assert downloads.asked == []
    # Last month's, and this month's isn't out: nothing to do either.
    assert geoupdate.update(path, now=NOV, fetch=downloads, check=lambda p: None,
                            month_of=lambda p: "2026-10") == "already the newest (2026-10)"
    with pytest.raises(geoupdate.UpdateError):
        geoupdate.update(tmp_path / "other.mmdb", now=NOV, fetch=FakeDownloads({}), check=lambda p: None,
                         month_of=lambda p: None)


def test_a_bad_download_leaves_the_old_file(tmp_path):
    path = tmp_path / "dbip-city-lite.mmdb"
    path.write_bytes(b"the old one")
    # The real check: garbage doesn't open as an MMDB.
    pytest.importorskip("maxminddb")
    with pytest.raises(geoupdate.UpdateError, match="doesn't open"):
        geoupdate.update(path, now=NOV, fetch=FakeDownloads({"2026-11": b"not an mmdb"}), month_of=lambda p: None)
    assert path.read_bytes() == b"the old one"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["dbip-city-lite.mmdb"]

    def not_gzip(url, dest):
        dest.write_bytes(b"plain")
        return True
    with pytest.raises(geoupdate.UpdateError, match="gzip"):
        geoupdate.update(path, now=NOV, fetch=not_gzip, check=lambda p: None, month_of=lambda p: None)
    assert path.read_bytes() == b"the old one"
