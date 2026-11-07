"""digest.json, and walking a tree through a caller's filesystem."""

from __future__ import annotations

from pathlib import PurePath

import pytest
from support import bytes_of, cases, decode, ids

from coqui_aos import (
    Class,
    Digest,
    Error,
    FileKind,
    Metadata,
    PathFS,
    Settings,
    TreeEntry,
    digest_entries,
    read_tree,
    tree_digest,
)

DIGESTS = cases("digest.json")


def entry_of(item):
    kind = item.get("type", "file")
    if kind == "dir":
        return TreeEntry.directory()
    if kind == "symlink":
        return TreeEntry.symlink()
    if kind == "special":
        return TreeEntry.special()
    return TreeEntry.file(bytes_of(item))


@pytest.mark.parametrize("case", DIGESTS, ids=ids(DIGESTS))
def test_digest(case):
    entries = []
    for item in case["tree"]:
        path = decode(item["path_base64"]) if "path_base64" in item else item["path"].encode("utf-8")
        entries.append((path.split(b"/"), entry_of(item)))
    expect = case["expect"]
    if "error" in expect:
        with pytest.raises(Error) as raised:
            digest_entries(entries)
        assert raised.value.class_ == expect["error"]
        return
    got = digest_entries(entries)
    assert got.digest == expect["digest"]
    assert [line.decode("utf-8") for line in got.lines()] == expect["lines"]


def test_a_path_twice_is_a_duplicate_member():
    with pytest.raises(Error) as raised:
        digest_entries([([b"a"], TreeEntry.file(b"1")), ([b"a"], TreeEntry.file(b"2"))])
    assert raised.value.class_ is Class.DUPLICATE_MEMBER


def test_digest_parse_keeps_lowercase_and_refuses_the_rest():
    text = "sha256:" + "AB" * 32
    assert Digest.parse(text) == "sha256:" + "ab" * 32
    assert len(Digest.parse(text).bytes) == 32
    for bad in ("sha256:abc", "sha1:" + "a" * 64, "sha256:" + "g" * 64, "sha256:" + "a" * 64 + "\n"):
        with pytest.raises(Error) as raised:
            Digest.parse(bad)
        assert raised.value.class_ is Class.INVALID_DIGEST


class MemoryFS:
    """A filesystem of ``{path: bytes | dict | Metadata}`` that records what it was asked."""

    def __init__(self, tree, read=None):
        self.tree = tree
        self.reads = []
        self.override = read

    def _node(self, path):
        node = self.tree
        for part in PurePath(path).relative_to(ROOT).parts:
            node = node[part]
        return node

    def metadata(self, path):
        try:
            node = self._node(path)
        except KeyError:
            raise FileNotFoundError(str(path)) from None
        if isinstance(node, Metadata):
            return node
        if isinstance(node, dict):
            return Metadata(FileKind.DIRECTORY)
        return Metadata(FileKind.FILE, len(node))

    def read(self, path, limit):
        self.reads.append((str(path), limit))
        if self.override is not None:
            return self.override(path, limit)
        return self._node(path)[:limit]

    def list(self, path):
        return list(self._node(path))


ROOT = PurePath("/overlay")


def test_a_tree_read_through_a_filesystem_matches_the_digest_of_its_entries():
    fs = MemoryFS({"overlay.cfg": b"x", "kb": {"a.md": b"# A\n"}, ".git": {"config": b"ignored"}})
    tree, digest = read_tree(fs, ROOT)
    assert sorted(tree.paths) == ["kb/a.md", "overlay.cfg"]
    assert tree.bytes("kb/a.md") == b"# A\n"
    assert digest == tree_digest(fs, ROOT)
    assert (
        digest.digest
        == digest_entries(
            [([b"overlay.cfg"], TreeEntry.file(b"x")), ([b"kb", b"a.md"], TreeEntry.file(b"# A\n"))]
        ).digest
    )


def test_the_root_must_be_a_directory_and_a_link_is_not_followed():
    class Link:
        def metadata(self, path):
            return Metadata(FileKind.SYMLINK)

    with pytest.raises(Error) as raised:
        tree_digest(Link(), ROOT)
    assert raised.value.class_ is Class.IO


@pytest.mark.parametrize(
    "kind, class_", [(FileKind.SYMLINK, Class.SYMLINK), (FileKind.OTHER, Class.SPECIAL_FILE)]
)
def test_a_link_or_special_member_is_refused_unread(kind, class_):
    fs = MemoryFS({"a": Metadata(kind)})
    with pytest.raises(Error) as raised:
        tree_digest(fs, ROOT)
    assert raised.value.class_ is class_
    assert fs.reads == []


@pytest.mark.parametrize("name", ["", ".", "..", "a/b", "a\\b", "a\0b"])
def test_a_listed_name_that_is_a_path_is_refused(name):
    with pytest.raises(Error) as raised:
        tree_digest(MemoryFS({name: b"x"}), ROOT)
    assert raised.value.class_ is Class.INVALID_NAME


def test_a_name_that_is_not_unicode_is_refused():
    with pytest.raises(Error) as raised:
        tree_digest(MemoryFS({"a\udcff": b"x"}), ROOT)
    assert raised.value.class_ is Class.NON_UTF8_NAME


def test_a_file_that_grew_after_metadata_is_bounded_by_the_file_limit():
    fs = MemoryFS({"a": Metadata(FileKind.FILE, 1)}, read=lambda path, limit: b"x" * limit)
    with pytest.raises(Error) as raised:
        tree_digest(fs, ROOT, Settings(file_bytes=10))
    assert raised.value.class_ is Class.TOO_LARGE
    assert fs.reads == [(str(ROOT / "a"), 11)]


def test_a_file_that_vanished_between_metadata_and_read_is_io():
    def gone(path, limit):
        raise FileNotFoundError("gone")

    with pytest.raises(Error) as raised:
        tree_digest(MemoryFS({"a": b"x"}, read=gone), ROOT)
    assert raised.value.class_ is Class.IO


def test_bounds_are_settings():
    deep = {"a": {"b": {"c": b"x"}}}
    flat = {str(n): b"x" for n in range(5)}
    for tree, settings in (
        (deep, Settings(tree_depth=2)),
        (flat, Settings(tree_files=4)),
        (flat, Settings(tree_bytes=4)),
    ):
        with pytest.raises(Error) as raised:
            tree_digest(MemoryFS(tree), ROOT, settings)
        assert raised.value.class_ is Class.TOO_LARGE
    assert tree_digest(MemoryFS(deep), ROOT, Settings(tree_depth=3, tree_files=3)).files


class ChainFS:
    """``levels`` nested directories named ``d``, then one file."""

    def __init__(self, levels):
        self.levels = levels

    def _depth(self, path):
        return len(PurePath(path).parts) - len(ROOT.parts)

    def metadata(self, path):
        depth = self._depth(path)
        if depth <= self.levels:
            return Metadata(FileKind.DIRECTORY)
        return Metadata(FileKind.FILE, 1)

    def list(self, path):
        return ["d"] if self._depth(path) < self.levels else ["f"]

    def read(self, path, limit):
        return b"x"


def test_a_lifted_depth_limit_does_not_recurse():
    result = tree_digest(ChainFS(1100), ROOT, Settings(tree_depth=None, tree_files=None))
    assert len(next(iter(result.files))) > 1100


def test_a_lifted_file_limit_asks_for_no_giant_buffer(tmp_path):
    (tmp_path / "a").write_bytes(b"hello")
    tree, _ = read_tree(PathFS(), tmp_path, Settings(file_bytes=None, tree_bytes=None))
    assert tree.bytes("a") == b"hello"


def test_the_default_filesystem_refuses_a_link_member(tmp_path):
    (tmp_path / "real").write_bytes(b"x")
    try:
        (tmp_path / "link").symlink_to(tmp_path / "real")
    except OSError:
        pytest.skip("this account may not create symbolic links")
    with pytest.raises(Error) as raised:
        tree_digest(PathFS(), tmp_path)
    assert raised.value.class_ is Class.SYMLINK
