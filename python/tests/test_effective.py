"""effective.json through ``effective`` and ``preparation``, and the package environments."""

from __future__ import annotations

from typing import Any, Dict, Optional

import pytest
from support import cases, ids

from coqui_aos import (
    Change,
    Class,
    Effective,
    Error,
    Facts,
    FailStep,
    OverlayTree,
    Phase,
    SetupRecord,
    effective,
    preparation,
    setup_phase,
    to_data,
)

EFFECTIVE = cases("effective.json")


def facts_of(raw: "Dict[str, Any]") -> Facts:
    facts = Facts(
        os=raw["os"],
        root=raw.get("root", ""),
        identity=raw.get("identity", ""),
        state=raw.get("state"),
        pinned=raw.get("pinned", False),
        base_env=raw.get("base_env", {}),
        host_env=raw.get("host_env", {}),
        grants=raw.get("grants", {}),
        secrets=raw.get("secrets", {}),
        secret_files=raw.get("secret_files"),
        providers=raw.get("providers"),
        provider_values=raw.get("provider_values", {}),
        enforces_network=raw.get("enforces_network"),
        env_scripts_enabled=raw.get("env_scripts_enabled"),
        interpreters=raw.get("interpreters"),
        packages=raw.get("packages", {}),
    )
    facts.tree = OverlayTree.from_texts(raw.get("files") or {})
    return facts


def result_data(result: Effective) -> "Dict[str, Any]":
    return {
        "ungranted": result.ungranted,
        "supported": result.supported,
        "env": result.env.values(),
        "env_scripts": to_data(result.env_scripts),
        "setup": to_data(result.setup),
        "python": result.python,
        "node": result.node,
        "dependencies": to_data(result.dependencies),
        "needs": {"interpreters": result.needs.interpreters, "commands": result.needs.commands},
        "non_defaults": [[w.id.value, w.subject] for w in result.non_defaults],
    }


def record_of(raw: "Optional[Dict[str, Any]]") -> "Optional[SetupRecord]":
    return SetupRecord(raw["digest"], Phase(raw["phase"])) if isinstance(raw, dict) else None


@pytest.mark.parametrize("case", EFFECTIVE, ids=ids(EFFECTIVE))
def test_effective(case):
    raw = case["facts"]
    try:
        result = effective(case["manifest"], facts_of(raw))
    except Error as refusal:
        got: "Dict[str, Any]" = {"error": refusal.class_.value, "subject": refusal.subject}
    else:
        got = result_data(result)
        if "change" in raw:
            prepared = preparation(
                Change(raw["change"]),
                record_of(raw.get("record")),
                raw.get("digest"),
                result.setup,
                result.dependencies,
                FailStep.named(raw["fails"]) if raw.get("fails") else None,
            )
            got["setup_phase"] = prepared.phase.value if prepared.phase else None
            got["setup_arguments"] = prepared.arguments
            got["steps"] = [str(step) for step in prepared.steps]
            got["record"] = to_data(prepared.record)
            got["activates"] = prepared.activates
    assert got == case["expect"]


def test_every_effective_case_ran():
    assert len(EFFECTIVE) == 106


def test_setup_phase_follows_the_change():
    assert setup_phase(Change.ADD, None, "sha256:a") is Phase.INSTALL
    assert setup_phase(Change.SYNC, "sha256:a", "sha256:a") is Phase.SYNC
    assert setup_phase(Change.ACTIVATE, "sha256:a", "sha256:A") is None
    assert setup_phase(Change.ACTIVATE, "sha256:a", "sha256:b") is Phase.SYNC
    assert setup_phase(Change.REMOVE, None, None) is None
    assert setup_phase(Change.REMOVE, "sha256:a", None) is Phase.REMOVE


def test_facts_repr_hides_secrets():
    facts = Facts(
        os="linux", secrets={"token": "hunter2"}, host_env={"K": "hunter3"}, base_env={"B": "hunter4"}
    )
    text = repr(facts)
    assert "hunter" not in text


def test_a_secret_never_reaches_a_repr_or_a_placeholder():
    facts = Facts(
        os="linux",
        root="/r",
        identity="x",
        secrets={"api": "hunter2"},
        grants={"secret": ["api"]},
    )
    manifest = {"env": {"KEY": {"secret": "api"}}}
    result = effective(manifest, facts)
    assert result.env.is_secret("KEY")
    assert "hunter2" not in repr(result.env)
    leaking = {"env_files": [{"path": "a.toml"}, {"path": "b.env", "format": "dotenv"}]}
    facts.tree = OverlayTree.from_texts({"a.toml": '[KEY]\nsecret = "api"\n', "b.env": "COPY=${KEY}\n"})
    with pytest.raises(Error) as raised:
        effective(leaking, facts)
    assert raised.value.class_ is Class.SECRET_PLACEHOLDER
    assert "hunter2" not in str(raised.value)
