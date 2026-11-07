"""reading.json's ``dotenv`` and ``env-script`` cases, and the files' hostile shapes."""

from __future__ import annotations

import pytest
from support import bytes_of, cases, expected_errors, ids, settings_of

from coqui_aos import Class, Environment, Error, Settings, parse_dotenv, read_dotenv, read_env_script_output

ALL = cases("reading.json")
MINE = [case for case in ALL if case["format"] in ("dotenv", "env-script")]


def test_the_other_formats_belong_to_other_tests():
    # ``aos`` and ``catalog`` cases are read by the document and catalog tests.
    assert len(MINE) + len([c for c in ALL if c["format"] in ("aos", "catalog")]) == len(ALL)
    assert len(MINE) == 68


@pytest.mark.parametrize("case", MINE, ids=ids(MINE))
def test_reading(case):
    data = bytes_of(case)
    expect = case["expect"]
    try:
        if case["format"] == "dotenv":
            env = Environment(case.get("env", {}), case.get("os") == "windows")
            for name in case.get("secret_variables", ()):
                env.set(name, env.get(name) or "", True)
            got = dict(read_dotenv(data, env))
        else:
            got = read_env_script_output(data, settings_of(case))
    except Error as error:
        assert error.class_.value in expected_errors(expect), error
    else:
        assert "data" in expect, "read %r, expected an error" % (got,)
        assert got == expect["data"]


def test_a_line_error_counts_from_the_first_line():
    with pytest.raises(Error) as raised:
        parse_dotenv(b"A=1\n\n# c\nnot an assignment\n")
    assert raised.value.class_ is Class.DOTENV_SYNTAX
    assert raised.value.line == 4
    with pytest.raises(Error) as raised:
        parse_dotenv(b"A=1\r\na=2\r\n")
    assert (raised.value.class_, raised.value.line) == (Class.DUPLICATE_KEY, 2)


def test_a_name_with_a_non_ascii_letter_is_no_assignment():
    with pytest.raises(Error) as raised:
        parse_dotenv("É=1\n".encode("utf-8"))
    assert raised.value.class_ is Class.DOTENV_SYNTAX


def test_export_alone_is_a_name():
    assert [(line.name, line.text) for line in parse_dotenv(b"export=1\nexport X=2\n")] == [
        ("export", "1"),
        ("X", "2"),
    ]


def test_a_dotenv_refusal_never_quotes_the_text():
    with pytest.raises(Error) as raised:
        parse_dotenv(b"PASSWORD hunter2\n")
    assert "hunter2" not in str(raised.value)


def test_an_env_script_past_the_manifest_limit_is_too_large():
    settings = Settings().replace(manifest_bytes=10)
    with pytest.raises(Error) as raised:
        read_env_script_output(b'{"A": "' + b"x" * 100 + b'"}', settings)
    assert raised.value.class_ is Class.TOO_LARGE


def test_an_env_script_nested_past_the_depth_limit_is_too_deep():
    settings = Settings().replace(manifest_depth=4)
    with pytest.raises(Error) as raised:
        read_env_script_output(b'{"A": [[[[[1]]]]]}', settings)
    assert raised.value.class_ is Class.TOO_DEEP


def test_deep_nesting_with_the_limit_lifted_is_refused_without_a_crash():
    settings = Settings().replace(manifest_depth=None, manifest_bytes=None)
    with pytest.raises(Error) as raised:
        read_env_script_output(b"[" * 200_000 + b"]" * 200_000, settings)
    assert raised.value.class_ in (Class.TOO_DEEP, Class.ENV_SCRIPT_OUTPUT)


def test_env_script_values_must_be_text_without_a_zero_byte():
    for body in (b'{"A": "x\\u0000y"}', b'{"A": true}', b'{"1A": "x"}', b'{"A": "\\ud800"}'):
        with pytest.raises(Error):
            read_env_script_output(body)


def test_env_script_non_finite_numbers_are_refused():
    with pytest.raises(Error) as raised:
        read_env_script_output(b'{"A": NaN}')
    assert raised.value.class_ is Class.PARSE_ERROR
