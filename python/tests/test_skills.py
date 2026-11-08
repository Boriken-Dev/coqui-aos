"""skills.json, the check of a fetched skill, and the fetching a caller supplies."""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

import pytest
from support import cases, decode, expected_errors, ids, settings_of, strict

from coqui_aos import (
    Class,
    Error,
    OverlayTree,
    Settings,
    Source,
    fetch_planned,
    read_catalog,
    read_fetched_skill,
    resolve_skills,
    to_data,
)

SKILLS = cases("skills.json")


def trees_of(case: "Dict[str, Any]") -> "Dict[str, OverlayTree]":
    out = {}
    for identity, files in case.get("files", {}).items():
        out[identity] = OverlayTree(files) if isinstance(files, list) else OverlayTree.from_texts(files)
    return out


def planned(skill: Any) -> "Dict[str, Any]":
    return {k: v for k, v in to_data(skill).items() if v is not None}


def resolved(case: "Dict[str, Any]") -> "Dict[str, Any]":
    catalogs = [
        (item["label"], read_catalog(item["text"].encode(), item["name"], item.get("base"), Settings()))
        for item in case.get("catalogs", [])
    ]
    plan = resolve_skills(
        case["overlays"],
        case["requested"],
        trees_of(case),
        catalogs,
        case.get("order", []),
        case.get("fetches", True),
        Settings(),
    )
    data = to_data(plan)
    data.pop("to_fetch")
    data["skills"] = [planned(skill) for skill in plan.skills]
    return data


def fetched(case: "Dict[str, Any]") -> "Dict[str, Any]":
    files = [
        (path, decode(content["base64"]) if isinstance(content, dict) else content.encode("utf-8"))
        for path, content in case["fetched"].items()
    ]
    try:
        read = read_fetched_skill(case["name"], files, case.get("pin"), settings_of(case))
    except Error as error:
        return {"error": error.class_.value}
    return {"digest": str(read.digest), "reported": read.reported, "files": list(read.files)}


@pytest.mark.parametrize("case", SKILLS, ids=ids(SKILLS))
def test_skills_vectors(case):
    expect = case["expect"]
    got = fetched(case) if "fetched" in case else resolved(case)
    if "error" in got and "fetched" in case:
        assert got["error"] in expected_errors(expect), got
        return
    assert strict(got) == strict(expect)


# Behaviour no vector states.


class Memory:
    def __init__(self, served: "Dict[str, Sequence[Tuple[str, bytes]]]") -> None:
        self.served = served
        self.asked: "List[str]" = []

    def fetch(self, source: Source) -> "Sequence[Tuple[str, bytes]]":
        self.asked.append(source.shown())
        if source.shown() not in self.served:
            raise Error(Class.IO, "no such source")
        return self.served[source.shown()]


SKILL = b"---\nname: review\ndescription: Reviews.\n---\nBody.\n"


def test_a_plan_is_fetched_through_the_callers_source_and_checked_against_its_pins():
    digest = str(read_fetched_skill("review", [("SKILL.md", SKILL)]).digest)
    overlays = {
        "a": {
            "skills": [
                {"name": "review", "source": "https://example.org/skills.git#review", "pin": digest},
                {"name": "lint", "source": "https://example.org/skills.git#lint", "pin": digest},
                {"name": "gone", "source": "https://example.org/skills.git#gone"},
            ]
        }
    }
    plan = resolve_skills(overlays, ["a"])
    assert len(plan.to_fetch) == 3
    source = Memory(
        {
            "https://example.org/skills.git#review": [("SKILL.md", SKILL)],
            "https://example.org/skills.git#lint": [("SKILL.md", b"---\nname: lint\n---\n")],
        }
    )
    outcomes = {item.name: item.outcome for item in fetch_planned(plan, source)}
    assert not isinstance(outcomes["review"], Error)
    assert outcomes["lint"].class_ is Class.PIN_MISMATCH
    assert outcomes["gone"].class_ is Class.IO
    assert len(source.asked) == 3


def test_a_consumer_that_does_not_fetch_is_asked_for_nothing():
    overlays = {"a": {"skills": [{"name": "x", "source": "https://example.org/x.git"}]}}
    plan = resolve_skills(overlays, ["a"], fetches=False)
    assert plan.to_fetch == [] and len(plan.not_fetched) == 1


def test_a_fetcher_that_fails_with_the_os_is_one_skills_outcome():
    class Broken:
        def fetch(self, source: Source):
            raise OSError("boom")

    overlays = {"a": {"skills": [{"name": "x", "source": "https://example.org/x.git"}]}}
    [only] = fetch_planned(resolve_skills(overlays, ["a"]), Broken())
    assert only.outcome.class_ is Class.IO


def test_a_cycle_in_requires_is_a_refusal():
    with pytest.raises(Error) as raised:
        resolve_skills({"a": {"requires": ["b"]}, "b": {"requires": ["a"]}}, ["a"])
    assert raised.value.class_ is Class.CYCLE


def test_a_fetched_tree_past_the_file_limit_is_too_large_before_it_is_hashed():
    files = [("SKILL.md", SKILL)] + [("f%d" % i, b"x") for i in range(50)]
    with pytest.raises(Error) as raised:
        read_fetched_skill("review", files, None, Settings().replace(tree_files=10))
    assert raised.value.class_ is Class.TOO_LARGE


def test_a_fetched_file_past_the_byte_limit_is_too_large():
    with pytest.raises(Error) as raised:
        read_fetched_skill(
            "review", [("SKILL.md", SKILL + b"x" * 100)], None, Settings().replace(file_bytes=50)
        )
    assert raised.value.class_ is Class.TOO_LARGE


@pytest.mark.parametrize("path", ["\ud800", "a/\udfffb"])
def test_a_name_that_is_no_utf8_is_refused(path):
    with pytest.raises(Error) as raised:
        read_fetched_skill("review", [("SKILL.md", SKILL), (path, b"x")])
    assert raised.value.class_ is Class.NON_UTF8_NAME


@pytest.mark.parametrize("path", ["", "/abs", "a//b", "../x", "a/../b", "a\\b", "x\x00y"])
def test_a_hostile_member_name_is_an_error_not_a_crash(path):
    with pytest.raises(Error):
        read_fetched_skill("review", [("SKILL.md", SKILL), (path, b"x")])


def test_a_member_listed_twice_is_refused():
    with pytest.raises(Error) as raised:
        read_fetched_skill("review", [("SKILL.md", SKILL), ("SKILL.md", SKILL)])
    assert raised.value.class_ is Class.DUPLICATE_MEMBER


def test_a_pin_that_is_no_digest_is_a_mismatch():
    with pytest.raises(Error) as raised:
        read_fetched_skill("review", [("SKILL.md", SKILL)], "not a digest")
    assert raised.value.class_ is Class.PIN_MISMATCH


def test_a_skill_without_a_skill_file_is_not_a_skill():
    with pytest.raises(Error) as raised:
        read_fetched_skill("review", [("README.md", b"x")])
    assert raised.value.class_ is Class.NOT_A_SKILL


def test_a_fetched_skill_with_tags_and_anchors_in_front_matter_is_unreadable():
    bad = b"---\nname: review\nx: &a 1\ny: *a\n---\n"
    with pytest.raises(Error) as raised:
        read_fetched_skill("review", [("SKILL.md", bad)])
    assert raised.value.class_ is Class.SKILL_UNREADABLE


def test_a_source_in_a_plan_does_not_show_credentials():
    overlays = {"a": {"skills": [{"name": "x", "source": "https://user:pw@example.org/x.git"}]}}
    plan = resolve_skills(overlays, ["a"])
    assert "pw" not in repr(plan.skills[0].source) and "user" not in plan.skills[0].source
