"""names.json, and the folding and shape rules the vectors do not pin."""

from __future__ import annotations

import pytest
from support import cases, ids

from coqui_aos import (
    is_reserved_variable,
    is_sensitive_variable,
    is_variable_name,
    normalize_name,
    os_matches,
    root_variable,
    state_variable,
    valid_overlay_name,
    valid_relative_path,
)

NAMES = cases("names.json")


@pytest.mark.parametrize("case", NAMES, ids=ids(NAMES))
def test_names(case):
    expect = case["expect"]
    assert valid_overlay_name(case["name"]) is expect["valid"]
    if expect["valid"]:
        assert normalize_name(case["name"]) == expect["normalized"]
        assert root_variable(case["name"]) == expect["variable"]


def test_state_variable_is_the_root_variable_with_state():
    assert state_variable("My.Overlay") == "MY_OVERLAY_OVERLAY_STATE"


@pytest.mark.parametrize("name", ["abc\n", "abc ", "\u00e9x", "a\u212a", "", "1a", "a-"])
def test_an_identity_is_ascii_and_ends_at_its_last_character(name):
    assert not valid_overlay_name(name)


def test_folding_is_ascii_only():
    # "\u017f" upper-cases to "S" under Unicode rules, which would make these variables sensitive
    # or the consumer's.
    assert not is_sensitive_variable("\u017fSL_X")
    assert not is_reserved_variable("ao\u017f_x")
    assert normalize_name("\u0130x") == "\u0130x"
    assert is_sensitive_variable("ssl_cert") and is_reserved_variable("aos_x")


@pytest.mark.parametrize("name", ["A", "_x", "a1_"])
def test_variable_names(name):
    assert is_variable_name(name)


@pytest.mark.parametrize("name", ["", "1a", "a-b", "a\n", "\u00e9"])
def test_not_variable_names(name):
    assert not is_variable_name(name)


@pytest.mark.parametrize(
    "path",
    ["a/b", "a b/c", "x.txt", "a/.hidden"],
)
def test_relative_paths(path):
    assert valid_relative_path(path)


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/a",
        "a//b",
        "a/",
        "a.",
        "a /b",
        "C:/x",
        "a\\b",
        "a\nb",
        "NUL",
        "a/con.txt",
        ".git/x",
        "a/.GIT",
        "x.pyc",
        "A~1",
        "a\u202eb",
    ],
)
def test_refused_relative_paths(path):
    assert not valid_relative_path(path)


def test_an_os_list_selects_by_name_or_unix():
    assert os_matches(None, "windows")
    assert os_matches(["unix"], "linux") and not os_matches(["unix"], "windows")
    assert os_matches(["windows"], "windows") and not os_matches([], "linux")
