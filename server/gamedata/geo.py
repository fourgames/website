"""Country and region from the player's IP at session start, from a local, offline copy of DB-IP's
free "IP to City Lite" database (CC BY 4.0: "IP Geolocation by DB-IP", https://db-ip.com).

Only the country's ISO code and the region's (subdivision's) English name are kept, on the session
row. The IP itself is never stored or logged, not even hashed. Without the database file (or the
maxminddb package) both are null and everything else works as before.

geoupdate.py fetches a new file every month and swaps it in; the reader here notices the new file
by itself (it looks at the file at most once a minute), so the service needs no restart.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import time
from typing import Any, Callable

log = logging.getLogger("gamedata.geo")

CHECK_EVERY = 60
MAX_REGION = 100


def open_mmdb(path: str):
    import maxminddb  # only needed with a database; tests pass their own opener

    # Memory-mapped: the OS reads the pages a lookup touches, the file isn't loaded whole.
    return maxminddb.open_database(path, maxminddb.MODE_MMAP)


def place(record: Any) -> tuple[str | None, str | None]:
    """(country ISO code, region name) from a DB-IP / GeoLite2-style city record."""
    if not isinstance(record, dict):
        return None, None
    country = record.get("country")
    code = country.get("iso_code") if isinstance(country, dict) else None
    if not (isinstance(code, str) and len(code) == 2 and code.isalpha()):
        code = None
    region = None
    subdivisions = record.get("subdivisions")
    if isinstance(subdivisions, list) and subdivisions and isinstance(subdivisions[0], dict):
        names = subdivisions[0].get("names")
        name = names.get("en") if isinstance(names, dict) else None
        if isinstance(name, str) and name.strip():
            region = name.strip()[:MAX_REGION]
    return (code.upper() if code else None), region


class Geo:
    def __init__(self, path: str, opener: Callable[[str], Any] = open_mmdb, clock=time.monotonic):
        self.path = path
        self.opener = opener
        self.clock = clock
        self.reader = None
        self.mtime: float | None = None
        self.checked = -1e9
        self.warned = False

    def _refresh(self) -> None:
        now = self.clock()
        if now - self.checked < CHECK_EVERY:
            return
        self.checked = now
        try:
            mtime = os.stat(self.path).st_mtime
        except OSError:
            if not self.warned:
                log.warning("no geo database at %s: country and region stay empty", self.path)
                self.warned = True
            self._close()
            return
        if mtime == self.mtime and self.reader is not None:
            return
        try:
            reader = self.opener(self.path)
        except Exception as error:  # noqa: BLE001 - a bad file means no places, not a broken service
            log.warning("can't open the geo database: %s", type(error).__name__)
            self._close()
            return
        self._close()
        self.reader, self.mtime, self.warned = reader, mtime, False
        log.info("geo database loaded")

    def _close(self) -> None:
        if self.reader is not None:
            try:
                self.reader.close()
            except Exception:  # noqa: BLE001
                pass
        self.reader, self.mtime = None, None

    def locate(self, ip: str) -> tuple[str | None, str | None]:
        """(country, region) for a public IP, else (None, None). Never raises."""
        try:
            address = ipaddress.ip_address(ip)
        except ValueError:
            return None, None
        if not address.is_global:
            return None, None
        self._refresh()
        if self.reader is None:
            return None, None
        try:
            return place(self.reader.get(str(address)))
        except Exception as error:  # noqa: BLE001
            log.warning("geo lookup failed: %s", type(error).__name__)
            return None, None

    def close(self) -> None:
        self._close()
