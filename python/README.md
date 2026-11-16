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

Not published to PyPI yet. The `templates` extra (`coqui-aos[templates]`) adds `tplx`, whose Mustache engine renders
the Mustache templates of served knowledge; everything else needs nothing beyond the dependencies above.

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

An overlay's knowledge is served to an agent over MCP by relative path. The core does the pure
part, a request in and a result out, so a consumer serves it over its own MCP; `kb_read` renders a
markdown file as its first line says (expanded with `${NAME}` and `@path` by default, as written for `raw`, or rendered
by `envsubst` or `mustache`) for the call, so a consumer never applies any of them itself:

```python
from coqui_aos import CallerFacts, KnowledgeOverlay, TreeEntry, kb_read

overlay = KnowledgeOverlay(
    "team-docs", {}, {"kb/intro.md": TreeEntry.file(b"# Intro\n\nHello\n")}
)
result = kb_read([overlay], "kb/intro.md", from_line=3, caller=CallerFacts(role="reviewer"))
assert result["structuredContent"]["text"] == "Hello"
```

The public API, with every signature and gotcha, is in
[`src/coqui_aos/AGENTS.md`](src/coqui_aos/AGENTS.md).
