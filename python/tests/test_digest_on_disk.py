"""The digest vectors again, over a real directory through ``PathFS``: the trees this platform can
hold (links and fifos need rights and a Unix filesystem; names it folds cannot be told apart)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from support import bytes_of, cases, ids

from coqui_aos import Error, PathFS, tree_digest

DIGESTS = cases("digest.json")


def materialize(case, root: Path) -> bool:
    """Build the case's tree under ``root``; False when this platform cannot hold it."""
    for item in case["tree"]:
        if "path_base64" in item or "\\" in item["path"] or "\0" in item["path"]:
            return False
        path = root / item["path"]
        kind = item.get("type", "file")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if kind == "dir":
                path.mkdir(parents=True, exist_ok=True)
            elif kind == "symlink":
                os.symlink(item["target"], str(path), target_is_directory=item["path"] == "docs")
            elif kind == "special":
                if not hasattr(os, "mkfifo"):
                    return False
                os.mkfifo(str(path))
            else:
                path.write_bytes(bytes_of(item))
        except (OSError, NotImplementedError, ValueError):
            return False
        here = root
        for part in item["path"].split("/"):
            if part not in os.listdir(str(here)):
                return False
            here = here / part
    return True


@pytest.mark.parametrize("case", DIGESTS, ids=ids(DIGESTS))
def test_digest_on_this_filesystem(case, tmp_path):
    if not materialize(case, tmp_path):
        pytest.skip("this platform cannot hold the tree")
    files = sum(1 for item in case["tree"] if item.get("type", "file") == "file")
    if len({p.as_posix() for p in tmp_path.rglob("*") if p.is_file()}) < files:
        pytest.skip("a case-insensitive filesystem holds one name for two")
    expect = case["expect"]
    if "error" in expect:
        with pytest.raises(Error) as raised:
            tree_digest(PathFS(), tmp_path)
        assert raised.value.class_ == expect["error"]
    else:
        assert tree_digest(PathFS(), tmp_path).digest == expect["digest"]
