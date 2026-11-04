"""Reads keys from an uploaded file: a plain list (one per line) or a CSV such as Steamworks' export."""

from __future__ import annotations

import csv
import re

# What a Steam key looks like (AAAAA-BBBBB-CCCCC, sometimes more groups). Only used to find the key
# column in a CSV without a "key" header; plain lists may hold any kind of key.
KEY_PATTERN = re.compile(r"^[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,5}$", re.IGNORECASE)
HEADER_WORDS = {"key", "keys", "cd key", "cd keys", "cdkey", "product key", "steam key", "code", "codes"}
DELIMITERS = [",", ";", "\t"]


class KeyFileError(Exception):
    pass


def parse_keys(text: str) -> list[str]:
    """The keys in the file, in order, each once."""
    return read_keys(text)[0]


def read_keys(text: str) -> tuple[list[str], int]:
    """(the keys in order, each once; how many repeats in the file were dropped)."""
    text = text.lstrip("﻿")  # Excel's byte order mark
    lines = [line.strip() for line in text.splitlines()]
    lines = [line for line in lines if line and not line.startswith("#")]
    if not lines:
        return [], 0

    delimiter = _delimiter(lines)
    if delimiter is None:
        values = lines
        if values[0].lower() in HEADER_WORDS:
            values = values[1:]
    else:
        rows = [[cell.strip() for cell in row] for row in csv.reader(lines, delimiter=delimiter)]
        values = _key_column(rows)

    values = [value for value in values if value]
    keys = list(dict.fromkeys(values))  # drops repeats, keeps the order
    return keys, len(values) - len(keys)


def _delimiter(lines: list[str]) -> str | None:
    """The CSV delimiter, or None for a plain list. Keys never contain these characters."""
    sample = lines[:20]
    counts = {d: sum(line.count(d) for line in sample) for d in DELIMITERS}
    best = max(counts, key=lambda d: counts[d])
    return best if counts[best] else None


def _key_column(rows: list[list[str]]) -> list[str]:
    header = [cell.lower() for cell in rows[0]]
    # A header that names the key column: an exact "key"-like name first, then anything with "key".
    for matches in (lambda h: h in HEADER_WORDS, lambda h: "key" in h):
        for index, name in enumerate(header):
            if matches(name) and not KEY_PATTERN.match(rows[0][index]):
                return [row[index] for row in rows[1:] if len(row) > index]

    # No such header: the column where most cells look like Steam keys, keeping only those cells
    # (which also drops a header row with other names).
    width = max(len(row) for row in rows)
    scores = [sum(1 for row in rows if len(row) > i and KEY_PATTERN.match(row[i])) for i in range(width)]
    best = max(range(width), key=lambda i: scores[i])
    if not scores[best]:
        raise KeyFileError("couldn't find the key column: name it \"Key\" in the first row")
    return [row[best] for row in rows if len(row) > best and KEY_PATTERN.match(row[best])]
