# coqui-aos

[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](https://github.com/Boriken-Dev/coqui-aos/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-latest-blue.svg)](https://boriken-dev.github.io/coqui-aos/)
[![CI](https://img.shields.io/github/actions/workflow/status/Boriken-Dev/coqui-aos/test.yml)](https://github.com/Boriken-Dev/coqui-aos/actions/workflows/test.yml)

**One reader for the Agent Overlay Specification (AOS), in every language a consumer is written
in, held to the specification's own conformance vectors.** Each implementation here is native to
its language and needs no compiler on the consumer's side; the vectors in `vectors/` are what keep
them alike. The specification is at <https://github.com/Boriken-Dev/agent-overlay-spec>.

## Features

- **Rust** (`rust/`): the `coqui-aos` crate. Reading manifests in TOML, JSON and restricted YAML,
  validation, names, sources, tree digests, composition and the environment an overlay builds. The
  core reads nothing itself: it reads through a `FileSystem` the caller supplies, so it builds for
  `wasm32-unknown-unknown`.
- **Python, TypeScript and Dart** (`python/`, `ts/`, `dart/`): not yet present. Each will be pure,
  with the same filesystem shape, and pass the same vectors.
- **Shared vectors** (`vectors/`): the specification's conformance vectors, copied byte for byte,
  with `vectors/AOS-SOURCE.json` naming the specification commit and each file's digest.

## Installation

```sh
cargo add coqui-aos --git https://github.com/Boriken-Dev/coqui-aos
```

Nothing is published to a registry yet.

## Quick start

```rust
use coqui_aos::{Settings, read_document, validate};

let manifest = read_document(b"name = \"docs\"\npriority = 450\n", &Settings::default())?;
assert!(validate(&manifest, None).is_empty());
# Ok::<(), coqui_aos::Error>(())
```

## API overview

| Path | Purpose |
| --- | --- |
| `rust/` | the `coqui-aos` crate; its README and `AGENTS.md` describe the API |
| `vectors/` | the specification's conformance vectors, shared by every language |

## Development

```sh
cd rust
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo check --target wasm32-unknown-unknown --no-default-features
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features
```

### Releasing

This project follows [Semantic Versioning](https://semver.org/) and keeps a
[`CHANGELOG.md`](CHANGELOG.md). Pushing a tag matching `v*` needs the owner's consent for that
release.

## License

MPL-2.0 — see [LICENSE](LICENSE).
