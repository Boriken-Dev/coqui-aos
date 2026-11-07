# `coqui-aos` — API header

Header-file-style reference for the `coqui-aos` crate: every public item with its signature, contract and gotchas, so the crate can be used without reading its source. It ships inside the package and is self-contained. Development documentation lives with the source at <https://github.com/Boriken-Dev/coqui-aos>.

| Feature | Adds | Needed for | Default |
| --- | --- | --- | --- |
| `fs` | `StdFs`, `std::fs` as a `FileSystem` | reading a directory from the operating system | on |

MSRV Rust 1.89. Version `0.0.0-alpha.0`, not published; the API may change in any release before 1.0. A default build depends on `granit-parser` (the YAML parser `serde-saphyr` is built on), `guatiao` (the derives that describe `Settings`), `serde_json`, `sha2` and `toml`. `--no-default-features` compiles for `wasm32-unknown-unknown`. `serde_json` is re-exported as `coqui_aos::serde_json`, because the data model is its `Value` and `Map`, and its `preserve_order` feature is on for every crate in the build.

Imports: everything is at the root. No `unsafe` code (`#![forbid(unsafe_code)]`). No process-wide state; the library prints nothing, reads no environment variable and starts no thread. Edition: AOS v0, `0.1.0-draft`.

Reading a manifest is static: no function here runs a script, reads a file or consults the environment, except `tree_digest`, which reads through the `FileSystem` it is given.

## Errors

```rust
#[non_exhaustive] pub struct Error { pub class: &'static str, pub subject: String, pub line: Option<usize>, pub column: Option<usize> }
pub fn Error::new(class: &'static str, subject: impl Into<String>) -> Error
pub fn Error::at(self, line: usize, column: usize) -> Error
pub fn Error::on_line(self, line: usize) -> Error
```

`Clone`, `Debug`, `Eq`, `Display` (`class: subject at line N column M`), `std::error::Error`. **`class` is the contract**: the class the specification's conformance vectors name (`parse-error`, `duplicate-key`, `too-deep`, `symlink`, `undefined-variable`, ...), plus this crate's `io`, `duplicate-member`, `invalid-requirements` and `invalid-digest`. `subject` names what it is about (a variable, a path, a pointer) for a person, never text from a document; do not match on it. `line` and `column` are one-based, `column` counts Unicode scalar values; a line counts from the first line of the file, a format line included.

Functions that cannot refuse return no `Result`; the others return `Result<_, Error>`, except `compose` (`Cycle`) and `dependencies_of` (`PartialLock`), which return the structure the vectors expect, and both implement `Display` and `std::error::Error`.

## Settings (`Settings`, `Limit`)

```rust
#[non_exhaustive] pub struct Settings { pub manifest_bytes, manifest_depth, tree_files, tree_depth, tree_bytes, file_bytes, context_bytes, substitution_bytes, substitution_depth, substitution_steps: Limit }   // Default, Copy, Eq
// defaults: 1 MiB, 64, 4096, 64, 64 MiB, 16 MiB, 1 MiB, 1 MiB, 32, 10_000_000
pub fn Settings::manifest_bytes(self, limit: Limit) -> Settings   // and one setter per field, named for it
pub fn Settings::non_defaults(&self) -> Vec<NonDefault>           // every setting that differs, read from the described type
pub struct NonDefault { pub setting: String, pub value: String, pub default: String }
pub struct Limit(..)                                               // Copy, Eq, Display ("none" or the number)
pub const Limit::UNBOUNDED: Limit
pub const fn Limit::at(n: u64) -> Limit
pub const fn Limit::get(self) -> Option<u64>
pub fn Limit::allows<N: TryInto<u64>>(self, n: N) -> bool
```

Every limit is a setting with a default and no floor; `Limit::UNBOUNDED` lifts one, and `non_defaults` reports it. `Settings` derives guatiao's `ToValue`, `FromValue` and `Schema` (`deny_unknown_fields`; a limit is a whole number, or `null` or `"none"` for no bound). `manifest_*` bound a manifest, an env file and an env script's output; `tree_files` counts files and directories together, excluded names not counted; `tree_depth` counts directory levels, the root's own being the first. One bound is not a setting: the nesting of parentheses in a license expression, 128.

Lifting `manifest_depth` leaves the nesting of what is read to the caller's stack when it later drops, clones or prints the `Value`; the reader itself builds without recursion.

## Reading (`read_document`, `read_front_matter`, ...)

```rust
pub type Document = serde_json::Map<String, serde_json::Value>;
pub fn read_document(data: &[u8], settings: &Settings) -> Result<Document, Error>
pub fn parse_dotenv(data: &[u8]) -> Result<Vec<DotenvLine>, Error>        // DotenvLine { name, text, literal }
pub fn read_env_script_output(data: &[u8], settings: &Settings) -> Result<ScriptOutput, Error>   // Vec<(String, Option<String>)>, None unsets
pub fn read_dotenv(data: &[u8], env: &mut Environment) -> Result<Vec<(String, String)>, Error>
pub fn split_front_matter<'a>(data: &'a [u8], settings: &Settings) -> Split<'a>
pub fn read_front_matter(data: &[u8], settings: &Settings) -> FrontMatter
pub fn context_file_text<'a>(data: &'a [u8], settings: &Settings) -> Result<&'a [u8], Error>
pub fn read_overlay(tree: &OverlayTree, settings: &Settings) -> Result<OverlayRead, Error>
```

`read_document`: one optional byte-order mark, an optional format line (`#!json`, `#!/usr/bin/env yaml`), else TOML; then the data model. **Dialect**: a duplicate key in one mapping, a null, a TOML date or time, a non-finite float, an integer outside the signed 64-bit range (refused before it is converted), a mapping key that is not a string, a lone surrogate escape in JSON and a byte-order mark where the text starts are refused. A JSON `30.0` is a float and `30` an integer, whatever their size. In YAML a plain scalar is typed by the 1.2 core schema (`yes` is a string), and a tag, anchor, alias, merge key, `%YAML` or `%TAG` directive and a second document are refused at the parser's events, before anything is expanded. Nesting past `manifest_depth` is `too-deep` while parsing, in every format; a parser's own failure on text deeper than the bound is reported as `too-deep` too. Mapping order is the document's.

`split_front_matter` splits on bytes, unchanged: `Split { case: SplitCase, metadata, metadata_offset, metadata_line, body_offset, body_line }` with `Split::body(data)`; offsets count bytes from the first byte of the file, lines from 1. `read_front_matter` adds the reading: `FrontMatter { case: Case, data: Option<Document>, error: Option<Error>, format, body_offset, body_line }`; `error` is what a gate refuses with (its `line` counted from the file's first line), `case` what a viewer shows. `Case`: `None`, `Malformed`, `Unterminated`, `TooLarge`, `Empty`, `UnknownFormat`, `DoesNotParse`, `NotAMapping`, `Mapping`. The head, through the closing fence's line end, is bounded by `manifest_bytes`, and nothing past it is read.

`read_overlay` takes an `OverlayTree` holding the bytes of `OVERLAY.md` or `overlay.cfg` and returns `OverlayRead { manifest_file, manifest, context, context_ignored, issues, harness_context }`; `issues` are JSON pointers. It refuses two manifests (`two-manifests`), a manifest that does not read, and a context body past `context_bytes` or not UTF-8.

## Validation (`validate`)

```rust
pub fn validate(manifest: &Document, tree: Option<&OverlayTree>) -> Vec<Issue>   // Issue { code: &'static str, at: String }, sorted by pointer
pub fn applies(issues: &[Issue]) -> bool          // only problems under /about leave a manifest applying
pub fn named_files(doc: &Document) -> Vec<(String, String)>   // (pointer, relative path) of each file a field requires
pub fn skill_flags(doc: &Document, tree: &OverlayTree) -> Vec<String>   // pointers of skill names neither bundled nor sourced
pub fn valid_license(expression: &str) -> bool
```

`at` is an RFC 6901 pointer with `~` and `/` escaped. With a tree, files a field names must be in it. The `hooks` field is not validated yet.

## Names, sources, digests

```rust
pub fn valid_overlay_name(name: &str) -> bool
pub fn normalize_name(name: &str) -> String        // ASCII lowercase, `_` and `.` made `-`
pub fn root_variable(identity: &str) -> String     // NAME_OVERLAY_ROOT; state_variable: NAME_OVERLAY_STATE
pub fn valid_relative_path(path: &str) -> bool
pub fn is_variable_name / is_reserved_variable / is_sensitive_variable(name: &str) -> bool
pub fn Source::parse(text: &str) -> Result<Source, Error>   // [git+]<location>[@<ref>][#<path>]
#[non_exhaustive] pub struct Source { pub kind: SourceKind, pub location: String, pub reference: Option<String>, pub path: Option<String> }
pub fn Source::shown(&self) -> String              // no user information or query; Debug shows the same
pub fn Source::is_local / holds_credentials / is_web_url(&self) -> bool
pub struct Digest(..)                              // Copy, Ord, Display `sha256:<hex>`, FromStr, Digest::of(bytes), Digest::parse(text)
pub fn digest_entries<'a, I>(entries: I) -> Result<TreeDigest, Error>   // I: (Vec<&[u8]> components, &TreeEntry); order does not matter; a path twice is `duplicate-member`
pub fn tree_digest(files: &dyn FileSystem, root: &Path, settings: &Settings) -> Result<TreeDigest, Error>
pub enum TreeEntry { File(Vec<u8>), Directory, Symlink, Special }
pub struct TreeDigest { pub digest: Digest, pub files: BTreeMap<String, Digest> }   // lines() gives the bytes that were hashed
```

Case folding of identities, variables and sensitivity is ASCII only; substitution's `^^` and `,,` operators and skill-name equality fold by Unicode rules, which the runtime's tables decide.

## The filesystem (`FileSystem`, `StdFs`)

```rust
pub trait FileSystem {
    fn metadata(&self, path: &Path) -> io::Result<Metadata>;          // WITHOUT following a link: a link is FileKind::Symlink
    fn read(&self, path: &Path, max: u64) -> io::Result<Vec<u8>>;     // the first `max` bytes
    fn list(&self, path: &Path) -> io::Result<Vec<OsString>>;         // single path components, any order
}
pub enum FileKind { File, Directory, Symlink, Other }     // non_exhaustive
pub struct Metadata { pub kind: FileKind, pub len: u64 }   // Metadata::new(kind, len)
pub struct StdFs;                                          // feature `fs`; a reparse point is a Symlink on Windows
```

`tree_digest` checks every entry with `metadata` before it reads or descends, and refuses a listed name that is empty, `.`, `..` or holds `/`, `\` or NUL. `StdFs::read` and `list` open through links, as `std::fs` does: a link swapped in between `metadata` and `read` is followed, so read only trees no one else can write. A name that is not Unicode is refused as `non-utf8-name`.

## What an overlay's files contribute

```rust
pub struct OverlayTree     // paths and the bytes of those read; Default, from_paths, from_texts, with_text, with_bytes, paths, contains, text, bytes
pub fn rules_of / context_of / paths_of / env_files_of / skills_of(manifest: &Document, tree: &OverlayTree) -> ...
pub fn default_paths(manifest, tree) -> Vec<Value>;  pub fn default_on(manifest: &Document, key: &str) -> bool
pub fn context_ignored(manifest, tree) -> Vec<String>;  pub fn harness_context_of(manifest, harness: &str, tree) -> Vec<String>
pub fn skill_entries(manifest, tree) -> Vec<SkillEntry>   // SkillEntry { name, origin: SkillOrigin, source, key, pin }
pub fn dependencies_of(manifest, tree, os: &str) -> Result<Vec<Dependency>, PartialLock>
pub fn check_requirements(text: &str, locked: bool) -> Result<(), Error>   // `invalid-requirements`; never quotes the line
```

`with_text` ignores a path the tree does not hold; `with_bytes` adds it. The body of `OVERLAY.md` is the context default when its text was read into the tree.

## Composition and the environment

```rust
pub fn resolve(overlays: &BTreeMap<String, Document>, requested: &[String]) -> Result<Resolution, Cycle>
pub fn composition_order(overlays, active: &[String]) -> Vec<String>
pub fn compose(overlays, requested, trees: &BTreeMap<String, OverlayTree>) -> Result<Composition, Cycle>
pub fn environments(overlays, active, trees, os: &str, removed: &[String]) -> Result<Environments, Error>   // `partial-lock`; a name with no manifest is skipped
pub fn effective(manifest: &Document, facts: &Facts) -> Result<Effective, Error>
pub fn Facts::new(os: impl Into<String>) -> Facts   // pub fields: os, root, identity, state, pinned, base_env, host_env, grants, secrets, secret_files, providers, provider_values, enforces_network, env_scripts_enabled, interpreters, packages, tree, settings
pub struct Environment                               // new(base, windows), settings(Settings), get, set(name, value, secret), unset, values, is_secret
pub fn composed_environment(overlays: &[(&Document, Facts)], base: Environment, non_defaults: &mut Vec<NonDefaultSetting>) -> Result<Environment, Error>
pub fn preparation(change: Change, record: Option<&SetupRecord>, digest: Option<&str>, setup: Option<&SetupRun>, dependencies: &[Dependency], fails: Option<&str>) -> Preparation
pub fn setup_phase(change: Change, recorded: Option<&str>, digest: Option<&str>) -> Option<Phase>
pub fn substitute(text: &str, lookup: Lookup) -> Result<String, Error>;  pub fn substitute_with(text, lookup, settings: &Settings) -> Result<String, Error>
```

`Effective` holds `ungranted`, `supported`, `env`, `env_scripts`, `setup`, `python`, `node`, `dependencies`, `needs` and `non_defaults` (`NonDefaultSetting { id, subject }`: the spec's reports such as `unpinned` and `env-sensitive`, never a value). An `Environment` never lets a placeholder read a variable that holds a resolved secret. Substitution refuses `too-large`, `too-deep` and `too-complex` past `substitution_*`; a placeholder's variable or pattern is never quoted.

## Not read yet

Catalogs and icons (the Store class), skills resolved through catalogs and fetched skills, and hooks (their validation, the `hook.<ext>` default, a `pre-env` hook's output) are not read by this crate; `vectors/catalog.json`, `skills.json` and `hooks.json` are counted as skipped, case by case, by the test suite.

## Gotchas

- Equal mapping keys are refused, and a validator names the **later** of two keys equal under case (`env-name-case-duplicate`), which needs the document's order: `serde_json`'s `preserve_order` is on.
- A `Document` read from YAML, TOML and JSON is the same value; only the format line and `OVERLAY.md`'s front matter choose the parser.
- `tree_digest` is the only place a reader opens a file. `StdFs` is the one `FileSystem` shipped; a binding supplies its own.
- The tests read the specification's vectors from `../vectors`, which are not in the packaged crate.
