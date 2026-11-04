"""Fetches DB-IP's free "IP to City Lite" database for this month (or last month's, early in a month
before the new one is out), checks that it opens and answers, and swaps it in for GEOIP_DB in one
step. Run monthly by gamedata-geo.timer:

    python -m gamedata.geoupdate [--force]

The file is replaced by a rename, never written in place: the running service has the old one
memory-mapped and keeps reading it until it notices the new one. With --force it downloads even when
the file it has is already the newest month's.

DB-IP Lite is CC BY 4.0: wherever its data is shown, credit "IP Geolocation by DB-IP" with a link
to https://db-ip.com.
"""

from __future__ import annotations

import argparse
import gzip
import logging
import os
import secrets
import shutil
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .geo import place

log = logging.getLogger("gamedata.geoupdate")

URL = "https://download.db-ip.com/free/dbip-city-lite-{month}.mmdb.gz"
# The file is about 60 MB gzipped and 130 MB unpacked; these are well above, and stop a runaway.
MAX_GZIP = 400 * 1024 * 1024
MAX_MMDB = 1024 * 1024 * 1024
# Well-known addresses any real city database places in a country.
PROBES = ("8.8.8.8", "1.1.1.1", "9.9.9.9")
USER_AGENT = "fourgames-gamedata-geoupdate/1 (+https://fourgames.se)"


class UpdateError(Exception):
    pass


def months(now: float) -> list[str]:
    """This month and last month, as YYYY-MM (UTC)."""
    moment = datetime.fromtimestamp(now, timezone.utc)
    previous = (moment.year - 1, 12) if moment.month == 1 else (moment.year, moment.month - 1)
    return [f"{moment.year:04d}-{moment.month:02d}", f"{previous[0]:04d}-{previous[1]:02d}"]


def download(url: str, dest: Path, cap: int = MAX_GZIP) -> bool:
    """Streams `url` to `dest`. False if it isn't there (404); UpdateError for anything else."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response, open(dest, "wb") as out:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > cap:
                    raise UpdateError("the download is far bigger than expected")
                out.write(chunk)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise UpdateError(f"HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise UpdateError(type(error).__name__) from None
    return True


def gunzip(src: Path, dest: Path, cap: int = MAX_MMDB) -> None:
    try:
        with gzip.open(src, "rb") as packed, open(dest, "wb") as out:
            total = 0
            while chunk := packed.read(1024 * 1024):
                total += len(chunk)
                if total > cap:
                    raise UpdateError("the database is far bigger than expected")
                out.write(chunk)
    except (OSError, EOFError) as error:
        raise UpdateError(f"not a valid gzip file ({type(error).__name__})") from None


def built_month(path: Path) -> str | None:
    """The month the database at `path` was built (YYYY-MM), or None if it doesn't open."""
    try:
        import maxminddb

        with maxminddb.open_database(str(path), maxminddb.MODE_FILE) as reader:
            epoch = reader.metadata().build_epoch
    except Exception:  # noqa: BLE001 - missing or broken: treat as none
        return None
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m")


def verify(path: Path) -> None:
    """The file must open as an MMDB and place at least one well-known address in a country."""
    try:
        import maxminddb

        with maxminddb.open_database(str(path), maxminddb.MODE_FILE) as reader:
            found = [place(reader.get(ip))[0] for ip in PROBES]
    except Exception as error:  # noqa: BLE001
        raise UpdateError(f"the new database doesn't open ({type(error).__name__})") from None
    if not any(found):
        raise UpdateError("the new database doesn't place any test address in a country")


def update(path: Path, now: float | None = None, force: bool = False,
           fetch: Callable[[str, Path], bool] = download,
           check: Callable[[Path], None] = verify,
           month_of: Callable[[Path], str | None] = built_month) -> str:
    """Brings `path` up to date. What it did, for the log."""
    now = time.time() if now is None else now
    path.parent.mkdir(parents=True, exist_ok=True)
    have = None if force else month_of(path)
    for month in months(now):
        if have == month:
            return f"already the newest ({month})"
        tag = secrets.token_hex(4)
        packed = path.with_name(f".{path.name}.{tag}.gz")
        unpacked = path.with_name(f".{path.name}.{tag}.tmp")
        try:
            if not fetch(URL.format(month=month), packed):
                log.info("%s isn't out yet", month)
                continue
            gunzip(packed, unpacked)
            check(unpacked)
            os.chmod(unpacked, 0o644)
            os.replace(unpacked, path)
        finally:
            for temp in (packed, unpacked):
                try:
                    temp.unlink()
                except FileNotFoundError:
                    pass
        return f"updated to {month}"
    raise UpdateError("neither this month's nor last month's file could be found")


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(prog="python -m gamedata.geoupdate", description=__doc__.splitlines()[0])
    parser.add_argument("--force", action="store_true", help="download even if the file is this month's")
    args = parser.parse_args(argv)
    # The same default as the service: GEOIP_DB, else DATA_DIR/geo/dbip-city-lite.mmdb.
    data_dir = os.environ.get("DATA_DIR", "").strip().rstrip("/") or "/srv/fourgames/gamedata"
    path = Path(os.environ.get("GEOIP_DB", "").strip() or f"{data_dir}/geo/dbip-city-lite.mmdb")
    if shutil.disk_usage(path.parent if path.parent.exists() else "/").free < 512 * 1024 * 1024:
        log.error("not enough free disk for the download")
        return 1
    try:
        log.info("%s", update(path, force=args.force))
    except UpdateError as error:
        log.error("geo update failed: %s", error)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
