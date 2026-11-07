"""validation.json, and hostile manifests the vectors do not write."""

from __future__ import annotations

import pytest
from support import cases, ids

from coqui_aos import Class, Issue, OverlayTree, applies, named_files, skill_flags, valid_license, validate

VALIDATION = cases("validation.json")


@pytest.mark.parametrize("case", VALIDATION, ids=ids(VALIDATION))
def test_validation(case):
    tree = OverlayTree(case["files"]) if "files" in case else None
    issues = validate(case["document"], tree)
    expect = case["expect"]
    if "applies" in expect:
        assert applies(issues) is expect["applies"], issues
    if expect["valid"]:
        assert not issues, issues
        if tree is not None:
            assert skill_flags(case["document"], tree) == expect.get("flags", [])
        return
    at = expect["at"]
    if "class" in expect:
        assert Issue(Class(expect["class"]), at) in issues, issues
    assert any(
        found.at == at or found.at.startswith(at + "/") or (found.at and at.startswith(found.at + "/"))
        for found in issues
    ), (at, issues)


def nest(depth, leaf="x"):
    value = leaf
    for _ in range(depth):
        value = {"k": value}
    return value


def test_a_manifest_nested_past_the_stack_is_validated_without_recursion():
    doc = {
        "skills": [{"name": nest(5000), "source": nest(5000)}, nest(5000)],
        "mcp": {"servers": [{"name": nest(5000)}]},
    }
    assert any(issue.at.startswith("/skills") for issue in validate(doc))
    twice = {"skills": [nest(5000), nest(5000)]}
    assert validate(twice)


def test_equal_deep_values_are_duplicates_and_different_ones_are_not():
    assert any(
        i.code is Class.SCHEMA and i.at == "/skills" for i in validate({"skills": [nest(300), nest(300)]})
    )
    assert not any(
        i.at == "/skills"
        for i in validate({"skills": [{"name": "a", "source": "x"}, {"name": "b", "source": "x"}]})
    )


def test_one_and_one_point_zero_and_true_are_different_values():
    from coqui_aos._validate import _canonical

    assert len({_canonical(1), _canonical(1.0), _canonical(True)}) == 3
    assert _canonical({"a": 1, "b": 2}) == _canonical({"b": 2, "a": 1})


def test_a_huge_flat_manifest_is_linear():
    doc = {"env": {"V%d" % n: "x" for n in range(20000)}}
    assert validate(doc) == []


def test_a_float_is_integer_required_and_a_bool_is_no_integer():
    assert Issue(Class.INTEGER_REQUIRED, "/priority") in validate({"priority": 1.0})
    assert Issue(Class.SCHEMA, "/priority") in validate({"priority": True})
    assert Issue(Class.SCHEMA, "/priority") in validate({"priority": 2**63})


def test_a_pointer_escapes_its_key():
    assert Issue(Class.SCHEMA, "/env/a~1b") in validate({"env": {"a/b": "x"}})


def test_named_files_reads_every_field_that_names_one():
    doc = {"rules": ["r.md"], "hooks": {"cd": "h.py", "prompt": {"run": "p.py"}}, "about": {"icon": "i.png"}}
    assert named_files(doc) == [
        ("/rules/0", "r.md"),
        ("/hooks/cd", "h.py"),
        ("/hooks/prompt/run", "p.py"),
        ("/about/icon", "i.png"),
    ]


@pytest.mark.parametrize(
    "expression, ok",
    [
        ("MIT", True),
        ("MIT OR Apache-2.0", True),
        ("GPL-2.0+ WITH Classpath-exception-2.0", True),
        ("(MIT AND BSD-3-Clause) OR LicenseRef-x", True),
        ("MIT or Apache-2.0", False),
        ("", False),
        ("MIT AND", False),
        ("(MIT", False),
        ("MIT)", False),
        ("MIT WITH", False),
        ("AND MIT", False),
        ("()", False),
        ("MIT Apache-2.0", False),
    ],
)
def test_license_expressions(expression, ok):
    assert valid_license(expression) is ok


def test_license_parentheses_nest_to_128_and_no_further_without_recursion():
    assert valid_license("(" * 128 + "MIT" + ")" * 128)
    assert not valid_license("(" * 129 + "MIT" + ")" * 129)
    assert not valid_license("(" * 100000 + "MIT")


def test_issues_are_sorted_and_unique():
    issues = validate({"env": {"a": 1, "B": 2}, "priority": "x"})
    assert issues == sorted(set(issues), key=lambda i: (i.at, i.code.value))
