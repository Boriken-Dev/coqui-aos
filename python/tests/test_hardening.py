"""Hostile input the vectors lack: what a stranger's manifest or text does to each reader."""

from __future__ import annotations

import pytest

from coqui_aos import (
    Class,
    Error,
    Facts,
    OverlayTree,
    Settings,
    apply_overlay,
    effective,
    Environment,
    read_env_script_output,
)

MALFORMED = [
    {"paths": ["bin"]},
    {"paths": [1, None, [], {"variable": 3}]},
    {"paths": [{"variable": "PATH"}]},
    {"paths": [{"variable": "PATH", "path": 4}]},
    {"env": {"A": 1}},
    {"env": {"A": None}},
    {"env": {"A": [1]}},
    {"env": {"A": {"value": 1}}},
    {"env": {"A": {"provider": 1, "key": 2}}},
    {"env": {"A": {"secret": 3}}},
    {"env": [1, 2]},
    {"env": "x"},
    {"env_files": [1, None, {"path": 3}, {"path": "a", "format": 4}]},
    {"env_files": "x"},
    {"env_scripts": [1, "x", {"path": 4}, {"interpreter": "python"}]},
    {"setup": [1, {"path": []}]},
    {"setup": "x"},
    {"runtime": "x"},
    {"runtime": {"python": [1, "x", {"os": 3}], "node": 5, "commands": [1, {"name": 2}]}},
    {"runtime": {"python": [{"lock": 1}], "node": [{"package": 3}]}},
    {"scripts": {"a": 1, "b": []}},
    {"scripts": []},
    {"mcp": "x"},
    {"mcp": {"servers": [1, {"env": 3}, {"env": {"A": 1}, "url": 4}]}},
    {"defaults": "x"},
    {"harness": 1},
    {"requires": 1},
]


@pytest.mark.parametrize("manifest", MALFORMED, ids=[str(i) for i in range(len(MALFORMED))])
def test_an_unvalidated_manifest_only_ever_raises_error(manifest):
    facts = Facts(os="linux", root="/o", identity="x", tree=OverlayTree(["bin/a", "env", "setup.py"]))
    try:
        effective(manifest, facts)
    except Error:
        pass
    try:
        apply_overlay(Environment({}, False), manifest, facts, [])
    except Error:
        pass


def test_env_script_output_refuses_names_equal_under_case():
    with pytest.raises(Error) as raised:
        read_env_script_output(b'{"Path": "1", "PATH": "2"}')
    assert raised.value.class_ is Class.ENV_SCRIPT_OUTPUT


def test_env_script_output_keeps_the_order_keys_were_first_set():
    got = read_env_script_output(b'{"A": "1", "B": "2"}\n{"A": "3"}')
    assert list(got) == ["A", "B"] and got["A"] == "3"


def test_effective_refuses_a_manifest_that_does_not_validate():
    from coqui_aos import effective as eff

    facts = Facts(os="linux", root="/o", identity="x", tree=OverlayTree(["bin/a"]))
    for manifest in (
        {"paths": [{"variable": "PATH", "path": "../../../etc"}]},
        {"env": {"A=B": "x"}},
        {"env": {"A\nB": "x"}},
    ):
        with pytest.raises(Error):
            eff(manifest, facts)
        with pytest.raises(Error):
            apply_overlay(Environment({}, False), manifest, facts, [])


def test_a_pinned_skill_reports_the_files_its_digest_covers():
    from coqui_aos import read_fetched_skill

    skill = b"---\nname: review\ndescription: d\n---\nbody\n"
    clean = [("SKILL.md", skill), ("scripts/run.py", b"x")]
    digest = read_fetched_skill("review", clean).digest
    carried = clean + [("scripts/helper.pyc", b"x"), ("node_modules/x/index.js", b"y"), (".git/config", b"z")]
    got = read_fetched_skill("review", carried, str(digest))
    assert got.files == ("SKILL.md", "scripts/run.py")


def test_cycle_is_an_error():
    from coqui_aos import Cycle, resolve

    with pytest.raises(Error) as raised:
        resolve({"a": {"requires": ["b"]}, "b": {"requires": ["a"]}}, ["a"])
    assert isinstance(raised.value, Cycle) and raised.value.class_ is Class.CYCLE
    assert raised.value.chain == ["a", "b", "a"]


def test_read_hook_output_enforces_the_output_bound_itself():
    from coqui_aos import HookError, HookEvent, HookFailure, read_hook_output

    with pytest.raises(HookError) as raised:
        read_hook_output(
            HookEvent.SESSION_START,
            b'{"context": "' + b"a" * 100 + b'"}',
            (),
            Settings().replace(hook_output_bytes=50),
        )
    assert raised.value.failure is HookFailure.TOO_LARGE


def test_a_catalog_ref_refuses_what_a_source_refuses():
    from coqui_aos import read_catalog

    for ref in ("v1\u202egnp.exe", "v1\x85", "v1\u2028", "v1\u200f"):
        text = '[overlays.a]\nsource = "https://example.org/o.git"\nref = "%s"\n' % ref
        got = read_catalog(text.encode(), "c.toml")
        assert "a" not in got.overlays.entries and got.overlays.refused


def test_subjects_hold_no_document_text_and_no_raw_control_characters():
    secret = "sk-live-SECRET"
    for data in (
        b"#!json\n" + ('{"%s": 1, "%s": 2}' % (secret, secret)).encode(),
        b"#!yaml\n%s: 1\n%s: 2\n" % (secret.encode(), secret.encode()),
        ("a = 1\n'%s' = 2\n'%s' = 3\n" % (secret, secret)).encode(),
    ):
        with pytest.raises(Error) as raised:
            from coqui_aos import read_document

            read_document(data)
        assert secret not in str(raised.value) and secret not in raised.value.subject


def test_a_subject_escapes_control_and_bidi_characters_and_is_capped():
    error = Error(Class.INVALID_NAME, "a\x1b[31m\u202eb\n" + "x" * 5000)
    assert "\x1b" not in error.subject and "\u202e" not in error.subject and "\n" not in error.subject
    assert len(error.subject) <= 260 and "\\x1b" in error.subject


def test_a_digest_error_never_shows_an_os_message():
    from pathlib import PurePath

    from coqui_aos import FileKind, Metadata, tree_digest

    class Broken:
        def metadata(self, path):
            return Metadata(FileKind.DIRECTORY)

        def list(self, path):
            raise OSError(13, "denied /home/someone/secret")

        def read(self, path, limit):
            return b""

    with pytest.raises(Error) as raised:
        tree_digest(Broken(), PurePath("/o"))
    assert "someone" not in raised.value.subject


@pytest.mark.parametrize(
    "host,local",
    [("127.1", True), ("2130706433", True), ("0x7f.0.0.1", True), ("0177.0.0.1", True), ("127.0.1", True)],
)
def test_non_canonical_ipv4_loopback_is_local(host, local):
    from coqui_aos._source import host_is_local

    assert host_is_local(host) is local


@pytest.mark.parametrize(
    "host", ["10.1", "167772417", "0xa.1", "0300.0250.1", "100.64.0.1", "100.127.255.255", "192.168.1"]
)
def test_non_canonical_and_shared_ipv4_is_private(host):
    from coqui_aos._source import host_is_private

    assert host_is_private(host) is True


@pytest.mark.parametrize(
    "host", ["100.63.255.255", "100.128.0.0", "8.8.8.8", "1.1", "256.1.1.1", "0x100000000"]
)
def test_other_hosts_are_not_private_or_local(host):
    from coqui_aos._source import host_is_local, host_is_private

    assert host_is_private(host) is False
    if host not in ("1.1",):
        assert host_is_local(host) is False


def test_a_relative_entry_under_a_base_with_credentials_is_refused():
    from coqui_aos import EntryRefusal, read_catalog

    text = b'[overlays]\nrust = "../overlays/rust"\n'
    for base in (
        "https://bob:hunter2@example.org/r.git@v1#c/overlays.toml",
        "https://bob:hunter2@example.org/c/overlays.toml",
    ):
        got = read_catalog(text, "overlays.toml", base)
        assert got.overlays.refused == [("rust", EntryRefusal.SOURCE_CREDENTIALS)]


def test_composed_environment_leaves_the_callers_base_alone():
    from coqui_aos import composed_environment

    base = Environment({"A": "1"}, False)
    facts = Facts(os="linux", root="/o", identity="x", tree=OverlayTree())
    composed_environment([({}, facts)], base, {}, [])
    assert base.values() == {"A": "1"}


def test_a_tree_digests_member_list_cannot_be_changed_after_the_fact():
    from coqui_aos import TreeEntry, digest_entries

    tree = digest_entries([((b"a",), TreeEntry.file(b"x"))])
    with pytest.raises(TypeError):
        tree.files["b"] = tree.digest
