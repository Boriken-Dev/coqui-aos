"""knowledge.json and knowledge_search.json, and the cases beside them the vectors do not write."""

from __future__ import annotations

import json
import sys
from pathlib import PurePath

import pytest
from support import cases, decode, ids, strict

from coqui_aos import (
    CallerFacts,
    FileKind,
    KnowledgeError,
    KnowledgeOverlay,
    KnowledgeSettings,
    Metadata,
    TemplateFacts,
    TreeEntry,
    KNOWLEDGE_LACKS,
    inert,
    kb_list,
    kb_read,
    knowledge_arguments,
    knowledge_call,
    knowledge_engines,
    knowledge_lines,
    knowledge_plan,
    knowledge_result,
    knowledge_set,
    knowledge_tools,
    envsubst,
    mustache,
    search_check,
    search_order,
)

KNOWLEDGE = cases("knowledge.json")
ENGINES = ("envsubst", "mustache")
LACKED = KNOWLEDGE_LACKS  # what this server cannot honour
KNOWLEDGE_SEARCH = cases("knowledge_search.json")


def settings_of(case):
    return KnowledgeSettings(**case.get("limits", {}))


def entry_of(item):
    kind = item.get("type", "file")
    if kind == "symlink":
        return TreeEntry.symlink()
    if kind == "special":
        return TreeEntry.special()
    if kind == "dir":
        return TreeEntry.directory()
    data = decode(item["base64"]) if "base64" in item else item.get("text", "").encode("utf-8")
    return TreeEntry.file(data)


def overlay_of(raw):
    facts = dict(raw["facts"])
    options = facts.pop("options", {})
    return KnowledgeOverlay(
        raw["identity"],
        raw["manifest"],
        {item["path"]: entry_of(item) for item in raw["tree"]},
        raw["served"],
        TemplateFacts(options=options, **facts),
    )


def caller_of(facts):
    facts = facts or {}
    caller = facts.get("caller", {})
    return CallerFacts(
        caller.get("role"), caller.get("profile"), facts.get("env", {}), facts.get("env_allow", [])
    )


def engines_of(case):
    return list(case.get("engines", ENGINES)) + ["-" + lacked for lacked in case.get("lacks", [])]


def not_run(case):
    """Whether the case needs an option value this server lacks and does not say it lacks it: the
    case is then not run (`test_the_cases_needing_a_lacked_option_are_named` names them)."""
    return not case.get("lacks") and any(need in LACKED for need in case.get("needs", []))


# Cases the Mustache engine behind the `templates` extra (tplx's MustacheTemplate over chevron) does not
# meet, each named with what differs. `test_the_engine_gaps_still_differ` runs them and fails once one
# is met, so the entry is dropped.
ENGINE_GAPS = {
    "mustache-dotted-context-precedence": "a dotted name falls back to an outer context for its later parts",
    "mustache-delimiters-bad": "a delimiter tag with one word (`{{=<%=}}`) is accepted, not refused",
    "mustache-partial-reaches-the-root": "a partial name with `..` is refused by the loader, so it renders as nothing",
    "mustache-partial-endless-recursion-is-a-limit": "partial nesting has no depth limit, so a template-error is raised and not include-error",
}


def test_the_cases_needing_a_lacked_option_are_named():
    named = sorted(c["id"] for c in KNOWLEDGE if not_run(c))
    assert named, "no case needs an option this server lacks"
    assert all("escape=none" in json.dumps(c["needs"]) for c in KNOWLEDGE if not_run(c))


def outcome_of(case):
    out = knowledge_call(
        case["tool"],
        [overlay_of(raw) for raw in case["overlays"]],
        case["arguments"],
        case.get("modes", []),
        settings_of(case),
        caller_of(case.get("facts")),
        engines_of(case),
    )
    return {"error": out["error"]["class"]} if "error" in out else {"result": out["result"]}


@pytest.mark.parametrize("case", [c for c in KNOWLEDGE if c["id"] in ENGINE_GAPS], ids=lambda c: c["id"])
def test_the_engine_gaps_still_differ(case):
    assert strict(json.loads(json.dumps(outcome_of(case)))) != strict(case["expect"])


@pytest.mark.parametrize(
    "case", [c for c in KNOWLEDGE if c["id"] not in ENGINE_GAPS and not not_run(c)], ids=lambda c: c["id"]
)
def test_knowledge(case):
    limits = settings_of(case)
    if case["id"].startswith("tools-"):
        got = {"tools": knowledge_tools(case["modes"], limits)}
    elif case.get("kind") == "arguments":
        try:
            got = {"arguments": knowledge_arguments(case["tool"], case["arguments"], case["modes"], limits)}
        except KnowledgeError as error:
            got = {"error": error.code}
    elif "outcome" in case:
        result = knowledge_result(case["outcome"])
        assert json.loads(result["content"][0]["text"]) == result["structuredContent"]
        got = {"structuredContent": result["structuredContent"], "isError": result["isError"]}
    elif "manifest" in case and "files" in case:
        plan = knowledge_plan(case["manifest"], case["files"], case.get("user"))
        got = {"served": plan.served, "left_out": plan.left_out}
    else:
        got = outcome_of(case)
    assert strict(json.loads(json.dumps(got))) == strict(case["expect"])


@pytest.mark.parametrize("case", KNOWLEDGE_SEARCH, ids=ids(KNOWLEDGE_SEARCH))
def test_knowledge_search(case):
    if case["id"].startswith("order-"):
        got = {"order": search_order(case["passages"])}
    else:
        got = {
            "violations": search_check(
                [overlay_of(raw) for raw in case["overlays"]],
                case["arguments"],
                case["response"],
                case["modes"],
                settings_of(case),
                caller_of(case.get("facts")),
                engines_of(case),
            )
        }
    assert strict(json.loads(json.dumps(got))) == strict(case["expect"])


def one(files, manifest=None, **extra):
    return KnowledgeOverlay(
        "team",
        manifest or {},
        {path: TreeEntry.file(text.encode("utf-8")) for path, text in files.items()},
        **extra,
    )


def test_kb_read_renders_a_template_from_the_callers_facts():
    overlay = one(
        {"kb/t.md": "#!mustache\n{{caller.role}} {{context.topic}} {{env.USER}}\n"},
        facts=TemplateFacts(name="team"),
    )
    result = kb_read(
        [overlay],
        "kb/t.md",
        context={"topic": "cache"},
        caller=CallerFacts("reviewer", None, {"USER": "ana", "PATH": "/bin"}, ["USER", "PATH"]),
    )
    assert result["isError"] is False
    assert result["structuredContent"]["text"] == "reviewer cache ana"
    assert result["structuredContent"]["template"] == "mustache"
    assert result["structuredContent"]["rendered"] is True
    assert json.loads(result["content"][0]["text"]) == result["structuredContent"]


def test_kb_read_a_plain_file_ignores_the_context_and_range_applies():
    overlay = one({"kb/a.md": "one\ntwo\nthree\n"})
    result = kb_read([overlay], "kb/a.md", from_line=2, to_line=2, context={"a": 1})
    assert result["structuredContent"]["text"] == "two"
    refused = kb_read([overlay], "kb/a.md", from_line=4)
    assert refused["isError"] and refused["structuredContent"]["error"]["class"] == "line-range"


def test_kb_list_answers_as_an_mcp_result():
    result = kb_list([one({"kb/a.md": "x\n"})], modes=["words"])
    assert result["structuredContent"]["search"] == {"modes": ["words"]}


def test_a_context_key_with_a_trailing_line_feed_is_refused():
    with pytest.raises(KnowledgeError):
        knowledge_arguments("kb_read", {"path": "a", "context": {"a\n": 1}}, [])


def test_the_hiding_characters_of_the_spec_are_written_out():
    assert inert("a⁡b⁤c⁥d") == "a<U+2061>b<U+2064>c⁥d"


def test_lines_drop_a_carriage_return_only_before_a_line_feed():
    assert knowledge_lines("a\r\nb\r") == ["a", "b\r"]
    assert knowledge_lines("") == []


def test_without_the_extra_nothing_is_rendered_and_the_file_carries_its_context(monkeypatch):
    monkeypatch.setitem(sys.modules, "tplx", None)
    assert knowledge_engines() == []
    for render in (lambda: mustache("{{a}}", {"a": 1}), lambda: envsubst("$a", {"a": "1"})):
        with pytest.raises(KnowledgeError) as raised:
            render()
        assert raised.value.code == "template-error"
        assert "templates" in raised.value.message
    overlay = one({"kb/t.md": "#!mustache\nHi {{a}}\n"}, facts=TemplateFacts(name="team"))
    got = kb_read([overlay], "kb/t.md", context={"a": 1})["structuredContent"]
    assert got["rendered"] is False and got["template"] == "mustache"
    assert got["text"].startswith('#!mustache\n---\naos_template_context: {"engine": "mustache"')
    assert got["text"].endswith("---\nHi {{a}}")
    assert kb_list([overlay])["structuredContent"]["engines"] == []


def test_the_format_line_options_are_read_and_a_bad_value_is_a_template_error():
    overlay = one(
        {
            "kb/a.md": "#!/usr/bin/env -S envsubst undefined=strict\n$NOPE\n",
            "kb/b.md": "#!envsubst dialect=posix\nx\n",
            "kb/c.md": "#!envsubst colour=blue\n${HOME} $NOPE\n",
        },
        facts=TemplateFacts(name="team"),
    )
    assert kb_read([overlay], "kb/a.md")["structuredContent"]["error"]["class"] == "template-error"
    assert kb_read([overlay], "kb/b.md")["structuredContent"]["error"]["class"] == "template-error"
    assert kb_read([overlay], "kb/c.md")["structuredContent"]["text"] == "${HOME} $NOPE"
    skipped = kb_list([overlay])["structuredContent"]["overlays"][0]["skipped"]
    assert skipped == [{"path": "kb/a.md", "reason": "render"}, {"path": "kb/b.md", "reason": "render"}]


def test_a_file_expands_by_default_and_a_raw_file_is_not_touched():
    overlay = one(
        {
            "kb/a.md": "name ${AOS_OVERLAY_NAME} `${AOS_OVERLAY_NAME}`\n@part.md\n",
            "kb/part.md": "part\n",
            "kb/r.md": "#!raw\n${AOS_OVERLAY_NAME} @part.md\n",
            "kb/p.txt": "#!raw\n${AOS_OVERLAY_NAME}\n",
        },
        {"context": ["kb/p.txt"]},
        facts=TemplateFacts(name="team"),
    )
    assert (
        kb_read([overlay], "kb/a.md")["structuredContent"]["text"] == "name team `${AOS_OVERLAY_NAME}`\npart"
    )
    assert kb_read([overlay], "kb/r.md")["structuredContent"]["text"] == "${AOS_OVERLAY_NAME} @part.md"
    assert kb_read([overlay], "kb/p.txt")["structuredContent"]["text"] == "#!raw\n${AOS_OVERLAY_NAME}"


def test_a_cycle_of_includes_is_an_include_error_and_the_files_are_skipped_in_the_list():
    overlay = one({"kb/a.md": "@b.md\n", "kb/b.md": "@a.md\n"})
    assert kb_read([overlay], "kb/a.md")["structuredContent"]["error"]["class"] == "include-error"
    listed = kb_list([overlay])["structuredContent"]["overlays"][0]
    assert listed["skipped"] == [
        {"path": "kb/a.md", "reason": "render"},
        {"path": "kb/b.md", "reason": "render"},
    ]


def test_settings_report_what_differs_from_the_default():
    assert KnowledgeSettings().non_defaults() == []
    assert [item.setting for item in KnowledgeSettings(max_top=None).non_defaults()] == ["max_top"]


class MemoryFS:
    def __init__(self, tree):
        self.tree = tree

    def metadata(self, path):
        kind, data = self.tree[PurePath(path).as_posix()]
        return Metadata(kind, len(data))

    def read(self, path, limit):
        return self.tree[PurePath(path).as_posix()][1][:limit]

    def list(self, path):
        prefix = PurePath(path).as_posix().rstrip("/") + "/"
        return sorted({key[len(prefix) :].split("/")[0] for key in self.tree if key.startswith(prefix)})


def test_an_overlay_is_built_from_a_filesystem_without_following_a_link():
    fs = MemoryFS(
        {
            "/o/kb": (FileKind.DIRECTORY, b""),
            "/o/kb/a.md": (FileKind.FILE, b"hello\n"),
            "/o/kb/link": (FileKind.SYMLINK, b""),
            "/o/bin": (FileKind.DIRECTORY, b""),
            "/o/bin/run": (FileKind.FILE, b"secret"),
        }
    )
    overlay = KnowledgeOverlay.from_filesystem(fs, PurePath("/o"), "team", {})
    assert overlay.tree["kb/link"].kind.value == "symlink"
    assert overlay.tree["bin/run"].data == b""
    assert list(knowledge_set(overlay).files) == ["kb/a.md"]
    assert kb_read([overlay], "kb/link")["structuredContent"]["error"]["class"] == "link"
    assert kb_read([overlay], "bin/run")["structuredContent"]["error"]["class"] == "not-found"
