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
- `read_catalog`, `read_catalog_document`, `list_catalogs`, `Listing::choose` and `read_icon`:
  catalogs in both forms with sources made absolute against where they came from, a store's listing
  by label, and an icon's format and size from its header.
- `resolve_skills`, `read_fetched_skill`, `SkillSource` and `fetch_planned`: where each skill of the
  active overlays comes from, which to fetch, and the check of what was fetched against its pin.
  Fetching is the caller's; the core holds no network.
- `hooks_of`, `hook_plan`, `hook_matches`, `hook_payload`, `read_hook_output`, `hook_result` and
  `fire_event`: the hooks an overlay has, whether they are on, what each event's hook is told, and
  what of its output applies. Running a hook is the caller's. `OverlayTree` can be read from a
  `FileSystem` with `read_tree`.
- `Error::class` is `Class` and `Issue::code` is `IssueCode`; runtimes, setup steps, manifest files,
  formats and non-default settings are enums, each with `as_str` and `named`.
- The specification's conformance vectors, copied byte for byte into `vectors/` from
  agent-overlay-spec `65df79ec`, with `vectors/AOS-SOURCE.json` naming the commit and each file's
  digest. The crate passes every case of every file: `reading`, `front_matter`, `validation`,
  `names`, `source`, `digest`, `compose`, `effective`, `catalog`, `skills` and `hooks`.

