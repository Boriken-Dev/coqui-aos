"""compose.json: resolution, composition order, contributions and the composed environment."""

from __future__ import annotations

import time
from typing import Any, Dict

import pytest
from support import cases, decode, ids, repeated, strict

from coqui_aos import (
    Class,
    Cycle,
    Environment,
    Error,
    Facts,
    HookRun,
    OnFailure,
    OverlayTree,
    compose,
    composed_environment,
    composition_order,
    environments,
    resolve,
    to_data,
)

COMPOSE = cases("compose.json")


def trees_of(case: "Dict[str, Any]") -> "Dict[str, OverlayTree]":
    out = {}
    for identity, files in case.get("files", {}).items():
        out[identity] = OverlayTree(files) if isinstance(files, list) else OverlayTree.from_texts(files)
    return out


def hook_run(value: "Dict[str, Any]") -> HookRun:
    if "stdout_base64" in value:
        stdout = decode(value["stdout_base64"])
    elif "stdout_parts" in value:
        stdout = repeated(value["stdout_parts"])
    else:
        stdout = value.get("stdout", "").encode("utf-8")
    return HookRun(
        source=value.get("source", ""),
        stdout=stdout,
        on_failure=OnFailure.REFUSE if value.get("on_failure") == "refuse" else OnFailure.REPORT,
        seconds=value.get("seconds", 0),
        not_run=value.get("not_run", False),
        payload_size=value.get("payload_size", 0),
        timed_out=value.get("timed_out", False),
        exit=value.get("exit", 0),
        sets=tuple(value.get("sets", ())),
    )


def facts_of(raw: "Dict[str, Any]", identity: str, root: str, tree: OverlayTree) -> Facts:
    return Facts(
        os=raw["os"],
        root=root,
        identity=identity,
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
        packages=raw.get("packages", {}).get(identity, {}),
        tree=tree,
    )


def composed(case: "Dict[str, Any]") -> "Dict[str, Any]":
    overlays = case["overlays"]
    trees = trees_of(case)
    try:
        composition = compose(overlays, case["requested"], trees)
    except Cycle as cycle:
        return {"error": "cycle", "chain": cycle.chain}
    facts = case.get("facts")
    if facts is None:
        return to_data(composition)
    got: "Dict[str, Any]" = {}
    expect = case["expect"]
    try:
        installed = environments(overlays, composition.active, trees, facts["os"], facts.get("removed", []))
    except Error as lock:
        return {"active": composition.active, "env": {"error": lock.class_.value, "subject": lock.subject}}
    active = [identity for identity in composition.active if identity not in installed.blocked]
    got["active"] = active
    data = to_data(installed)
    for key in ("environments", "conflicts", "blocked", "left"):
        if key in expect:
            got[key] = data[key]
    empty = OverlayTree()
    per = [
        (overlays[identity], facts_of(facts, identity, facts["roots"][identity], trees.get(identity, empty)))
        for identity in active
    ]
    base = Environment(facts.get("base_env", {}), facts["os"] == "windows")
    pre_env = {identity: hook_run(run) for identity, run in facts.get("pre_env", {}).items()}
    result = composed_environment(per, base, pre_env, [])
    if result.error is not None:
        got["env"] = {"error": result.error.class_.value, "subject": result.error.subject}
    else:
        got["env"] = result.env.values()
    if "pre_env" in facts:
        got["hook_reports"] = [[report.id, *report.about] for report in result.hook_reports]
        got["hook_non_defaults"] = [list(pair) for pair in result.hook_non_defaults]
    return got


@pytest.mark.parametrize("case", COMPOSE, ids=ids(COMPOSE))
def test_compose_vectors(case):
    assert strict(to_data(composed(case))) == strict(case["expect"])


# Behaviour no vector states.


def chain(n: int, loop: bool) -> "Dict[str, Dict[str, Any]]":
    overlays = {"o%d" % i: {"requires": ["o%d" % (i + 1)]} for i in range(n - 1)}
    overlays["o%d" % (n - 1)] = {"requires": ["o0"]} if loop else {}
    return overlays


def test_a_long_requires_chain_resolves_without_recursion():
    started = time.monotonic()
    out = resolve(chain(50000, False), ["o0"])
    assert out.install_order[0] == "o49999" and out.install_order[-1] == "o0"
    assert time.monotonic() - started < 30


def test_a_long_requires_cycle_names_every_overlay_once_and_closes_on_the_first():
    with pytest.raises(Cycle) as raised:
        resolve(chain(50000, True), ["o0"])
    assert len(raised.value.chain) == 50001
    assert raised.value.chain[0] == raised.value.chain[-1] == "o0"


def test_a_cycle_through_compose_is_the_same_refusal():
    with pytest.raises(Cycle):
        compose({"a": {"requires": ["a"]}}, ["a"])


def test_a_requirement_that_is_not_text_is_ignored():
    out = resolve({"a": {"requires": [1, None, ["b"], "b"]}, "b": {}}, ["a"])
    assert out.install_order == ["b", "a"] and out.missing == []


def test_a_hostile_priority_and_name_fall_back_to_the_defaults():
    overlays = {"a": {"priority": True, "name": ""}, "b": {"priority": 1.5, "name": 7}, "c": {"priority": 10}}
    assert composition_order(overlays, ["a", "b", "c"]) == ["c", "a", "b"]


def test_a_missing_overlay_is_reported_with_its_requester():
    assert resolve({"a": {"requires": ["Gone"]}}, ["a"]).missing == [("a", "gone")]


def test_a_guard_hook_that_refuses_names_the_overlay_and_keeps_its_report():
    manifest = {}
    facts = Facts(os="linux", root="/r", identity="g")
    run = HookRun(source="g", exit=3, on_failure=OnFailure.REFUSE)
    result = composed_environment([(manifest, facts)], Environment({}, False), {"g": run}, [])
    assert result.env is None and result.error.class_ is Class.HOOK_REFUSED and result.error.subject == "g"
    assert [report.id for report in result.hook_reports] == ["hook-failed"]
