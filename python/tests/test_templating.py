"""templating.json, and the cases beside it the vectors do not write."""

from __future__ import annotations

import pytest
from support import bytes_of, cases, ids

from coqui_aos import Class, Error, TemplateFacts, context_text, skill_text, template, template_values

TEMPLATING = cases("templating.json")


def facts_of(case):
    facts = dict(case["facts"])
    options = facts.pop("options", {})
    return TemplateFacts(options=options, **facts)


@pytest.mark.parametrize("case", TEMPLATING, ids=ids(TEMPLATING))
def test_templating(case):
    serve = {"context": context_text, "skill": skill_text}[case["kind"]]
    expect = case["expect"]
    data = bytes_of(case)
    if "error" in expect:
        with pytest.raises(Error) as raised:
            serve(data, template_values(case.get("manifest", {}), facts_of(case)))
        assert raised.value.class_ == Class(expect["error"])
    else:
        values = template_values(case.get("manifest", {}), facts_of(case))
        assert serve(data, values) == expect["text"]


MANIFEST = {
    "options": {
        "depth": {"type": "string", "default": "normal"},
        "token": {"type": "string", "sensitive": True},
    }
}


def test_a_sensitive_option_stays_as_written_with_a_configured_value():
    facts = TemplateFacts(root="/o/team", options={"token": "s3cret", "depth": "deep"})
    values = template_values(MANIFEST, facts)
    assert "token" not in values
    assert template("${token} ${depth} ${AOS_OVERLAY_ROOT}", values) == "${token} deep /o/team"


def test_a_wrong_typed_value_is_refused():
    with pytest.raises(Error) as raised:
        template_values(MANIFEST, TemplateFacts(options={"depth": 3}))
    assert raised.value.class_ is Class.INVALID_OPTION
    assert raised.value.subject == "depth"


def test_context_drops_front_matter_and_a_skill_keeps_it():
    values = template_values(MANIFEST, TemplateFacts(root="/o/team", name="team"))
    file = b"---\nk: ${AOS_OVERLAY_NAME}\n---\nroot ${AOS_OVERLAY_ROOT}\n"
    assert context_text(file, values) == "root /o/team\n"
    assert skill_text(file, values) == "---\nk: ${AOS_OVERLAY_NAME}\n---\nroot /o/team\n"
