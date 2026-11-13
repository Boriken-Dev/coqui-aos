# `coqui-aos` (TypeScript) — API header

Header-file-style reference for the TypeScript package: every public item with its contract and gotchas, so it can be used without reading the source. It ships inside the package and is self-contained. Development documentation lives with the source at <https://github.com/Boriken-Dev/coqui-aos>.

Version `0.0.0-alpha.0`, `private`, not published: the name `coqui-aos` is a working name until the owner names a verified npm scope; the API may change in any release before 1.0. Node 22 or later; ES2023. Two entry points: `coqui-aos` (everything, no `node:*` import, runs in a browser) and `coqui-aos/node` (`NodeFs`). Runtime dependencies: `yaml` (YAML 1.2; its tokens show tags, anchors and aliases before composing), `smol-toml` (TOML 1.0), `@noble/hashes` (synchronous SHA-256). Edition: AOS v0, `0.1.0-draft`. No process-wide state; nothing is printed; no environment variable is read; `currentOs()` reads `globalThis.process?.platform` only when called.

Reading a manifest is static: nothing here runs a script, opens a connection or consults the environment. Files are read only by `readTree` and `treeDigest`, through the `FileSystem` they are given.

## Data model (`Value`, `Document`)

```ts
type Value = boolean | bigint | number | string | Value[] | Document
type Document = Map<string, Value>     // the document's order; any key, `__proto__` included
```

An integer is a `bigint` in the signed 64-bit range and a float a finite `number`, so `30` is `30n` and `30.0` is `30`; `valuesEqual(a, b)` compares structurally (mapping order ignored, integer never equal to float). There is no null: a null is refused as `null-value`. Helpers: `isDocument`, `isList`, `isInteger`, `toPlain(value)` (mappings as null-prototype objects), `fromPlain(json)` (whole numbers become integers),.

## Errors (`AosError`, `ErrorClass`)

```ts
class AosError extends Error { readonly class: ErrorClass; readonly subject: string; line: number | undefined; column: number | undefined }
const CLASSES: readonly ErrorClass[];   classNamed(word: string): ErrorClass | undefined
```

**`class` is the contract**: a string-literal union of the classes the specification's vectors name (`"parse-error"`, `"duplicate-key"`, `"too-deep"`, `"symlink"`, `"undefined-variable"`, ...) plus `"io"`, `"duplicate-member"`, `"invalid-requirements"`, `"invalid-digest"`. `subject` names what it is about (a variable, a path, a pointer) for a person, never text from a document; do not match on it. `line` and `column` are one-based, `column` counts Unicode scalar values, a line counts from the file's first line, a format line included. `message` is `class: subject at line N column M`. `line` and `column` are read-only. A `subject` is escaped as the specification's conformance chapter writes it (control, format, separator, surrogate, private-use and unassigned characters as `\xNN`, `\uNNNN` or `\UNNNNNNNN`) and cut to 256 characters, then `...`, whoever builds the error. Applying refuses a variable name that is no name and a path that leaves the overlay as `invalid-reference`, naming it. Three subclasses carry more: `Cycle` (class `cycle`, `chain`; from `resolve` and `compose`), `PartialLock` (class `partial-lock`; from `dependenciesOf` and `environments`) and `HookFailed` (class `hook-refused`, `failure`; from `hookResult`), so `instanceof AosError` and `.class` hold everywhere. A caller's `FileSystem` or `SkillSource` may throw anything; the core reports a file system's as `io`.

The closed sets of words are string-literal unions with a const list and a `{ all, is, named }` helper: `Runtime` (`runtime`), `LeftState`, `ManifestFile`, `Format` (`format`), `FailStep`, `NonDefaultId`, `HookEvent`, `Decision`, `OnFailure`, `HookScope`, `HookFailure`, `PlannedOrigin`, `CatalogForm`, `IconFormat`, `EntryRefusal`, `IssueCode`, `Change`, `Phase`; `Step` is the template union `"empty-state" | "deps:python" | ... | "record"`.

## Settings (`Settings`, `Limit`)

```ts
type Limit = number | null            // null: no bound
class Settings { readonly manifestBytes, manifestDepth, treeFiles, treeDepth, treeBytes, fileBytes, contextBytes, catalogBytes, iconBytes, iconWidth, iconHeight, hookTimeout, hookEventTimeout, hookOutputBytes, hookPayloadBytes, hookReasonChars, substitutionBytes, substitutionDepth, substitutionSteps: Limit
  constructor(changes?: Partial<SettingsValues>);  with(changes): Settings;  values(): SettingsValues
  static fromData(data: Record<string, unknown>): Settings    // snake_case keys, a number, null or "none"
  nonDefaults(): NonDefault[] }       // { setting: "manifest_depth", value: "none", default: "64" }
const DEFAULT_SETTINGS: Settings;  UNBOUNDED: Limit;  allows(limit, n): boolean;  limitText(limit): string
```

Immutable (frozen). Defaults: 1 MiB, 64, 4096, 64, 64 MiB, 16 MiB, 1 MiB, 4 MiB, 512 KiB, 1024, 1024, 60 s, 120 s, 64 KiB, 1 MiB, 1024 characters, 1 MiB, 32, 10 000 000. Every limit has no floor; `null` lifts one and `nonDefaults()` reports it, so report it. A limit must be a non-negative safe integer or `null`, else `RangeError`; `fromData` also takes a `Map` and `bigint` integers; `allows(limit, n)` is false for a negative or NaN `n`. `manifest*` bound a manifest, an env file and an env script's output; `treeFiles` counts files and directories together, excluded names not counted; `treeDepth` counts directory levels, the root's own the first. One bound is not a setting: the nesting of parentheses in a license expression, 128.

Lifting `manifestDepth` hands the stack to the parser: the JSON and the data-model builders do not recurse, but YAML and TOML parsers do, and a document that overflows one is refused as `too-deep`.

## Reading

```ts
readDocument(data: Uint8Array, settings: Settings): Document
parseDotenv(data: Uint8Array): DotenvLine[]                              // { name, text, literal }
readDotenv(data: Uint8Array, env: Environment): Array<[string, string]>  // substituted against env, in order
readEnvScriptOutput(data: Uint8Array, settings: Settings): Array<[string, string | undefined]>   // undefined unsets
splitFrontMatter(data, settings): Split;  readFrontMatter(data, settings): FrontMatter;  contextFileText(data, settings): Uint8Array
readOverlay(tree: OverlayTree, settings: Settings): OverlayRead
```

`readDocument`: one optional byte-order mark, an optional format line (`#!json`, `#!/usr/bin/env yaml`), else TOML. **Dialect**: a duplicate key in one mapping, a null, a TOML date or time, a non-finite float, an integer outside the signed 64-bit range, a mapping key that is not text, a lone surrogate escape in JSON and a byte-order mark where the text starts are refused. In YAML a plain scalar is typed by the 1.2 core schema (`yes` is text), and a tag, anchor, alias, merge key (`<<` in any style), `%YAML`/`%TAG` directive and a second document are refused from the parser's tokens, before anything is composed. Nesting past `manifestDepth` is `too-deep` in every format.

`splitFrontMatter` splits bytes unchanged: `Split { case, metadata, metadataOffset, metadataLine, bodyOffset, bodyLine, body(data) }` (offsets are bytes from the first byte, lines from 1). `readFrontMatter` adds the reading: `FrontMatter { case, data, error, format, bodyOffset, bodyLine }`, `case` being `none | malformed | unterminated | too-large | empty | unknown-format | does-not-parse | not-a-mapping | mapping`; `error` is what a gate refuses with, `case` what a viewer shows. `readOverlay` takes an `OverlayTree` holding the bytes of `OVERLAY.md` or `overlay.cfg` and returns `{ manifestFile, manifest, context, contextIgnored, issues, harnessContext }`; it refuses two manifests (`two-manifests`), a manifest that does not read, and a context body past `contextBytes` or not UTF-8. `issues` are RFC 6901 pointers.

## Validation

```ts
validate(manifest: Document, tree?: OverlayTree): Issue[]      // { code: IssueCode, at: string }, sorted by pointer
applies(issues: readonly Issue[]): boolean                      // only problems under /about leave a manifest applying
namedFiles(doc): Array<[string, string]>                        // (pointer, relative path) of each file a field requires
skillFlags(doc, tree): string[];  validLicense(expression: string): boolean
```

With a tree, the files a field names must be in it. The `hooks` field's files are checked, not run.

## Names, sources, digests

```ts
validOverlayName, normalizeName, rootVariable, stateVariable, validRelativePath, isVariableName, isReservedVariable, isSensitiveVariable (name: string)
class Source { kind: "git" | "url" | "directory"; location; reference: string | undefined; path: string | undefined
  static parse(text: string): Source        // [git+]<location>[@<ref>][#<path>], else `invalid-source`
  shown(): string; toString(); isLocal(); holdsCredentials(); isWebUrl(): boolean }
class Digest { static of(bytes); static parse(text); equals(other); toString() }     // `sha256:<64 hex>`
digestEntries(entries: Iterable<[ReadonlyArray<Uint8Array | string>, TreeEntry]>): TreeDigest   // order does not matter; a path twice is `duplicate-member`
treeDigest(files: FileSystem, root: string, settings: Settings): Promise<TreeDigest>
readTree(files, root, settings): Promise<{ tree: OverlayTree; digest: TreeDigest }>     // every member's bytes and the digest of one walk
type TreeEntry = { kind: "file"; bytes } | { kind: "directory" } | { kind: "symlink" } | { kind: "special" }
interface TreeDigest { digest: Digest; files: Map<string, Digest>; lines(): Uint8Array[] }
```

Non-canonical IPv4 hosts (`127.1`, `2130706433`, `0x7f.0.0.1`) are classified as the address a URL parser reads, and `100.64.0.0/10` is private. `Source` hides user information and query in `shown()`, `toString()`, `toJSON()` and `util.inspect`; `location` and `keyWith()` hold them, never print those. Case folding of identities, variables and sensitivity is ASCII only; substitution's `^^` and `,,` operators fold by Unicode rules, which the runtime's tables decide.

## The filesystem (`FileSystem`, `NodeFs`)

```ts
interface FileSystem {
  metadata(path: string): Metadata | Promise<Metadata>                       // WITHOUT following a link: a link is "symlink"
  read(path: string, max: number): Uint8Array | Promise<Uint8Array>          // the first `max` bytes
  list(path: string): Array<string | Uint8Array> | Promise<...>              // single components, any order; non-Unicode names as bytes
}
type FileKind = "file" | "directory" | "symlink" | "other";  interface Metadata { kind: FileKind; len: number }
class NodeFs implements FileSystem          // from "coqui-aos/node"; a reparse point is a symlink on Windows
```

The core joins a root and a name with `/` (`joinPath`), which `node:fs` accepts on Windows too. `treeDigest` checks every entry with `metadata` before it reads or descends, and refuses a listed name that is empty, `.`, `..` or holds `/`, `\` or NUL, and a name that is not Unicode (`non-utf8-name`). `NodeFs.read` and `list` open through links, as `node:fs` does: a link swapped in between `metadata` and `read` is followed, so read only trees no one else can write.

## What an overlay's files contribute

```ts
class OverlayTree { static fromPaths(paths), fromTexts(entries), empty();  withText(path, text), withBytes(path, bytes);  paths(), members(): string[];  contains, hasMember(path), text(path), bytes(path) }
rulesOf, contextOf, pathsOf, envFilesOf, skillsOf(manifest, tree), defaultPaths, defaultOn(manifest, key), contextIgnored, harnessContextOf(manifest, harness, tree)
skillEntries(manifest, tree): SkillEntry[]                // { name, origin, source, key, pin, from }
dependenciesOf(manifest, tree, os): Dependency[]          // throws PartialLock
checkRequirements(text: string, locked: boolean): void    // `invalid-requirements`; never quotes the line
```

`OverlayTree` is immutable. `withText` ignores a path the tree does not hold; `withBytes` adds it. The body of `OVERLAY.md` is the context default when its text was read into the tree.

## Composition and the environment

```ts
resolve(overlays: ReadonlyMap<string, Document>, requested): Resolution;  compositionOrder(overlays, active): string[]     // throw Cycle
compose(overlays, requested, trees: ReadonlyMap<string, OverlayTree>): Composition
environments(overlays, active, trees, os: string, removed: readonly string[]): Environments     // throws `partial-lock`; a name with no manifest is skipped
effective(manifest: Document, facts: Facts): Effective
class Facts { constructor(os: string, changes?); with(changes): Facts }    // fields: os, root, identity, state, pinned, baseEnv, hostEnv, grants, secrets, secretFiles, providers, providerValues, enforcesNetwork, envScriptsEnabled, gateEnvScripts, digest, allowed, interpreters, packages, tree, settings
class Environment { constructor(base?: Iterable<[string, string]>, windows?: boolean);  settings(s), get, set(name, value, secret), unset, values(), isSecret, clone }
composedEnvironment(active: Array<[Document, Facts]>, base: Environment, preEnv: ReadonlyMap<string, HookRun>, nonDefaults: NonDefaultSetting[]): { env | undefined, error | undefined, hookReports, hookNonDefaults }
preparation(change, record, digest, setup, dependencies, fails): Preparation;  setupPhase(change, recorded, digest): Phase | undefined
substitute(text, lookup: (name) => string | undefined): string;  substituteWith(text, lookup, settings)
```

`Effective` holds `ungranted`, `supported`, `env`, `envScripts`, `setup`, `python`, `node`, `dependencies`, `needs`, `reports` (`[id, subject]`: `env-script-not-allowed`) and `nonDefaults` (`{ id, subject }`: the spec's reports such as `unpinned` and `env-sensitive`, never a value). An `Environment` never lets a placeholder read a variable that holds a resolved secret. Substitution refuses `too-large`, `too-deep` and `too-complex` past `substitution*`; a placeholder's variable or pattern is never quoted. A lookup may throw an `AosError`.

## Catalogs and icons

```ts
readCatalog(data: Uint8Array, name: string, base: string | undefined, settings): Catalog;  readCatalogDocument(data, name, settings): Document
catalogFormat(name: string): Format | undefined;  listCatalogs(catalogs: Array<[string, Catalog]>): Listing;  chooseListed(listing, requested): ListedEntry
readIcon(data: Uint8Array, name: string, settings): Icon      // { format, width, height }, judged from the header alone
```

`name` is the catalog's file name, whose extension picks the format; `base` is the source string it came from. A refused entry is listed in `refused` by name. A `description` is a stranger's text: do not render it as markup. Nothing is fetched.

## Skills from elsewhere, and hooks

```ts
resolveSkills(overlays, requested, trees, catalogs, order: readonly string[], fetches: boolean, settings): SkillPlan     // SkillPlan.toFetch: what to fetch
readFetchedSkill(name, files: Array<[string, Uint8Array]>, pin: string | undefined, settings): FetchedSkill     // { digest, reported, files }
interface SkillSource { fetch(source: Source): Files | Promise<Files> }
fetchPlanned(plan, fetcher: SkillSource, settings): Promise<FetchedPlanned[]>      // one skill after another; each outcome is { ok: true, skill } or { ok: false, error }
hooksOf, hookPlan(manifest, files, facts: HookFacts, settings): HookPlan;  hookMatches, hookPayload, readHookOutput, hookResult(event, run, settings): HookOutput;  fireEvent(event, runs, applies, settings, windows, contextUsed = 0): FiredEvent;  hookOrder(overlays, requested, has, scopes): Array<[string, string]>;  hookEnvironment(event, active, base, preEnv, identity: string | undefined): Environment
hookRun(source: string, stdout?: Uint8Array): HookRun        // fields: exit, seconds, timedOut, notRun, payloadSize, sets, onFailure
```

The core decides what to fetch and checks what came back, pin first, so nothing unverified is parsed; it holds no network. Running a hook is the caller's: it builds a `HookRun` from what the process did and the core checks it in a fixed order (started, payload, time, size, exit, output), combines the runs of one event to the tightest decision and reports what could not be applied. `FetchedSkill.files` are the paths the digest covers: write those and nothing else, since the digest leaves out entries under an excluded name (`node_modules`, `__pycache__`, `*.pyc`, `.git`). A `pre-env` hook's output is read exactly as an env script's. A hook is off until the user allows it at the overlay's digest (`HookFacts.allowed`); `HookPlan.activates` is false for a guard that is off. Context a hook adds counts in UTF-8 bytes, with `contextUsed`, against `contextBytes`: a part that would pass it is not added, whole, and is reported `hook-not-applied`, and a later part that fits still is. `hookOrder` is the overlays that have a hook in composition order, then the user's, then the project's; `hookEnvironment` is the environment one hook runs with, an overlay's hook seeing its own declarations and `pre-env` output and no other overlay's (`Environment.log`, `setJoined` and `replay` carry one overlay's writes onto another environment). With `Facts.gateEnvScripts` an overlay whose `digest` is not its `allowed` one (the allowance of its hooks; a missing digest is no match) runs no env script, declared or default, and is reported `env-script-not-allowed` when it has one for the OS; the rest of it applies. `HookRun`, `HookOutput` and `FiredEvent` show no output text or value in `toJSON` or `util.inspect`.

## Gotchas

- Equal mapping keys are refused, and a validator names the **later** of two keys equal under case (`env-name-case-duplicate`), which needs the document's order, so mappings are `Map`s. A TOML table whose keys are canonical array indexes (`1`, `2`) is read in numeric order by the TOML parser, not the document's.
- A `Document` read from YAML, TOML and JSON is the same value; only the format line and `OVERLAY.md`'s front matter choose the parser.
- `readTree` and `treeDigest` are the only places the core asks for a file, and they are async because a caller's `FileSystem` may be. Everything else is synchronous, except `fetchPlanned`.
- Parsing is linear but not fast: YAML takes about 25 µs per line, so a document at the default 1 MiB bound takes seconds.
- The tests read the specification's vectors from `../vectors`, which are not in the package.
