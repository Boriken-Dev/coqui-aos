"""What a host builds on: the setup record's JSON spelling, ``hooks_declared``, and the setting a
limit's refusal names."""

from __future__ import annotations

import pytest

from coqui_aos import (
    Class,
    Error,
    OverlayTree,
    PathFS,
    Phase,
    Settings,
    SetupRecord,
    hooks_declared,
    hooks_of,
    read_catalog_document,
    read_document,
    read_icon,
    read_overlay,
    substitute_with,
    tree_digest,
)

# --- the setup record


def test_a_phase_is_read_from_its_name():
    assert Phase.named("install") is Phase.INSTALL
    assert Phase.named("remove") is Phase.REMOVE
    assert Phase.named("Install") is None
    assert Phase.named("") is None


def test_a_record_is_written_as_digest_and_phase():
    record = SetupRecord("sha256:ab", Phase.SYNC)
    assert record.to_dict() == {"digest": "sha256:ab", "phase": "sync"}
    assert type(record.to_dict()["phase"]) is str


def test_a_record_is_read_back():
    record = SetupRecord("sha256:ab", Phase.INSTALL)
    assert SetupRecord.from_dict(record.to_dict()) == record
    assert SetupRecord.from_dict({"digest": "sha256:cd", "phase": "remove"}) == SetupRecord(
        "sha256:cd", Phase.REMOVE
    )


@pytest.mark.parametrize(
    "bad",
    [
        {"digest": "sha256:ab", "phase": "later"},
        {"digest": "sha256:ab", "phase": "Sync"},
        {"digest": "sha256:ab"},
        {"phase": "sync"},
        {"digest": 1, "phase": "sync"},
        "sync",
        None,
    ],
)
def test_a_record_that_does_not_read_is_refused(bad):
    with pytest.raises(ValueError):
        SetupRecord.from_dict(bad)


# --- hooks_declared


def tree(*paths):
    return OverlayTree(paths)


def test_an_overlay_with_no_hooks_declares_none():
    assert not hooks_declared({}, tree("SKILL.md"))
    assert not hooks_declared({"hooks": {}}, tree())
    off = {
        event: False
        for event in (
            "pre-env",
            "session-start",
            "session-end",
            "prompt",
            "turn-end",
            "cd",
            "pre-compact",
            "pre-tool",
            "post-tool",
        )
    }
    assert not hooks_declared({"hooks": off}, tree("hook.sh"))
    assert not hooks_declared({"defaults": {"hooks": False}}, tree("hook.py"))


@pytest.mark.parametrize("script", ["hook.sh", "hook.bash", "hook.ps1", "hook.py", "hook.js"])
def test_a_default_script_declares_a_hook_whatever_its_os(script):
    assert hooks_declared({}, tree(script))


def test_a_table_entry_declares_a_hook():
    assert hooks_declared({"hooks": {"pre-tool": {"run": "guard.py"}}}, tree("guard.py"))
    assert hooks_declared({"hooks": {"prompt": "guard.ps1"}}, tree("guard.ps1"))


@pytest.mark.parametrize(
    "manifest, paths",
    [
        ({}, ["hook.ps1"]),
        ({"hooks": {"cd": {"run": "x.sh"}}}, []),
        ({"hooks": {"cd": False}}, ["hook.sh"]),
    ],
)
def test_it_agrees_with_hooks_of_on_every_os(manifest, paths):
    overlay = tree(*paths)
    anywhere = False
    for os in ("windows", "linux", "macos"):
        hooks, not_run = hooks_of(manifest, overlay, os)
        anywhere = anywhere or bool(hooks or not_run)
    assert hooks_declared(manifest, overlay) is anywhere


# --- the setting a limit names


def only(error, class_, setting):
    assert error.class_ is class_, error
    assert error.setting == setting, error


def test_a_manifest_past_its_bytes():
    with pytest.raises(Error) as caught:
        read_document(b'name = "longer than eight"\n', Settings(manifest_bytes=8))
    only(caught.value, Class.TOO_LARGE, "manifest_bytes")


@pytest.mark.parametrize(
    "text",
    ["a = [[[1]]]\n", '#!json\n{"a": {"b": {"c": 1}}}\n', "#!yaml\na: [[[1]]]\n"],
)
def test_a_manifest_past_its_depth_in_every_format(text):
    with pytest.raises(Error) as caught:
        read_document(text.encode(), Settings(manifest_depth=2))
    only(caught.value, Class.TOO_DEEP, "manifest_depth")


@pytest.mark.parametrize("name", ["catalog.json", "CATALOG.aos"])
def test_a_catalog_past_its_bytes(name):
    with pytest.raises(Error) as caught:
        read_catalog_document(b" " * 64, name, Settings(catalog_bytes=8))
    only(caught.value, Class.TOO_LARGE, "catalog_bytes")


def test_a_context_body_past_its_bytes():
    overlay = OverlayTree.from_texts({"OVERLAY.md": "---\nname: x\n---\n" + "Body.\n" * 10})
    with pytest.raises(Error) as caught:
        read_overlay(overlay, Settings(context_bytes=16))
    only(caught.value, Class.TOO_LARGE, "context_bytes")


def png(width, height):
    return b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big")


@pytest.mark.parametrize(
    "limit, class_",
    [
        ("icon_bytes", Class.ICON_TOO_LARGE),
        ("icon_width", Class.ICON_DIMENSIONS),
        ("icon_height", Class.ICON_DIMENSIONS),
    ],
)
def test_an_icon_past_its_bytes_or_size(limit, class_):
    with pytest.raises(Error) as caught:
        read_icon(png(16, 16), "a.png", Settings(**{limit: 8}))
    only(caught.value, class_, limit)


@pytest.mark.parametrize(
    "limit, class_",
    [
        ("substitution_depth", Class.TOO_DEEP),
        ("substitution_bytes", Class.TOO_LARGE),
        ("substitution_steps", Class.TOO_COMPLEX),
    ],
)
def test_a_substitution_past_its_limits(limit, class_):
    text = "${U:-${V:-${W:-x}}}" if limit == "substitution_depth" else "${U:-xxxxxxxxxxxx}"
    bound = 1 if limit == "substitution_depth" else 4 if limit == "substitution_bytes" else 2
    with pytest.raises(Error) as caught:
        substitute_with(text, lambda name: None, Settings(**{limit: bound}))
    only(caught.value, class_, limit)


@pytest.mark.parametrize(
    "limit, bound",
    [("tree_files", 2), ("tree_depth", 1), ("file_bytes", 4), ("tree_bytes", 13)],
)
def test_a_tree_past_its_limits(tmp_path, limit, bound):
    for path in ("a/b/c.md", "d.md"):
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_text("twelve bytes")
    with pytest.raises(Error) as caught:
        tree_digest(PathFS(), tmp_path, Settings(**{limit: bound}))
    only(caught.value, Class.TOO_LARGE, limit)
    assert tree_digest(PathFS(), tmp_path).files


def test_a_refusal_that_is_no_limit_names_none():
    with pytest.raises(Error) as caught:
        read_document(b"a = = 1\n")
    assert caught.value.setting is None
