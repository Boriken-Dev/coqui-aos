"""What an overlay's files contribute by default, its dependency files, and the package environments."""

from __future__ import annotations

import time

import pytest

from coqui_aos import (
    Class,
    Dependency,
    Environment,
    Error,
    Facts,
    LeftState,
    OverlayTree,
    PartialLock,
    Runtime,
    Settings,
    SkillOrigin,
    bundled_skills,
    check_requirements,
    context_ignored,
    context_of,
    default_on,
    default_paths,
    dependencies_of,
    effective,
    env_files_of,
    environments,
    harness_context_of,
    paths_of,
    read_dotenv,
    rules_of,
    skill_entries,
    skills_of,
    to_data,
)


def tree(*paths: str, **texts: str) -> OverlayTree:
    return OverlayTree.from_texts({**{p: "" for p in paths}, **texts})


def test_defaults_are_on_unless_written_false():
    assert default_on({}, "bin")
    assert default_on({"defaults": {"bin": True}}, "bin")
    assert not default_on({"defaults": {"bin": False}}, "bin")
    assert default_on({"defaults": "no"}, "bin")


def test_bin_and_lib_default_to_path_additions_when_present():
    files = tree("bin/tool", "lib/python/x.py", "lib/node/y.js")
    assert default_paths({}, files) == [
        {"variable": "PATH", "path": "bin"},
        {"variable": "PYTHONPATH", "path": "lib/python"},
        {"variable": "NODE_PATH", "path": "lib/node"},
    ]
    assert default_paths({"defaults": {"lib": False}}, files) == [{"variable": "PATH", "path": "bin"}]
    declared = {"paths": [{"variable": "PATH", "path": "bin", "position": "append"}]}
    assert default_paths(declared, files)[0]["variable"] == "PYTHONPATH"
    assert paths_of(declared, tree("bin/x"))[-1]["position"] == "append"


def test_an_excluded_name_does_not_make_a_directory_present():
    assert default_paths({}, tree("bin/__pycache__/x.pyc")) == []


def test_rules_are_the_files_directly_in_rules_by_byte_order_then_declared():
    files = tree("rules/b.md", "rules/a.md", "rules/sub/c.md", "rules/n.txt", "rules/Z.md")
    assert rules_of({}, files) == ["rules/Z.md", "rules/a.md", "rules/b.md"]
    assert rules_of({"rules": ["rules/a.md", "extra.md"]}, files) == [
        "rules/Z.md",
        "rules/b.md",
        "rules/a.md",
        "extra.md",
    ]
    assert rules_of({"defaults": {"rules": False}}, files) == []


def test_a_body_is_the_context_and_context_md_then_is_ignored():
    files = tree("CONTEXT.md", **{"OVERLAY.md": "---\nname: x\n---\nBody\n"})
    assert context_of({}, files) == ["OVERLAY.md"]
    assert context_ignored({}, files) == ["CONTEXT.md"]
    assert context_of({"context": ["CONTEXT.md", "more.md"]}, files) == ["OVERLAY.md", "more.md"]
    assert context_of({"defaults": {"context": False}, "context": ["OVERLAY.md"]}, files) == ["OVERLAY.md"]
    bare = tree("CONTEXT.md", **{"OVERLAY.md": "---\nname: x\n---\n  \n"})
    assert context_of({}, bare) == ["CONTEXT.md"]
    assert context_ignored({}, bare) == []
    harness = {"harness": {"claude": {"context": ["CONTEXT.md", "c.md"]}}}
    assert harness_context_of(harness, "claude", files) == ["c.md"]
    assert harness_context_of(harness, "claude", bare) == ["CONTEXT.md", "c.md"]
    assert harness_context_of(harness, "codex", bare) == []


def test_skill_entries_are_bundled_sourced_or_catalog_by_name_bytes():
    files = tree("skills/b/SKILL.md", "skills/a/SKILL.md", "skills/bad dir/SKILL.md", "skills/a/extra.md")
    assert bundled_skills(files) == {"a", "b"}
    manifest = {
        "skills": [
            "from-catalog",
            "a",
            {
                "name": "ext",
                "source": "https://user:pw@example.com/o/r.git?token=1",
                "ref": "v1",
                "pin": "sha256:" + "a" * 64,
            },
        ]
    }
    entries = skill_entries(manifest, files)
    assert [(e.name, e.origin) for e in entries] == [
        ("a", SkillOrigin.BUNDLED),
        ("b", SkillOrigin.BUNDLED),
        ("ext", SkillOrigin.SOURCE),
        ("from-catalog", SkillOrigin.CATALOG),
    ]
    sourced = entries[2]
    assert "pw" not in (sourced.source or "") and "token" not in (sourced.source or "")
    assert "pw" in (sourced.key or "")
    assert sourced.pin == "sha256:" + "a" * 64
    assert skills_of({"defaults": {"skills": False}}, files) == []


def test_env_files_default_to_the_root_env_file():
    assert env_files_of({}, tree("env")) == [{"path": "env", "format": "dotenv"}]
    assert env_files_of({"env_files": ["env"]}, tree("env")) == ["env"]
    assert env_files_of({"defaults": {"env": False}}, tree("env")) == []


def test_dependencies_follow_the_default_files_and_their_locks():
    files = tree("lib/python/requirements.txt", "lib/node/package.json", "lib/node/package-lock.json")
    got = dependencies_of({}, files, "linux")
    assert got == [
        Dependency(Runtime.PYTHON, "lib/python/requirements.txt", None, "shared"),
        Dependency(Runtime.NODE, "lib/node/package.json", "lib/node/package-lock.json", "shared"),
    ]
    hashed = tree(**{"lib/python/requirements.txt": "a==1 \\\n    --hash=sha256:" + "0" * 64 + "\n"})
    assert dependencies_of({}, hashed, "linux")[0].lock == "lib/python/requirements.txt"
    chosen = {
        "runtime": {"node": [{"os": ["windows"], "package": "w/package.json"}, {"environment": "Isolated"}]}
    }
    assert dependencies_of(chosen, files, "linux")[0:1][0].runtime is Runtime.PYTHON
    assert dependencies_of(chosen, files, "linux")[1].environment == "isolated"
    assert dependencies_of({"defaults": {"deps": False}}, files, "linux") == []


def test_a_requirements_file_only_partly_hashed_is_a_partial_lock():
    partial = tree(**{"lib/python/requirements.txt": "a==1 --hash=sha256:" + "0" * 64 + "\nb==2\n"})
    with pytest.raises(PartialLock) as raised:
        dependencies_of({}, partial, "linux")
    assert raised.value.class_ is Class.PARTIAL_LOCK
    assert str(raised.value) == "partial-lock: lib/python/requirements.txt"
    assert isinstance(raised.value, Error)


@pytest.mark.parametrize("package", ["x", "é", "pack", "", "package.json"])
def test_a_node_package_name_shorter_than_package_json_is_not_a_crash(package):
    manifest = {"runtime": {"node": [{"package": package}]}}
    effective(manifest, Facts(os="linux"))


def test_a_url_that_is_not_ascii_in_its_first_seven_characters_is_not_a_crash():
    manifest = {"mcp": {"servers": [{"name": "s", "transport": "streamable-http", "url": "ééééé"}]}}
    effective(manifest, Facts(os="linux"))


@pytest.mark.parametrize(
    "text, locked, why",
    [
        ("-r other.txt\n", False, "an option, and only requirements are read"),
        ("pkg @ https://example.com/x.whl\n", False, "a direct URL"),
        ("pkg==1 --index-url=https://u:p@host\n", False, "an option other than --hash"),
        ("pkg\n", True, "a requirement not pinned with =="),
    ],
)
def test_a_refused_requirements_line_is_never_quoted(text, locked, why):
    with pytest.raises(Error) as raised:
        check_requirements("# fine\n" + text, locked)
    assert raised.value.class_ is Class.INVALID_REQUIREMENTS
    assert (raised.value.subject, raised.value.line) == (why, 2)
    assert "example.com" not in str(raised.value) and "u:p" not in str(raised.value)


def test_requirements_that_are_plain_pass():
    check_requirements("# c\npkg==1.0 ; python_version < '3.12'\nother>=2 # note\n\n", False)
    check_requirements("a==1 --hash=sha256:" + "0" * 64 + "\n", True)


def test_only_a_newline_ends_a_requirement_line():
    # pip reads lines split at newlines only, so another separator stays inside one requirement.
    for separator in ("\x0b", " ", "\x85", "\r"):
        check_requirements("a==1" + separator + "b\n", True)
    with pytest.raises(Error):
        check_requirements("a==1\nb\n", True)


def test_environments_group_by_runtime_and_name_and_block_conflicts():
    overlays = {name: {} for name in ("a", "b", "c", "d")}
    trees = {
        "a": OverlayTree.from_texts({"lib/python/requirements.txt": "Foo_Bar==1\n"}),
        "b": OverlayTree.from_texts({"lib/python/requirements.txt": "foo-bar==2\n"}),
        "c": OverlayTree.from_texts({"lib/python/requirements.txt": "other==1\n"}),
    }
    overlays["d"] = {"runtime": {"python": [{"environment": "isolated"}]}}
    trees["d"] = OverlayTree.from_texts({"lib/python/requirements.txt": "foo-bar==9\n"})
    got = environments(overlays, ["a", "b", "c", "d"], trees, "linux", removed=["b", "d"])
    assert got.blocked == ["a", "b"]
    assert [(c.package, c.overlays) for c in got.conflicts] == [("foo-bar", ["a", "b"])]
    assert to_data(got.environments) == [
        {
            "runtime": "python",
            "environment": "shared",
            "overlays": ["c"],
            "files": [["c", "lib/python/requirements.txt"]],
            "locked": False,
        },
        {
            "runtime": "python",
            "environment": "isolated",
            "overlays": ["d"],
            "files": [["d", "lib/python/requirements.txt"]],
            "locked": False,
        },
    ]
    assert [(e.overlay, e.then) for e in got.left] == [("b", LeftState.REBUILT), ("d", LeftState.REBUILT)]


def test_environments_of_names_nobody_defined_is_not_a_crash():
    got = environments({}, ["ghost"], {}, "linux", ["gone"])
    assert got.environments == [] and got.left == []


def test_a_value_that_doubles_line_after_line_is_refused_before_it_is_large():
    text = "A0=" + "x" * 32 + "\n" + "".join("A%d=${A%d}${A%d}\n" % (i, i - 1, i - 1) for i in range(1, 48))
    started = time.monotonic()
    with pytest.raises(Error) as raised:
        read_dotenv(text.encode(), Environment())
    assert raised.value.class_ is Class.TOO_LARGE
    assert time.monotonic() - started < 5


def test_a_refusal_in_an_env_value_names_the_variable_not_the_placeholder():
    env = Environment({"S": "secret-value"})
    env.set("S", "secret-value", True)
    with pytest.raises(Error) as raised:
        read_dotenv(b"COPY=${S}\n", env)
    assert (raised.value.class_, raised.value.subject) == (Class.SECRET_PLACEHOLDER, "COPY")


def test_names_compare_without_case_on_windows_and_keep_the_first_spelling():
    env = Environment({"Path": "a"}, windows=True)
    env.set("PATH", "b")
    assert env.values() == {"Path": "b"}
    assert env.get("path") == "b"
    env.unset("pAtH")
    assert env.values() == {} and env.get("PATH") is None
    posix = Environment({"Path": "a"})
    posix.set("PATH", "b")
    assert posix.values() == {"Path": "a", "PATH": "b"}


def test_settings_reach_substitution_through_the_environment():
    env = Environment({}, settings=Settings().replace(substitution_depth=1))
    with pytest.raises(Error) as raised:
        read_dotenv(b"A=${U:-${V:-x}}\n", env)
    assert raised.value.class_ is Class.TOO_DEEP
