# coqui-aos (Python)

[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](https://github.com/Boriken-Dev/coqui-aos/blob/main/LICENSE)

**One reader for the Agent Overlay Specification (AOS), in pure Python:** it takes bytes, or a
`FileSystem` the caller supplies, and returns data or raises `Error` carrying the class the
specification's conformance vectors use. It reads manifests (TOML, JSON and restricted YAML),
validates them, computes tree digests, orders overlays and builds the environment an overlay
declares, reads catalogs, plans skills from elsewhere and checks hooks a caller ran.

- No compiled dependency; Python 3.9 and later.
- Runtime dependencies: `ruamel.yaml` (YAML parser events, so a tag, anchor or alias is refused
  before it is expanded) and, below Python 3.11, `tomli`. Both are pure Python.
- No I/O of its own: a directory is read through a `FileSystem` protocol, with `PathFS` over
  `pathlib` as the default. Fetching skills and running hooks are the caller's, through protocols.
- Every limit is a field of `Settings`; `Settings.non_defaults()` lists what differs.
- Held to the specification's vectors, shared byte for byte with the Rust, TypeScript and Dart
  implementations.

## Installation

```sh
pip install "coqui-aos @ git+https://github.com/Boriken-Dev/coqui-aos#subdirectory=python"
```

Not published to PyPI yet.

## Quick start

```python
from coqui_aos import Class, Error, Source, read_document, validate

manifest = read_document(b'name = "docs"\npriority = 450\n')
assert validate(manifest) == []

try:
    read_document(b'#!yaml\na: &x 1\n')
except Error as error:
    assert error.class_ is Class.YAML_ANCHOR
    print(error)

assert Source.parse("git+https://example.org/o.git@v1#overlays/docs").path == "overlays/docs"
```

The public API, with every signature and gotcha, is in
[`src/coqui_aos/AGENTS.md`](src/coqui_aos/AGENTS.md).
