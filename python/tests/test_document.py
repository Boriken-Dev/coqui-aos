"""Reading: the vectors' `aos` and `catalog` document cases, and hostile input the vectors lack."""

from __future__ import annotations

import pytest
from support import bytes_of, cases, expected_errors, ids, settings_of, strict

from coqui_aos import Class, Error, Settings, read_document

READING = [case for case in cases("reading.json") if case["format"] == "aos"]


@pytest.mark.parametrize("case", READING, ids=ids(READING))
def test_vector(case):
    expect = case["expect"]
    settings = settings_of(case)
    errors = expected_errors(expect)
    if errors and "data" not in expect:
        with pytest.raises(Error) as raised:
            read_document(bytes_of(case), settings)
        assert raised.value.class_.value in errors
        return
    try:
        got = read_document(bytes_of(case), settings)
    except Error as error:
        assert error.class_.value in errors
    else:
        assert strict(got) == strict(expect["data"])


def test_every_aos_case_ran():
    assert len(READING) > 0


@pytest.mark.parametrize(
    "text,class_",
    [
        ("#!json\n" + "[" * 100_000, Class.TOO_DEEP),
        ("#!json\n" + '{"a":' * 5_000 + "1" + "}" * 5_000, Class.TOO_DEEP),
        ("#!yaml\n" + "- " * 100_000, Class.TOO_DEEP),
        ("a = " + "[" * 100_000, Class.TOO_DEEP),
    ],
    ids=["json-array", "json-mapping", "yaml-sequence", "toml-array"],
)
def test_deep_text_is_too_deep_not_a_crash(text, class_):
    with pytest.raises(Error) as raised:
        read_document(text.encode())
    assert raised.value.class_ is class_


def test_lifted_depth_does_not_overflow_the_stack_while_checking():
    depth = 400
    text = "#!json\n" + '{"a":' * depth + "1" + "}" * depth
    got = read_document(text.encode(), Settings().replace(manifest_depth=None))
    for _ in range(depth - 1):
        got = got["a"]
    assert got == {"a": 1}


def test_huge_integer_is_refused_before_it_is_converted():
    with pytest.raises(Error) as raised:
        read_document(("#!json\n" + '{"a": ' + "9" * 100_000 + "}").encode())
    assert raised.value.class_ is Class.INTEGER_RANGE


def test_billion_laughs_is_refused_at_the_first_anchor():
    text = "#!yaml\na: &a [x, x, x]\nb: &b [*a, *a, *a]\nc: [*b, *b, *b]\n"
    with pytest.raises(Error) as raised:
        read_document(text.encode())
    assert raised.value.class_ is Class.YAML_ANCHOR
    assert raised.value.line == 2


def test_only_error_escapes():
    for payload in (b"\xff\xfe", b"#!\n", b"#!\xff\n", b"\x00", b"a = \x00", b"#!json\n\x00"):
        with pytest.raises(Error):
            read_document(payload)
