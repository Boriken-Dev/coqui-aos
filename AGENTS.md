# coqui-aos — repository orientation

One reader for the Agent Overlay Specification (AOS), implemented natively in each language a
consumer is written in, with no compiled extension or binding between them. The specification's
conformance vectors, shared by every implementation, are what keep them alike.

| Shipped header | Covers |
| --- | --- |
| [`rust/AGENTS.md`](rust/AGENTS.md) | the `coqui-aos` crate's public API |
| [`python/src/coqui_aos/AGENTS.md`](python/src/coqui_aos/AGENTS.md) | the `coqui_aos` package's public API |
| [`dart/AGENTS.md`](dart/AGENTS.md) | the `coqui_aos` Dart package's public API |

## Layout

| Path | Responsibility |
| --- | --- |
| `rust/` | the `coqui-aos` crate: the Rust implementation, its tests and its README |
| `tools/` | `public-api.txt`, the committed public API of the Rust crate |
| `vectors/` | the specification's conformance vectors, copied byte for byte; `AOS-SOURCE.json` names the commit and each file's digest |
| `python/` | the `coqui-aos` Python package (import `coqui_aos`): pure Python, 3.9 and later, its tests and its README |
| `ts/` | the TypeScript implementation, pure, passing the same vectors |
| `dart/` | the `coqui_aos` Dart package: pure Dart for the VM and the web, its tests and its README |

## Commands

```sh
cd rust
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo clippy --all-targets --no-default-features -- -D warnings
cargo test --all-features
cargo test --no-default-features
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features
cargo check --target wasm32-unknown-unknown --no-default-features
cargo +nightly-2026-09-21 public-api --all-features -sss --color never > ../tools/public-api.txt   # when the API changed
```

```sh
cd python
dotagents pyvenv 3.14 && dotagents pyvenv 3.9      # venvs in ../.pyvenv/, once
../.pyvenv/<version>/Scripts/python.exe -m pip install -e ".[dev]"   # bin/python on POSIX
../.pyvenv/<version>/Scripts/python.exe -m pytest        # the vectors and the hostile-input tests
../.pyvenv/<version>/Scripts/python.exe -m black --check src tests
```

```sh
cd dart
dart pub get
dart format --output=none --set-exit-if-changed .
dart analyze --fatal-infos
dart test                                                  # the vectors and the tests beside them, on the VM
dart run tool/stage_vectors.dart && dart test -p chrome    # the web, from vectors staged under test/vectors/
```

## Rules

- Each implementation reads the vectors in `vectors/` and names every case it does not run, with the
  reason; none carries its own copy.
- The core of an implementation does no I/O: it reads through a small filesystem interface the
  caller supplies (read a file, list a directory, say what a path is without following a link).
- Every limit is a setting with a default and no floor; a setting looser than its default is
  reported as data.
- A vector file is moved to a later specification revision with `git cat-file blob`, never a
  copy through a shell pipe, and `vectors/AOS-SOURCE.json` changes with it.
- Files are LF on every platform; `vectors/*` is marked `-text` and never converted.

## CI and release

`test.yml` runs on dispatch and on a `ci-*` tag or branch. Pushing a `v*` tag needs the owner's
consent for that release.
