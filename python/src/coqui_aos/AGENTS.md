# `coqui-aos` (Python) — API header

Header-file-style reference for the `coqui_aos` package: the public names, what they return and raise, and the gotchas, so it can be used without reading the source. It ships inside the package and is self-contained. Development documentation lives with the source at <https://github.com/Boriken-Dev/coqui-aos>.

Python 3.9 and later, pure Python. Version `0.0.0a0`, not published; the API may change in any release before 1.0. Runtime dependencies: `ruamel.yaml` (YAML parser events, so a tag, anchor, alias, merge key or directive is refused before anything is expanded) and, below Python 3.11, `tomli` (TOML). Both are pure Python. Edition: AOS v0, `0.1.0-draft`.

Imports: everything is at the package root (`from coqui_aos import read_document, Error, Class`). The library prints nothing, logs nothing, reads no environment variable, starts no thread or process and touches no file except through the `FileSystem` it is given (`read_tree`, `tree_digest`). Reading a manifest is static.

## Errors

```python
class Error(Exception): class_: Class; subject: str; line: int | None; column: int | None; setting: str | None;  over(setting) -> Error
class Class(str, Enum)       # every class the vectors name; Class.named(word) -> Class | None
```

For a refusal of a limit (`too-large`, `too-deep`, `too-complex`, `icon-too-large`, `icon-dimensions`) `setting` is the key of the setting that was passed, as a configuration writes it (`tree_files`, `manifest_depth`, `icon_width`, ...): stable, unlike `subject`'s wording; `None` for any other refusal. `class_` is the contract (`Class.DUPLICATE_KEY == "duplicate-key"`); `subject` names what it is about (a variable, a path, a pointer) for a person, never text from a document, so do not match on it. `line` and `column` are one-based, `column` counts code points. A subject is escaped (control, format, separator, surrogate, private-use and unassigned characters as `\xNN`, `\uNNNN` or `\UNNNNNNNN`) and cut to 256 characters, then `...`, and holds no text from a document or a parser's or the operating system's message. Nothing but `Error` leaves a reader on hostile input; `PartialLock` and `Cycle` (with `.chain`, the whole loop) are `Error` subclasses, and `HookError` carries a `HookFailure`.

Closed sets are `str` enums (`Runtime`, `Format`, `ManifestFile`, `Case`, `SplitCase`, `Change`, `Phase`, `LeftState`, `FailStep`, `NonDefaultId`, `HookEvent`, `HookFailure`, `Decision`, `OnFailure`, `HookScope`, `PlannedOrigin`, `CatalogForm`, `IconFormat`, `EntryRefusal`, `SourceKind`, `EntryKind`, `FileKind`): a member equals its word. `to_data(value)` turns any result (dataclass, named tuple, enum) into plain JSON data, the shape the vectors write.

## Settings

```python
Settings(manifest_bytes=1 MiB, manifest_depth=64, tree_files=4096, tree_depth=64, tree_bytes=64 MiB, file_bytes=16 MiB,
         context_bytes=1 MiB, catalog_bytes=4 MiB, icon_bytes=512 KiB, icon_width=1024, icon_height=1024, hook_timeout=60,
         hook_event_timeout=120, hook_output_bytes=64 KiB, hook_payload_bytes=1 MiB, hook_reason_chars=1024,
         substitution_bytes=1 MiB, substitution_depth=32, substitution_steps=10_000_000)   # frozen dataclass
Settings.replace(**limits) -> Settings;  Settings.non_defaults() -> list[NonDefault(setting, value, default)]
```

Every limit is a setting with a default and no floor; `None` (`UNBOUNDED`) lifts one, and `non_defaults` reports it. Every function that reads takes `settings=None` for the defaults. `tree_files` counts files and directories together; `tree_depth` counts directory levels, the root's being the first.

## Reading

```python
read_document(data: bytes, settings=None) -> Document        # dict; TOML unless a format line (#!json, #!/usr/bin/env yaml)
split_front_matter(data, settings=None) -> Split              # case, metadata, metadata_offset/line, body_offset/line; .body(data)
read_front_matter(data, settings=None) -> FrontMatter         # case, data, error, format, and the split's offsets
context_file_text(data, settings=None) -> bytes               # the text after a closed front matter block
read_overlay(tree: OverlayTree, settings=None) -> OverlayRead # manifest_file, manifest, context, context_ignored, issues, harness_context
parse_dotenv(data) -> list[DotenvLine];  read_dotenv(data, env: Environment) -> list[tuple[str, str]]
read_env_script_output(data, settings=None) -> ScriptOutput   # (name, value | None) pairs; None unsets
```

Dialect: a duplicate key, a null, a TOML date or time, a non-finite float, an integer outside 64 bits (refused before it is converted), a non-string key, a lone surrogate escape and a byte-order mark where the text starts are refused. A JSON `30.0` is a float and `30` an integer. A YAML plain scalar is typed by the 1.2 core schema (`yes` is a string). Nesting past `manifest_depth` is `too-deep`; text so deep a parser's stack ends is `too-deep` too. `read_front_matter` never raises: `error` is what a gate refuses with, `case` what a viewer shows. Lines in `error` count from the file's first line.

## Validation, names, sources, digests

```python
validate(manifest: Document, tree: OverlayTree | None = None) -> list[Issue(code: Class, at: str)]   # sorted pointers; applies(issues)
named_files(doc) -> list[tuple[str, str]];  skill_flags(doc, tree) -> list[str];  valid_license(expression) -> bool
valid_overlay_name / normalize_name / root_variable / state_variable / valid_relative_path / is_variable_name / is_reserved_variable / is_sensitive_variable
Source.parse(text) -> Source(kind, location, ref, path);  .shown() .is_local() .holds_credentials() .is_web_url()
digest_entries(entries) -> TreeDigest(digest, files);  tree_digest(fs, root, settings=None);  read_tree(fs, root, settings=None) -> (OverlayTree, TreeDigest)
TreeEntry.file(data) / .directory() / .symlink() / .special();  Digest(str): "sha256:<hex>"
```

`Issue.at` is an RFC 6901 pointer. With a tree, the files a field names must be in it. A `Source` never shows user information or a query in `repr` or `shown()`. `tree_digest` and `read_tree` check each entry with `FileSystem.metadata` before reading or descending and refuse symlinks, special files, non-Unicode and invalid names and case collisions.

## Templating

```python
TemplateFacts(root=None, state=None, name=None, scope=None, project=None, options={})   # frozen dataclass
template_values(manifest, facts) -> dict[str, str]        # invalid-option
template(text, values) -> str
context_text(data: bytes, values, settings=None) -> str   # front matter dropped; too-large, invalid-utf8
skill_text(data: bytes, values, settings=None) -> str     # front matter as written
```

`${NAME}` is replaced in the context a consumer assembles and in the body of a bundled skill it serves, never in an installed file, and only for `AOS_OVERLAY_ROOT`, `AOS_OVERLAY_STATE`, `AOS_OVERLAY_NAME`, `AOS_OVERLAY_SCOPE`, `AOS_PROJECT_ROOT` and the overlay's `options` that have a value; a name with no value, an unknown name, one with an operator and a sensitive option are left as written, `$${` is `${`, and a value is never read again. A skill's front matter is served as written. A configured value of the wrong type is `invalid-option`, never converted. The bound on the context counts the text after replacing: the caller checks it.

## The filesystem

```python
class FileSystem(Protocol): metadata(path) -> Metadata(kind: FileKind, size);  read(path, limit) -> bytes;  list(path) -> list[str]
class PathFS                      # the default, over os and pathlib; a reparse point is a SYMLINK
class OverlayTree                 # paths and the bytes read: from_texts, with_text, with_bytes, paths, text, bytes, `in`
```

`metadata` does not follow a link. `PathFS.read` and `list` open through links: a link swapped in between `metadata` and `read` is followed, so read only trees no one else can write. A caller supplies its own `FileSystem` (an archive, a remote tree).

## Composition and the environment

```python
resolve(overlays: dict[str, Document], requested) -> Resolution;  composition_order(overlays, active) -> list[str]   # raise Cycle
compose(overlays, requested, trees) -> Composition;  composed_environment(...) -> ComposedEnvironment   # env or error, hook reports
hook_order(overlays, requested, has, scopes=()) -> list[(HookScope, str)];  hook_environment(event, active, base, pre_env, identity=None, earlier=()) -> Environment;  process_environment(process, active, base, pre_env, identity) -> Environment
effective(manifest: Document, facts: Facts) -> Effective;  Facts(os, root, identity, state, pinned, base_env, host_env, grants, secrets, ..., gate_env_scripts, digest, allowed)
Environment(base, windows) -> get / set(name, value, secret) / unset / values() / is_secret;  apply_overlay(env, manifest, facts, non_defaults, reports=None)
substitute(text, lookup) -> str;  substitute_with(text, lookup, settings)
rules_of / context_of / paths_of / env_files_of / skills_of / skill_entries / default_paths / default_on / context_ignored / harness_context_of
dependencies_of(manifest, tree, os) -> list[Dependency]   # PartialLock;  check_requirements(text, locked)
SetupRecord(digest, phase).to_dict() -> {"digest", "phase"};  SetupRecord.from_dict(data) -> SetupRecord (ValueError for anything else);  Phase.named(word) -> Phase | None;
setup_phase(change, recorded, digest) -> Phase | None;  preparation(...) -> Preparation;  environments(overlays, active, trees, os, removed) -> Environments
```

`effective` and `apply_overlay` also refuse (`invalid-reference`, naming the variable or path) an environment variable name that is no name and a path that leaves the overlay, whatever `validate` was asked. An `Environment` never lets a placeholder read a variable that holds a resolved secret. Substitution refuses `too-large`, `too-deep` and `too-complex` past `substitution_*` and never quotes a placeholder's variable or pattern. With `Facts.gate_env_scripts` an overlay whose `digest` is not its `allowed` one (the allowance of its hooks; a missing digest is no match) runs no env script, declared or default, and `Effective.reports` holds `("env-script-not-allowed", identity)` when it has one for the OS; the rest of it applies. `effective` and `apply_overlay` raise `Error`; the reports (`unpinned`, `env-sensitive`, ...) are ids and subjects, never values.

## Catalogs, icons, skills from elsewhere

```python
read_catalog(data, name, base=None, settings=None) -> Catalog;  read_catalog_document(data, name, settings=None);  catalog_format(name)
list_catalogs([(label, catalog)]) -> Listing;  Listing.choose(requested) -> ListedEntry   # not-found, ambiguous
read_icon(data, name, settings=None) -> Icon(format, width, height)
resolve_skills(overlays, requested, trees, catalogs, order, fetches=True, settings=None) -> SkillPlan   # .to_fetch
read_fetched_skill(name, files: list[tuple[str, bytes]], pin=None, settings=None) -> FetchedSkill   # .digest, .reported, .files
class SkillSource(Protocol): fetch(source: Source) -> list[tuple[str, bytes]];  fetch_planned(plan, fetcher, settings=None)
```

`FetchedSkill.files` are the paths the digest covers: write those and nothing else, since a tree that matches its pin may also carry entries under an excluded name (`node_modules`, `__pycache__`, `*.pyc`, `.git`). Nothing is fetched here. The core decides what to fetch and checks what the caller's `SkillSource` returned, pin first, so nothing unverified is parsed. A catalog entry's `description` is a stranger's text: do not render it as markup.

## Hooks

```python
hooks_of(manifest, tree, os, interpreters) -> (list[Hook], list[str]);  hooks_declared(manifest, tree) -> bool   # any hook on any OS with any interpreter;  hook_plan(manifest, tree, facts: HookFacts, settings=None) -> HookPlan
hook_matches(event, select, value) -> bool;  hook_payload(event, known) -> dict
read_hook_output(event, data, sets, settings=None) / hook_result(event, run: HookRun, settings=None) -> HookOutput   # raise HookError
fire_event(event, runs, applies=None, settings=None, windows=False, context_used=0, tool_input=<unset>, tool_kind=None) -> FiredEvent
```

Running a hook is the caller's: it builds a `HookRun` from what the process did and the core checks it in a fixed order (started, payload, time, size, exit, output), combines the runs of one event to the tightest decision (a deny or block beats an ask, an ask beats an allow; `Decision.ALLOW` is a `pre-tool` hook approving the call, which never lifts the user's own refusals) and reports what could not be applied. A hook is off until the user allows it at the overlay's digest. `repr` of a run, an output or an event shows counts, never output text or values; `HookPlan.activates` is false for a guard that is off. Context a hook adds counts in UTF-8 bytes, with `context_used`, against `Settings.context_bytes`: a part that would pass it is not added, whole, and is reported `hook-not-applied`, and a later part that fits still is. `hook_order` is the overlays that have a hook in composition order, then the user's, then the project's; `hook_environment` is the session's environment as one hook sees it: every overlay's declarations stacked in composition order, top layer winning, every `pre-env` output, and what the earlier hooks of the event set (`earlier`, a mapping per hook, `None` unsetting); a `pre-env` hook sees the root and state variables and the `pre-env` output before it, no declaration. `process_environment` is the same for an overlay's `setup`, `server` or `command` (the finished stack) and `env-script` (the stack as it stands at that overlay's step). A `pre-tool` hook may print `decision = "allow"` with an `input` object that replaces the call's; pass the call's input as `tool_input` and `FiredEvent.seen` says what each hook was given and `FiredEvent.input` what the call runs with: set only for a combined allow, since an ask or a deny beats a rewrite (an ask reports it `hook-not-applied` `input`). An `allow` or `input` outside `applies` is not applied and is reported; so is the allow of a hook whose `HookRun.select` (its entry's `match`) is given and does not name `other`, on a call of `tool_kind` `other` (its deny and ask still count). Any decision the event does not take is an `output` failure; there is no `grant` cause.

## Gotchas

- Equal mapping keys are refused, and a validator names the later of two keys equal under case; documents keep insertion order.
- A source host is judged the way a client reads it: `127.1`, `2130706433`, `0x7f.0.0.1` and `0177.0.0.1` are loopback, `10.1` and `100.64.0.0/10` are private.
- A catalog entry's `pin` is kept as written (the vectors keep its case); compare pins through `Digest`.
- Case folding of identities, variables and sensitivity is ASCII only.
- The tests read the specification's vectors from `../vectors`, which are not in the sdist.
