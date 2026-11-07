"""Substitution: the operators, what is not a placeholder, and the limits."""

from __future__ import annotations

import time
from typing import Dict, Optional

import pytest

from coqui_aos import Class, Error, Settings, substitute, substitute_with


def reading(values: "Dict[str, str]"):
    def lookup(name: str) -> "Optional[str]":
        return values.get(name)

    return lookup


V = reading({"A": "hello", "E": "", "P": "/usr/local/bin/tool.tar.gz", "N": "Straße"})


@pytest.mark.parametrize(
    "text, want",
    [
        ("${A}", "hello"),
        ("$A", "$A"),
        ("$$", "$"),
        ("$(A)", "$(A)"),
        ("${#A}", "5"),
        ("${#N}", "6"),
        ("${U:-d}", "d"),
        ("${E:-d}", "d"),
        ("${E-d}", ""),
        ("${A:-d}", "hello"),
        ("${A:+yes}", "yes"),
        ("${E:+yes}", ""),
        ("${E+yes}", "yes"),
        ("${U:=x${A}}", "xhello"),
        ("${A:1}", "ello"),
        ("${A:1:2}", "el"),
        ("${A:(-2)}", "lo"),
        ("${A: -2:1}", "l"),
        ("${A:2:-1}", "ll"),
        ("${A:9}", ""),
        ("${A:99999999999999999999999}", ""),
        ("${P#*/}", "usr/local/bin/tool.tar.gz"),
        ("${P##*/}", "tool.tar.gz"),
        ("${P%.*}", "/usr/local/bin/tool.tar"),
        ("${P%%.*}", "/usr/local/bin/tool"),
        ("${P/local/LOCAL}", "/usr/LOCAL/bin/tool.tar.gz"),
        ("${P//o/0}", "/usr/l0cal/bin/t00l.tar.gz"),
        ("${P/#\\/usr/X}", "X/local/bin/tool.tar.gz"),
        ("${P/%gz/Z}", "/usr/local/bin/tool.tar.Z"),
        ("${P//[a-c]/_}", "/usr/lo__l/_in/tool.t_r.gz"),
        ("${A^}", "Hello"),
        ("${A^^}", "HELLO"),
        ("${N,,}", "straße"),
        ("${N^^}", "STRASSE"),
        ("${A,}", "hello"),
        ("${}", "${}"),
        ("${A", "${A"),
        ("${1}", "${1}"),
        ("${A:x}", "${A:x}"),
        ("${A@Q}", "${A@Q}"),
    ],
)
def test_operators(text, want):
    assert substitute(text, V) == want


def test_an_unset_variable_is_named_by_class_and_never_quoted():
    with pytest.raises(Error) as raised:
        substitute("${MISSING}", V)
    assert raised.value.class_ is Class.UNDEFINED_VARIABLE


def test_a_lookup_refusal_is_not_swallowed():
    def lookup(name: str) -> "Optional[str]":
        raise Error(Class.SECRET_PLACEHOLDER, name)

    with pytest.raises(Error) as raised:
        substitute("${A:-${B}}", lookup)
    assert raised.value.class_ is Class.SECRET_PLACEHOLDER


@pytest.mark.parametrize("pattern", ["[!]", "[z-a]"])
def test_a_bad_bracket_expression_is_an_invalid_pattern(pattern):
    with pytest.raises(Error) as raised:
        substitute("${A#%s}" % pattern, V)
    assert raised.value.class_ is Class.INVALID_PATTERN


def test_nesting_past_the_depth_is_too_deep():
    text = "${U:-" * 40 + "x" + "}" * 40
    with pytest.raises(Error) as raised:
        substitute(text, V)
    assert raised.value.class_ is Class.TOO_DEEP
    assert substitute_with(text, V, Settings().replace(substitution_depth=64)) == "x"


def test_nesting_with_the_depth_lifted_never_overflows_the_stack():
    settings = Settings().replace(substitution_depth=None, substitution_bytes=None)
    text = "${U:-" * 5_000 + "x" + "}" * 5_000
    with pytest.raises(Error) as raised:
        substitute_with(text, V, settings)
    assert raised.value.class_ is Class.TOO_DEEP


def test_output_past_the_byte_limit_is_too_large():
    values = reading({"BIG": "x" * 600})
    settings = Settings().replace(substitution_bytes=1000)
    with pytest.raises(Error) as raised:
        substitute_with("${BIG}${BIG}", values, settings)
    assert raised.value.class_ is Class.TOO_LARGE
    with pytest.raises(Error) as raised:
        substitute_with("${BIG//x/yy}", values, settings)
    assert raised.value.class_ is Class.TOO_LARGE


def test_a_pattern_bomb_is_too_complex_and_quick():
    values = reading({"S": "a" * 3000})
    settings = Settings().replace(substitution_steps=200_000)
    started = time.monotonic()
    with pytest.raises(Error) as raised:
        substitute_with("${S//*a*b*/x}", values, settings)
    assert raised.value.class_ is Class.TOO_COMPLEX
    assert time.monotonic() - started < 10


def test_unclosed_placeholders_are_charged_for_their_rescans():
    settings = Settings().replace(substitution_steps=5_000)
    with pytest.raises(Error) as raised:
        substitute_with("${" * 5000, V, settings)
    assert raised.value.class_ is Class.TOO_COMPLEX
