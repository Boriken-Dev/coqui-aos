"""Front matter, context files and overlay manifests, from the vectors."""

from __future__ import annotations

import pytest
from support import bytes_of, cases, decode, ids, settings_of, strict

from coqui_aos import (
    Class,
    Error,
    OverlayTree,
    applies,
    context_file_text,
    digest_entries,
    read_front_matter,
    read_overlay,
    split_front_matter,
    to_data,
    validate,
)

FRONT_MATTER = cases("front_matter.json")


def slice_of(expect, key, data):
    if key + "_size" in expect:
        assert len(data) == expect[key + "_size"]
    elif key + "_base64" in expect:
        assert data == decode(expect[key + "_base64"])
    else:
        assert data == expect[key].encode("utf-8")


def check_document(case):
    data = bytes_of(case)
    found = read_front_matter(data, settings_of(case))
    expect = case["expect"]
    assert found.case.value == expect["case"]
    for key in ("metadata_offset", "metadata_line", "body_offset", "body_line"):
        assert getattr(found, key) == expect.get(key), key
    assert (found.format.value if found.format else None) == expect.get("format")
    allowed = expect.get("error")
    allowed = allowed if isinstance(allowed, list) else [allowed]
    assert (found.error.class_.value if found.error else None) in allowed
    if "line" in expect:
        assert found.error.line == expect["line"]
    if "metadata_offset" in expect:
        slice_of(expect, "metadata", found.metadata)
    if "body_offset" in expect:
        slice_of(expect, "body", data[expect["body_offset"] :])
    if "data" in expect:
        assert strict(found.data) == strict(expect["data"])
    else:
        assert found.data is None
    split = split_front_matter(data, settings_of(case))
    assert split.body_offset == found.body_offset
    assert split.metadata == found.metadata


def check_context_file(case):
    data = case["context_file"].encode("utf-8")
    try:
        got = {"text": context_file_text(data, settings_of(case)).decode("utf-8")}
    except Error as error:
        got = {"error": error.class_.value}
    assert got == case["expect"]


def check_overlay(case):
    files = {
        path: decode(value["base64"]) if isinstance(value, dict) else value.encode("utf-8")
        for path, value in case["files"].items()
    }
    tree = OverlayTree.from_texts(files)
    expect = case["expect"]
    if "error" in expect:
        with pytest.raises(Error) as raised:
            read_overlay(tree, settings_of(case))
        assert raised.value.class_.value == expect["error"]
        if "line" in expect:
            assert raised.value.line == expect["line"]
        return
    read = read_overlay(tree, settings_of(case))
    got = to_data(read)
    if got["harness_context"] is None:
        del got["harness_context"]
    got["applies"] = applies(validate(read.manifest, tree))
    if "digest" in expect:
        got["digest"] = digest_entries(
            [((path.encode("utf-8"),), _entry(value)) for path, value in files.items()]
        ).digest[:]
    assert strict(got) == strict(expect)


def _entry(data):
    from coqui_aos import TreeEntry

    return TreeEntry.file(data)


@pytest.mark.parametrize("case", FRONT_MATTER, ids=ids(FRONT_MATTER))
def test_vector(case):
    if "files" in case:
        check_overlay(case)
    elif "context_file" in case:
        check_context_file(case)
    else:
        check_document(case)


def test_the_bound_is_on_the_head_and_nothing_past_it_is_read():
    data = b"---\n" + b"".join(b"k%d: 1\n" % i for i in range(100)) + b"---\n" + b"\xff" * 1_000_000
    from coqui_aos import Settings

    found = read_front_matter(data, Settings().replace(manifest_bytes=10_000))
    assert found.case.value == "mapping" and found.body_offset == len(data) - 1_000_000


def test_an_unclosed_block_of_many_lines_is_linear():
    data = b"---\n" + b"a: 1\n" * 200_000
    assert split_front_matter(data).case.value in ("unterminated", "too-large")


def test_a_bare_error_is_never_a_traceback():
    for data in (b"---\n\x00\n---\n", b"---\n#!\n---\n", b"---\n#!json\n[[[[\n---\n", b"---\n&a x\n---\n"):
        found = read_front_matter(data)
        assert found.error is not None and isinstance(found.error.class_, Class)
