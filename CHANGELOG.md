# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The vectors are those of specification commit `d11c60b`, and the four implementations pass them:
  the bound on the context a hook adds counts UTF-8 bytes together with what the session holds, a
  part past it is not added (whole, never cut) and is reported `hook-not-applied`, and a later part
  that fits still is; the hooks of an event run in composition order, then the user's, then the
  project's; a hook gets its own overlay's environment (its own declarations and `pre-env` output,
  every overlay's root variable, `AOS_OVERLAY_*` and `AOS_HOOK_EVENT`), a `pre-env` hook the base and
  the root and state variables, and a user's or a project's hook the base and `AOS_HOOK_EVENT`; an
  overlay whose digest is not the one allowed for its hooks runs no env script, declared or default,
  is otherwise applied, and is reported `env-script-not-allowed`. Additive in every language:
  `fire_event_after` (Rust) and an optional `context_used` (Python, Dart, TypeScript); `hook_order` and
  `hook_environment`; `Facts` fields `gate_env_scripts`, `digest` and `allowed`; and `Effective.reports`.

- guatiao is pinned at `e0136dcc`, so the coqui family builds against one revision.
- The three implementations agree on behaviours their reviews settled, and the vectors now hold all
  three to them (specification commit `268fbe4`): a fetched skill lists the files its pin covers
  (`files`) and an entry under an excluded name is no refusal; a refusal's subject has its control,
  format and separator characters escaped and is cut to 256 characters, and holds no parser or
  operating system text; a source's IPv4 host is read as a URL parser reads it (`127.1`,
  `2130706433`, `0x7f.0.0.1`, `10.1`) and `100.64.0.0/10` is private; applying refuses a variable
  name that is no name and a path that leaves the overlay as `invalid-reference`, naming it
  (Python raised `schema` with a pointer, and TypeScript quoted no name). Rust also bounds
  substitution by `substitution_steps` throughout and reads duplicates, brackets and environments in
  linear time.

### Fixed

- TypeScript reads a JSON document that is one empty object or list (`#!json` then `{}`); it refused
  it as ending early.

### Added

- The `coqui_aos` Dart package (`dart/`): the same reader in pure Dart 3.9 and later for the VM and
  the web, with `yaml` (parser events, so a tag, anchor or alias is refused before it is expanded)
  and `crypto` as its only dependencies; TOML and JSON are read by the package. lowerCamelCase
  functions, closed sets as plain strings with a `Words` constant, integers as `BigInt` (a Dart
  `int` and `double` are one number on the web), `AosError` carrying `errorClass`, `subject`,
  `line` and `column`, a `Settings` holding every limit with `nonDefaults()`, a `FileSystem`
  interface with `IoFileSystem` in `package:coqui_aos/io.dart`, and `SkillSource` for fetching. It
  passes every case of `vectors/` on the VM and in Chrome, none skipped.

- The `coqui-aos` Python package (`python/`, import `coqui_aos`): the same reader in pure Python 3.9
  and later, with `ruamel.yaml` (and `tomli` below 3.11) as its only dependencies. Snake-case
  functions, `str` enums for the closed sets, `Error` carrying `class_`, `subject`, `line` and
  `column`, a `Settings` dataclass holding every limit with `non_defaults()`, a `FileSystem`
  protocol with `PathFS` over `pathlib` as the default, and `SkillSource` for fetching. It passes
  every case of `vectors/`, none skipped.
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

