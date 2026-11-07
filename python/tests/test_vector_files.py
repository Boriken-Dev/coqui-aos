"""Every vector file is run by a test, and none of them skips a case."""

from __future__ import annotations

import re
from pathlib import Path

from support import VECTORS

TESTS = Path(__file__).parent

# The test module that reads each vector file.
RUNNERS = {
    "reading.json": ("test_document.py", "test_dotenv.py", "test_catalog.py"),
    "front_matter.json": ("test_front_matter.py",),
    "skills.json": ("test_skills.py",),
    "validation.json": ("test_validate.py",),
    "names.json": ("test_names.py",),
    "source.json": ("test_source.py",),
    "digest.json": ("test_digest.py",),
    "compose.json": ("test_compose.py",),
    "effective.json": ("test_effective.py",),
    "catalog.json": ("test_catalog.py",),
    "hooks.json": ("test_hooks.py",),
}


def test_every_vector_file_has_a_runner():
    assert {path.name for path in VECTORS.glob("*.json") if path.name != "AOS-SOURCE.json"} == set(RUNNERS)


def test_each_runner_reads_its_file():
    for name, runners in RUNNERS.items():
        assert any(name in (TESTS / runner).read_text(encoding="utf-8") for runner in runners), name


def test_no_test_skips_a_vector():
    for path in TESTS.glob("test_*.py"):
        if path.name == "test_digest_on_disk.py":
            continue  # skips a platform that cannot hold a tree, counted in the run's report
        text = path.read_text(encoding="utf-8")
        # The one skip is a real-filesystem test on an account that may not create links.
        text = text.replace('pytest.skip("this account may not create symbolic links")', "")
        assert not re.search(r"pytest\.(skip|mark\.skip|xfail)", text), path.name
