"""source.json, and what a source shows and holds."""

from __future__ import annotations

import pytest
from support import cases, ids

from coqui_aos import Class, Error, Source, SourceKind
from coqui_aos._data import to_data

SOURCES = cases("source.json")


@pytest.mark.parametrize("case", SOURCES, ids=ids(SOURCES))
def test_source(case):
    if "error" in case["expect"]:
        with pytest.raises(Error) as raised:
            Source.parse(case["source"])
        assert raised.value.class_ is Class.INVALID_SOURCE
    else:
        assert to_data(Source.parse(case["source"])) == case["expect"]


def test_shown_drops_user_and_query_and_repr_never_holds_them():
    source = Source.parse("https://user:secret@example.com/x?token=abc")
    assert source.shown() == "https://example.com/x"
    assert "secret" not in repr(source) and "token" not in repr(source)
    assert source.holds_credentials()


def test_key_keeps_everything_the_fetch_needs():
    source = Source.parse("git+https://example.com/r.git@v1#sub/dir")
    assert source.key() == "https://example.com/r.git@v1#sub/dir"
    assert source.key("v2") == "https://example.com/r.git@v2#sub/dir"
    assert source.kind is SourceKind.GIT and source.kind == "git"


@pytest.mark.parametrize(
    "text, local",
    [
        ("./overlay", True),
        ("git+file:///srv/r.git", True),
        ("git+https://localhost/r.git", True),
        ("http://[::1]/x.tar", True),
        ("http://[::ffff:127.0.0.1]/x.tar", True),
        ("http://169.254.1.1/x.tar", True),
        ("git+https://github.com/o/r.git", False),
        ("git@github.com:o/r.git", False),
        ("https://example.com/o.tar.gz", False),
    ],
)
def test_is_local(text, local):
    assert Source.parse(text).is_local() is local


def test_a_lone_surrogate_is_a_refusal_or_a_value_never_a_crash():
    try:
        Source.parse("git+https://exa\udcffmple.com/%2Dx.git")
    except Error:
        pass


@pytest.mark.parametrize(
    "text", ["\x1fgit+https://x.com/r.git", "git+https://x.com/r.git\x1f", "git+ext::sh -c id"]
)
def test_controls_and_helpers_are_refused(text):
    with pytest.raises(Error):
        Source.parse(text)
