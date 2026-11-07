"""``hooks.json`` through the hooks module, and the hostile output the vectors do not write."""

from __future__ import annotations

import json
from typing import Any, Dict

import pytest

from coqui_aos import (
    Decision,
    HookError,
    HookEvent,
    HookFacts,
    HookFailure,
    HookRun,
    HookScope,
    OnFailure,
    OverlayTree,
    Settings,
    fire_event,
    hook_matches,
    hook_payload,
    hook_plan,
    hook_result,
    read_hook_output,
    read_overlay,
    to_data,
    validate,
)
from support import cases, decode, ids, repeated

HOOKS = cases("hooks.json")


def settings_of(limits: "Dict[str, Any]") -> Settings:
    names = {
        "timeout": "hook_timeout",
        "event_timeout": "hook_event_timeout",
        "max_output": "hook_output_bytes",
        "max_payload": "hook_payload_bytes",
    }
    return Settings().replace(**{names[key]: value for key, value in limits.items() if key in names})


def run_of(value: "Dict[str, Any]") -> HookRun:
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


def hook_json(hook: Any) -> "Dict[str, Any]":
    return {
        "event": hook.event.value,
        "path": hook.path,
        "interpreter": hook.interpreter,
        "runs": hook.runs,
        "match": None if hook.match is None else list(hook.match),
        "sets": list(hook.sets),
        "timeout": hook.timeout,
        "on_failure": hook.on_failure.value,
        "payload": list(hook.payload),
    }


def plan_case(case: "Dict[str, Any]") -> "Dict[str, Any]":
    facts = case["facts"]
    files = facts["files"]
    if isinstance(files, dict):
        tree = OverlayTree.from_texts(files)
    else:
        tree = OverlayTree(files)
    settings = settings_of(facts.get("limits", {}))
    if "manifest" in case:
        manifest = case["manifest"]
    else:
        manifest = read_overlay(tree, Settings()).manifest
    known = HookFacts(
        os=facts["os"],
        identity=facts.get("identity", ""),
        interpreters=facts.get("interpreters"),
        scope=HookScope(facts.get("scope", "overlay")),
        digest=facts.get("digest"),
        allowed=facts.get("allowed"),
        tree=None if "tree" not in facts else {p: t.encode("utf-8") for p, t in facts["tree"].items()},
        fires=None if "fires" not in facts else [HookEvent(e) for e in facts["fires"]],
        partial=[HookEvent(e) for e in facts.get("partial", [])],
        timeout=facts.get("limits", {}).get("timeout"),
    )
    plan = hook_plan(manifest, tree, known, settings)
    got = {
        "hooks": [hook_json(hook) for hook in plan.hooks],
        "on": plan.on,
        "activates": plan.activates,
        "needs": list(plan.needs),
        "reports": [list(pair) for pair in plan.reports],
        "non_defaults": [list(pair) for pair in plan.non_defaults],
    }
    if "issues" in case["expect"]:
        got["issues"] = [issue.at for issue in validate(manifest, tree)]
    return got


def output_json(output: Any) -> "Dict[str, Any]":
    got: "Dict[str, Any]" = {}
    if output.decision is not None:
        got["decision"] = output.decision.value
    if output.reason is not None:
        got["reason"] = output.reason
    if output.context is not None:
        got["context"] = output.context
    if output.env is not None:
        got["env"] = dict(output.env)
    return got


def fired_json(fired: Any) -> "Dict[str, Any]":
    return {
        "ran": fired.ran,
        "decision": None if fired.decision is None else fired.decision.value,
        "by": fired.by,
        "reason": fired.reason,
        "context": [list(pair) for pair in fired.context],
        "env": dict(fired.env),
        "reports": [[report.id, *report.about] for report in fired.reports],
        "non_defaults": [list(pair) for pair in fired.non_defaults],
    }


@pytest.mark.parametrize("case", HOOKS, ids=ids(HOOKS))
def test_hooks_vectors(case):
    kind = case["id"].split("-", 1)[0]
    if kind == "plan":
        got = plan_case(case)
    elif kind == "payload":
        got = hook_payload(HookEvent(case["event"]), case["known"])
    elif kind == "output":
        try:
            got = {
                "output": output_json(
                    hook_result(
                        HookEvent(case["event"]), run_of(case["run"]), settings_of(case.get("limits", {}))
                    )
                )
            }
        except HookError as failure:
            got = {"failed": failure.failure.value}
    elif kind == "match":
        got = {"runs": hook_matches(HookEvent(case["event"]), case["match"], case["value"])}
    else:
        fired = fire_event(
            HookEvent(case["event"]),
            [run_of(run) for run in case["runs"]],
            case.get("applies"),
            settings_of(case.get("limits", {})),
            case.get("os") == "windows",
        )
        got = fired_json(fired)
    assert json.loads(json.dumps(to_data(got))) == case["expect"]


def test_every_hooks_case_is_a_known_kind():
    assert {case["id"].split("-", 1)[0] for case in HOOKS} <= {"plan", "payload", "output", "match", "event"}


# Output the vectors do not write.


def failure_of(event: HookEvent, run: HookRun, settings: "Settings | None" = None) -> HookFailure:
    with pytest.raises(HookError) as raised:
        hook_result(event, run, settings or Settings())
    return raised.value.failure


def test_a_64_mib_stdout_is_refused_by_size_before_it_is_read():
    run = HookRun("o", stdout=b"x" * (64 * 1024 * 1024))
    assert failure_of(HookEvent.PROMPT, run) is HookFailure.TOO_LARGE


def test_a_64_mib_stdout_with_the_bound_lifted_is_not_json():
    run = HookRun("o", stdout=b"x" * (64 * 1024 * 1024))
    settings = Settings().replace(hook_output_bytes=None)
    assert failure_of(HookEvent.PROMPT, run, settings) is HookFailure.OUTPUT


def test_deeply_nested_json_is_an_output_failure_not_a_crash():
    deep = b'{"context": ' + b"[" * 200_000 + b"]" * 200_000 + b"}"
    settings = Settings().replace(hook_output_bytes=None)
    assert failure_of(HookEvent.PROMPT, HookRun("o", stdout=deep), settings) is HookFailure.OUTPUT


def test_nesting_is_refused_even_when_the_depth_bound_is_lifted():
    deep = b"[" * 100_000 + b"]" * 100_000
    settings = Settings().replace(hook_output_bytes=None, manifest_depth=None)
    assert failure_of(HookEvent.PROMPT, HookRun("o", stdout=deep), settings) is HookFailure.OUTPUT


def test_a_huge_integer_is_an_output_failure():
    data = b'{"context": ' + b"9" * 5000 + b"}"
    assert failure_of(HookEvent.PROMPT, HookRun("o", stdout=data)) is HookFailure.OUTPUT


@pytest.mark.parametrize(
    "text",
    [
        "a\x00b",
        "a\x1bb",
        "a\x7fb",
        "a\x85b",
        "a‮b",
        "a⁦b",
        "a⁩b",
    ],
)
def test_context_with_controls_or_bidi_marks_is_refused(text):
    data = json.dumps({"context": text}).encode("utf-8")
    assert failure_of(HookEvent.PROMPT, HookRun("o", stdout=data)) is HookFailure.OUTPUT


def test_context_with_tab_newline_and_carriage_return_is_kept():
    data = json.dumps({"context": "a\tb\nc\rd"}).encode("utf-8")
    assert read_hook_output(HookEvent.PROMPT, data).context == "a\tb\nc\rd"


def test_a_reason_past_its_bound_is_refused():
    data = json.dumps({"decision": "block", "reason": "x" * 1025}).encode("utf-8")
    assert failure_of(HookEvent.PROMPT, HookRun("o", stdout=data)) is HookFailure.OUTPUT
    ok = json.dumps({"decision": "block", "reason": "x" * 1024}).encode("utf-8")
    assert read_hook_output(HookEvent.PROMPT, ok).reason == "x" * 1024


def test_a_payload_past_its_bound_fails_before_the_output_is_looked_at():
    run = HookRun("o", stdout=b"not json", payload_size=1024 * 1024 + 1, exit=1)
    assert failure_of(HookEvent.PROMPT, run) is HookFailure.PAYLOAD_TOO_LARGE
    assert (
        failure_of(HookEvent.PROMPT, HookRun("o", payload_size=11), Settings().replace(hook_payload_bytes=10))
        is HookFailure.PAYLOAD_TOO_LARGE
    )


def test_a_duplicate_key_in_the_output_is_refused():
    assert (
        failure_of(HookEvent.PROMPT, HookRun("o", stdout=b'{"context": "a", "context": "b"}'))
        is HookFailure.OUTPUT
    )


def test_an_env_name_set_under_two_cases_is_refused():
    data = b'{"env": {"A": "1", "a": "2"}}'
    run = HookRun("o", stdout=data, sets=("A", "a"))
    assert failure_of(HookEvent.SESSION_START, run) is HookFailure.OUTPUT


def test_a_reserved_variable_is_refused_even_when_declared():
    run = HookRun("o", stdout=b'{"env": {"AOS_X": "1"}}', sets=("AOS_X",))
    assert failure_of(HookEvent.SESSION_START, run) is HookFailure.OUTPUT


def test_a_decision_the_event_does_not_take_is_a_grant_attempt():
    run = HookRun("o", stdout=b'{"decision": "ask"}')
    assert failure_of(HookEvent.PROMPT, run) is HookFailure.GRANT
    assert failure_of(HookEvent.PRE_TOOL, HookRun("o", stdout=b'{"decision": "allow"}')) is HookFailure.GRANT


# What a repr shows.


SECRET = "s3cr3t-text"


def test_repr_of_a_run_never_shows_its_output():
    run = HookRun("o", stdout=SECRET.encode())
    assert SECRET not in repr(run) and SECRET not in str(run)


def test_repr_of_an_output_never_shows_its_text_or_values():
    data = json.dumps({"context": SECRET, "decision": "block", "reason": SECRET}).encode()
    output = read_hook_output(HookEvent.PROMPT, data)
    assert output.decision is Decision.BLOCK
    assert SECRET not in repr(output) and SECRET not in str(output)
    env = read_hook_output(HookEvent.SESSION_START, json.dumps({"env": {"A": SECRET}}).encode(), ["A"])
    assert SECRET not in repr(env)


def test_repr_of_a_fired_event_never_shows_context_or_env():
    data = json.dumps({"context": SECRET, "env": {"A": SECRET}}).encode()
    run = HookRun("o", stdout=data, sets=("A",))
    fired = fire_event(HookEvent.SESSION_START, [run])
    assert fired.env == {"A": SECRET}
    assert SECRET not in repr(fired) and SECRET not in str(fired)
    assert SECRET not in repr(fired.reports)


def test_a_run_of_seconds_far_past_the_bound_ends_the_event():
    runs = [HookRun("a", seconds=10**30), HookRun("b")]
    fired = fire_event(HookEvent.SESSION_START, runs)
    assert fired.ran == ["a", "b"][:1]
    assert [report.about[2] for report in fired.reports] == ["event-timeout"]
