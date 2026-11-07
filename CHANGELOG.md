# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The `coqui-aos` Rust crate (`rust/`): the Agent Overlay Specification's reader. It reads
  `overlay.cfg`, `OVERLAY.md` (its front matter is split on bytes, then read as restricted YAML or
  the format a format line names) and env files in TOML, JSON and YAML; validates a manifest;
  parses overlay names and source strings; computes tree digests; resolves `requires` and the
  composition order; and builds the environment, setup phases and package environments an overlay
  declares. Every refusal is an `Error` whose `class` is the class the specification's vectors
  name.
- `FileSystem`, the trait the reader reads directories through (what a path is without following a
  link, the first bytes of a file, the names in a directory), with `StdFs` behind the default `fs`
  feature. The core does no I/O of its own and builds for `wasm32-unknown-unknown` with
  `--no-default-features`.
- `Settings`: every limit the reader applies (manifest size and depth, files, directories, depth
  and bytes of a tree, a context body, substitution size, depth and steps), each with a default
  and no floor, described once by guatiao's derives. `Settings::non_defaults` lists those that
  differ from the default.
- The specification's conformance vectors, copied byte for byte into `vectors/` from
  agent-overlay-spec `65df79ec`, with `vectors/AOS-SOURCE.json` naming the commit and each file's
  digest. The crate passes `reading`, `front_matter`, `validation` (except the `hooks` cases),
  `names`, `source`, `digest`, `compose` (except the `pre_env` cases) and `effective`; the
  `catalog`, `skills` and `hooks` files and those cases are counted as skipped, case by case.
