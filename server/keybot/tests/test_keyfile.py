"""Reading key files: plain lists and CSV exports."""

import pytest

from keybot.keyfile import KeyFileError, parse_keys, read_keys

A, B, C = "AAAAA-BBBBB-CCCCC", "DDDDD-EEEEE-FFFFF", "GGGGG-HHHHH-IIIII"


def test_plain_list():
    assert parse_keys(f"{A}\n\n  {B}  \r\n{C}\n") == [A, B, C]


def test_plain_list_with_header_comments_and_bom():
    assert parse_keys(f"﻿Key\n# batch 1\n{A}\n{B}\n") == [A, B]


def test_repeats_in_file_are_counted():
    assert read_keys(f"{A}\n{B}\n{A}\n") == ([A, B], 1)


def test_csv_with_key_header():
    text = f"Package,Key,Date\nGame,{A},2026-01-01\nGame,{B},2026-01-01\n"
    assert parse_keys(text) == [A, B]


def test_csv_header_containing_key():
    text = f"Batch;CD Key Value\n1;{A}\n1;{B}\n"
    assert parse_keys(text) == [A, B]


def test_csv_without_header_finds_key_column():
    text = f"1,{A},x\n2,{B},y\n"
    assert parse_keys(text) == [A, B]


def test_csv_with_other_header_drops_it():
    text = f"Id\tCode Value\n1\t{A}\n2\t{B}\n"
    assert parse_keys(text) == [A, B]


def test_csv_quoted():
    assert parse_keys(f'"Key","Note"\n"{A}","first"\n"{B}","second, really"\n') == [A, B]


def test_csv_without_any_key_column():
    with pytest.raises(KeyFileError):
        parse_keys("name,score\nbob,3\n")


def test_empty():
    assert parse_keys("") == []
    assert parse_keys("\n\n# nothing\n") == []
