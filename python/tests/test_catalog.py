"""catalog.json (catalogs, listings and icons) and the catalog cases of reading.json."""

from __future__ import annotations

import time
from typing import Any, Dict

import pytest
from support import bytes_of, cases, decode, expected_errors, ids, settings_of, strict

from coqui_aos import (
    Class,
    Error,
    Settings,
    list_catalogs,
    read_catalog,
    read_catalog_document,
    read_icon,
    to_data,
)

CATALOG = cases("catalog.json")
READING = [case for case in cases("reading.json") if case["format"] == "catalog"]


def read(item: "Dict[str, Any]", settings: Settings = Settings()):
    return read_catalog(item["text"].encode("utf-8"), item["name"], item.get("base"), settings)


def section(value: Any) -> "Dict[str, Any]":
    return {
        "entries": {
            name: {k: v for k, v in to_data(entry).items() if v is not None}
            for name, entry in value.entries.items()
        },
        "refused": [[name, why.value] for name, why in value.refused],
    }


def catalog_data(catalog: Any) -> "Dict[str, Any]":
    out: "Dict[str, Any]" = {"form": catalog.form.value}
    for key in ("name", "description", "homepage"):
        if getattr(catalog, key) is not None:
            out[key] = getattr(catalog, key)
    own = section(catalog.overlays)
    out["entries"], out["refused"] = own["entries"], own["refused"]
    if catalog.skills is not None:
        out["skills"] = section(catalog.skills)
    out["ignored"] = catalog.ignored
    return out


@pytest.mark.parametrize("case", READING, ids=ids(READING))
def test_reading_a_catalog_document(case):
    expect = case["expect"]
    errors = expected_errors(expect)
    try:
        got = read_catalog_document(bytes_of(case), case["name"], settings_of(case))
    except Error as error:
        assert error.class_.value in errors, error
        return
    assert "data" in expect, "read %r, expected an error %r" % (got, errors)
    assert strict(got) == strict(expect["data"])


def check_icon(case):
    icon = case["icon"]
    limits = icon.get("limits", {})
    changes = {}
    for key, setting in (
        ("max_bytes", "icon_bytes"),
        ("max_width", "icon_width"),
        ("max_height", "icon_height"),
    ):
        if key in limits:
            changes[setting] = limits[key]
    try:
        got = to_data(read_icon(decode(icon["base64"]), icon["name"], Settings().replace(**changes)))
    except Error as error:
        got = {"error": error.class_.value}
    assert strict(got) == strict(case["expect"])


def check_listing(case):
    try:
        listing = list_catalogs([(item["label"], read(item)) for item in case["catalogs"]])
    except Error as error:
        got = {"error": error.class_.value}
    else:
        got = to_data(listing)
        if case["choose"]:
            chosen = {}
            for request in case["choose"]:
                try:
                    entry = listing.choose(request)
                    chosen[request] = {"catalog": entry.catalog, "name": entry.name}
                except Error as error:
                    chosen[request] = {"error": error.class_.value}
            got["chosen"] = chosen
    assert strict(got) == strict(case["expect"])


@pytest.mark.parametrize("case", CATALOG, ids=ids(CATALOG))
def test_catalog_vectors(case):
    if "icon" in case:
        return check_icon(case)
    if "catalogs" in case:
        return check_listing(case)
    expect = case["expect"]
    try:
        got = catalog_data(read(case["catalog"]))
    except Error as error:
        got = {"error": error.class_.value}
    assert strict(got) == strict(expect)


def test_every_catalog_case_is_run():
    assert len(CATALOG) == 55 and len(READING) == 14


# Behaviour no vector states.


def test_a_catalog_of_many_entries_is_read_in_order():
    lines = "".join('n%05d = "https://example.org/r.git"\n' % i for i in range(20000))
    started = time.monotonic()
    catalog = read_catalog(("[overlays]\n" + lines).encode(), "c.toml", None, Settings())
    assert len(catalog.overlays.entries) == 20000
    assert time.monotonic() - started < 30


def test_a_catalog_past_its_limit_is_too_large():
    with pytest.raises(Error) as raised:
        read_catalog(b"[overlays]\n" + b"# x\n" * 100, "c.toml", None, Settings().replace(catalog_bytes=64))
    assert raised.value.class_ is Class.TOO_LARGE


def test_a_base_that_is_no_source_is_refused():
    with pytest.raises(Error) as raised:
        read_catalog(b"[overlays]\na = 'x'\n", "c.toml", "git+ -x", Settings())
    assert raised.value.class_ is Class.INVALID_SOURCE


def test_a_url_catalog_never_shows_credentials_it_refuses_them():
    text = (
        b'[overlays]\na = "https://user:secret@example.org/r.git"\nb = "https://example.org/r.git?token=x"\n'
    )
    catalog = read_catalog(text, "c.toml", "https://example.org/c.toml", Settings())
    assert catalog.overlays.entries == {}
    assert [why.value for _name, why in catalog.overlays.refused] == ["source-credentials"] * 2


def test_a_source_never_reprs_its_credentials():
    text = b'[overlays]\na = "git@example.org:r.git"\n'
    entry = read_catalog(text, "c.toml", None, Settings()).overlays.entries["a"]
    assert "secret" not in repr(entry)


def test_a_hostile_entry_value_is_a_refusal_not_a_crash():
    text = b'[overlays]\na = 5\nb = {source = 5}\nc = {source = "x", extra = 1}\nd = ["x"]\n'
    catalog = read_catalog(text, "c.toml", None, Settings())
    assert [why.value for _name, why in catalog.overlays.refused] == ["invalid-entry"] * 4
