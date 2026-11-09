# `coqui_aos` (Dart) — API header

Header-file-style reference for the Dart package: every public item with its contract and gotchas, so it can be used without reading the source. It ships inside the package and is self-contained. Development documentation lives with the source at <https://github.com/Boriken-Dev/coqui-aos>.

Version `0.0.0-alpha.0`, `publish_to: none`, not published; the API may change in any release before 1.0. Dart 3.9 or later; pure Dart, no Flutter, no native code, no `dart:io` in the core, so it runs on the VM and on the web. Two entry points: `package:coqui_aos/coqui_aos.dart` (everything) and `package:coqui_aos/io.dart` (`IoFileSystem`, `currentOs()`; imports `dart:io`). Runtime dependencies: `yaml` (its parser's events show tags, anchors and aliases before anything is composed) and `crypto` (SHA-256). TOML and JSON are read by the package's own readers. Edition: AOS v0, `0.1.0-draft`. No process-wide state; nothing is printed; no environment variable is read.

Reading a manifest is static: nothing here runs a script, opens a connection or consults the environment. Files are read only by `readTree` and `treeDigest`, through the `FileSystem` they are given.

The names are the TypeScript package's, in Dart style: functions and fields are lowerCamelCase, constants too (`defaultKeys`), a TS `with` is `copyWith`. Closed sets of words are plain `String`s; each has a `Words` constant (`runtime`, `format`, `manifestFile`, `leftState`, `failStep`, `nonDefaultId`, `hookEvent`, `decision`, `onFailure`, `hookScope`, `hookFailure`, `plannedOrigin`, `catalogForm`, `iconFormat`, `entryRefusal`, `changes`, `phaseWords`, `issueCodes`) with `all`, `contains(word)` and `named(word)`. Sealed classes and records stand in for TS unions and tuples.

## Data model (`Value`, `Document`)

```dart
typedef Value = Object;                    // bool | BigInt | double | String | List<Object> | Document
typedef Document = Map<String, Object>;    // the document's order; any key, `__proto__` included
```

An integer is a `BigInt` in the signed 64-bit range and a float a finite `double`, so `30` is `BigInt.from(30)` and `30.0` is `30.0`: on the web a Dart `int` and a `double` are one JavaScript number, so integers are never `int`. `valuesEqual(a, b)` compares structurally (mapping order ignored, integer never equal to float). There is no null: a null is refused as `null-value`. Helpers: `isDocument`, `isList`, `isInteger`, `toPlain(value)` (integers that fit become `int`), `fromPlain(json)` (an `int` becomes an integer).

## Errors (`AosError`)

```dart
class AosError implements Exception { final String errorClass; final String subject; int? get line; int? get column; String get message }
const List<String> errorClasses;  String? classNamed(String word)
```

**`errorClass` is the contract**: a word from `errorClasses` (`'parse-error'`, `'duplicate-key'`, `'too-deep'`, `'symlink'`, `'undefined-variable'`, ...), including `'io'`, `'duplicate-member'`, `'invalid-requirements'` and `'invalid-digest'`. `subject` names what it is about for a person, never text from a document; do not match on it. `line` and `column` are one-based, `column` counts Unicode scalar values, a line counts from the file's first line, a format line included. `message` is `class: subject at line N column M`. A `subject` is escaped as the specification's conformance chapter writes it and cut to 256 characters. Subclasses: `Cycle` (`chain`; from `resolve` and `compose`), `PartialLock` (from `dependenciesOf` and `environments`), `HookFailed` (`failure`; from `hookResult`). A caller's `FileSystem` or `SkillSource` may throw anything; the core reports a file system's as `io`.

## Settings (`Settings`, `Limit`)

```dart
typedef Limit = int?;                      // null: no bound
class Settings { Settings([Map<String, Limit> changes]); factory Settings.fromData(Map<String, Object?> data);
  Settings copyWith(Map<String, Limit> changes); Map<String, Limit> values(); List<NonDefault> nonDefaults();
  Limit get manifestBytes, manifestDepth, treeFiles, treeDepth, treeBytes, fileBytes, contextBytes, catalogBytes, iconBytes, iconWidth, iconHeight, hookTimeout, hookEventTimeout, hookOutputBytes, hookPayloadBytes, hookReasonChars, substitutionBytes, substitutionDepth, substitutionSteps }
final Settings defaultSettings;  bool allows(Limit limit, Object n);  String limitText(Limit limit)
```

Immutable. `changes` are keyed by field name (`{'manifestDepth': null}` lifts a bound); an unknown name or a negative number is an `ArgumentError`. `fromData` takes snake_case keys with a number, `BigInt`, null or `"none"`. Defaults: 1 MiB, 64, 4096, 64, 64 MiB, 16 MiB, 1 MiB, 4 MiB, 512 KiB, 1024, 1024, 60 s, 120 s, 64 KiB, 1 MiB, 1024 characters, 1 MiB, 32, 10 000 000. Every limit has no floor; `nonDefaults()` reports what differs (`NonDefault(setting, value, byDefault)`), so report it. `manifest*` bound a manifest, an env file and an env script's output; `treeFiles` counts files and directories together; `treeDepth` counts directory levels. Lifting `manifestDepth` does not risk the stack: the JSON and TOML readers nest without recursion.

## Reading

```dart
Document readDocument(Uint8List data, Settings settings)
List<DotenvLine> parseDotenv(Uint8List data)                          // DotenvLine(name, text, literal)
List<(String, String)> readDotenv(Uint8List data, Environment env)    // substituted against env, in order
List<(String, String?)> readEnvScriptOutput(Uint8List data, Settings settings)   // null unsets
Split splitFrontMatter(Uint8List data, Settings settings);  FrontMatter readFrontMatter(Uint8List data, Settings settings);  Uint8List contextFileText(Uint8List data, Settings settings)
OverlayRead readOverlay(OverlayTree tree, Settings settings)
```

`readDocument`: one optional byte-order mark, an optional format line (`#!json`, `#!/usr/bin/env yaml`), else TOML. **Dialect**: a duplicate key in one mapping, a null, a TOML date or time, a non-finite float, an integer outside the signed 64-bit range, a mapping key that is not text, a lone surrogate escape and a byte-order mark where the text starts are refused. In YAML a plain scalar is typed by the 1.2 core schema (`yes` is text), and a tag, anchor, alias, merge key (`<<` in any style), `%YAML`/`%TAG` directive and a second document are refused from the parser's events, before anything is composed. TOML is 1.0 (a newline in an inline table is a `parse-error`). Nesting past `manifestDepth` is `too-deep` in every format.

`Split` (`splitCase`, `metadata`, `metadataOffset`, `metadataLine`, `bodyOffset`, `bodyLine`, `body(data)`) divides bytes unchanged; offsets are bytes, lines from 1. `FrontMatter` (`frontMatterCase`: `none | malformed | unterminated | too-large | empty | unknown-format | does-not-parse | not-a-mapping | mapping`, `data`, `error`, `format`, `bodyOffset`, `bodyLine`): `error` is what a gate refuses with, the case what a viewer shows. `OverlayRead` holds `manifestFile`, `manifest`, `context`, `contextIgnored`, `issues` and `harnessContext`; it refuses two manifests (`two-manifests`), a manifest that does not read, and a context past `contextBytes` or not UTF-8.

## Validation

```dart
List<Issue> validate(Document manifest, [OverlayTree? tree])    // Issue(code, at): at is an RFC 6901 pointer; sorted by pointer
bool applies(List<Issue> issues)                                 // only problems under /about leave a manifest applying
List<(String, String)> namedFiles(Document doc);  List<String> skillFlags(Document doc, OverlayTree tree);  bool validLicense(String expression)
```

With a tree, the files a field names must be in it. The `hooks` field's files are checked, not run.

## Names, sources, digests

```dart
bool validOverlayName(String), String normalizeName(String), rootVariable, stateVariable, bool validRelativePath, isVariableName, isReservedVariable, isSensitiveVariable
class Source { final String kind; location; reference; path;  factory Source.parse(String text);  shown(); toString(); isLocal(); holdsCredentials(); isWebUrl() }
class Digest { factory Digest.of(Uint8List); factory Digest.parse(String); equals(Digest); toString() }     // `sha256:<64 hex>`
TreeDigest digestEntries(Iterable<(List<Object>, TreeEntry)> entries)   // order does not matter; a path twice is `duplicate-member`
Future<TreeDigest> treeDigest(FileSystem files, String root, Settings settings)
Future<({OverlayTree tree, TreeDigest digest})> readTree(FileSystem files, String root, Settings settings)
sealed class TreeEntry { FileEntry(bytes), DirectoryEntry(), SymlinkEntry(), SpecialEntry() }
class TreeDigest { final Digest digest; final Map<String, Digest> files; List<Uint8List> lines() }
```

`Source.kind` is `git`, `url` or `directory`. `Source` hides user information and query in `shown()`, `toString()` and `toJson()`; `location` and `keyWith()` hold them, so never print those. Non-canonical IPv4 hosts (`127.1`, `2130706433`, `0x7f.0.0.1`) are classified as the address a URL parser reads, and `100.64.0.0/10` is private. Case folding of identities, variables and sensitivity is ASCII only; substitution's `^^` and `,,` fold by Unicode rules, with the SpecialCasing mappings that Dart's `toUpperCase` lacks.

## The filesystem (`FileSystem`, `IoFileSystem`)

```dart
abstract interface class FileSystem {
  FutureOr<Metadata> metadata(String path);             // WITHOUT following a link: a link is FileKind.symlink
  FutureOr<Uint8List> read(String path, int max);       // the first `max` bytes
  FutureOr<List<Object>> list(String path);             // single components, any order; non-Unicode names as Uint8List
}
enum FileKind { file, directory, symlink, other };  class Metadata { final FileKind kind; final int len }
class IoFileSystem implements FileSystem               // package:coqui_aos/io.dart
String currentOs()                                     // package:coqui_aos/io.dart: windows, macos, linux, ...
```

The core joins a root and a name with `/` (`joinPath`). `treeDigest` checks every entry with `metadata` before it reads or descends, and refuses a listed name that is empty, `.`, `..` or holds `/`, `\` or NUL, and a name that is not Unicode (`non-utf8-name`). `IoFileSystem.read` and `list` open through links: a link swapped in between `metadata` and `read` is followed, so read only trees no one else can write.

## What an overlay's files contribute

```dart
class OverlayTree { OverlayTree.fromPaths(paths), .fromTexts(Iterable<(String, String)>), .fromBytes(...), .empty();  withText(path, text), withBytes(path, bytes);  paths(), members(), contains, hasMember(path), text(path), bytes(path) }
rulesOf, contextOf, pathsOf, envFilesOf, skillsOf(manifest, tree), defaultPaths, defaultOn(manifest, key), contextIgnored, harnessContextOf(manifest, harness, tree)
List<SkillEntry> skillEntries(Document manifest, OverlayTree tree)         // SkillEntry(name, origin, source, key, pin, from)
List<Dependency> dependenciesOf(Document manifest, OverlayTree tree, String os)   // throws PartialLock
void checkRequirements(String text, bool locked)                           // `invalid-requirements`; never quotes the line
```

`OverlayTree` is immutable. `withText` ignores a path the tree does not hold; `withBytes` adds it. The body of `OVERLAY.md` is the context default when its text was read into the tree.

## Composition and the environment

```dart
Resolution resolve(Map<String, Document> overlays, requested);  List<String> compositionOrder(overlays, active)     // throw Cycle
Composition compose(Map<String, Document> overlays, requested, Map<String, OverlayTree> trees)
Environments environments(overlays, active, trees, String os, List<String> removed)     // throws `partial-lock`; a name with no manifest is skipped
Effective effective(Document manifest, Facts facts)
class Facts { Facts(String os);  copyWith(...);  mutable fields os, root, identity, state, pinned, baseEnv, hostEnv, grants, secrets, secretFiles, providers, providerValues, enforcesNetwork, envScriptsEnabled, interpreters, packages, tree, settings }
class Environment { Environment([Iterable<(String, String)> base, bool windows]);  settings(s), get, set(name, value, secret), unset, values(), isSecret, clone }
ComposedEnvironment composedEnvironment(List<(Document, Facts)> active, Environment base, Map<String, HookRun> preEnv, List<NonDefaultSetting> nonDefaults)
Preparation preparation(change, record, digest, setup, dependencies, fails);  String? setupPhase(change, recorded, digest)
String substitute(String text, Lookup lookup);  String substituteWith(String text, Lookup lookup, Settings settings)
```

`Facts.copyWith` treats a null argument as "keep"; to clear a nullable field, copy and assign. `Effective` holds `ungranted`, `supported`, `env`, `envScripts`, `setup`, `python`, `node`, `dependencies`, `needs` and `nonDefaults` (`NonDefaultSetting(id, subject)`: the spec's reports such as `unpinned` and `env-sensitive`, never a value). An `Environment` never lets a placeholder read a variable that holds a resolved secret. Substitution refuses `too-large`, `too-deep` and `too-complex` past `substitution*`; a placeholder's variable or pattern is never quoted. A lookup may throw an `AosError`.

## Catalogs and icons

```dart
Catalog readCatalog(Uint8List data, String name, String? base, Settings settings);  Document readCatalogDocument(Uint8List data, String name, Settings settings)
String? catalogFormat(String name);  Listing listCatalogs(List<(String, Catalog)> catalogs);  ListedEntry chooseListed(Listing listing, requested)
Icon readIcon(Uint8List data, String name, Settings settings)      // Icon(format, width, height), judged from the header alone
```

`name` is the catalog's file name, whose extension picks the format; `base` is the source string it came from. A refused entry is listed in `refused` by name. A `description` is a stranger's text: do not render it as markup. Nothing is fetched.

## Skills from elsewhere, and hooks

```dart
SkillPlan resolveSkills(overlays, requested, trees, catalogs, List<String> order, bool fetches, Settings settings)     // SkillPlan.toFetch: what to fetch
FetchedSkill readFetchedSkill(String name, List<(String, Uint8List)> files, String? pin, Settings settings)     // FetchedSkill(digest, reported, files)
abstract interface class SkillSource { FutureOr<List<(String, Uint8List)>> fetch(Source source) }
Future<List<FetchedPlanned>> fetchPlanned(SkillPlan plan, SkillSource fetcher, Settings settings)     // one at a time; FetchedPlanned.ok, .skill, .error
hooksOf, HookPlan hookPlan(Document manifest, files, HookFacts facts, Settings settings);  hookMatches, hookPayload, readHookOutput, HookOutput hookResult(event, HookRun run, Settings settings);  FiredEvent fireEvent(event, runs, applies, settings, windows)
HookRun hookRun(String source, [Uint8List? stdout])        // fields: exit, seconds, timedOut, notRun, payloadSize, sets, onFailure
```

The core decides what to fetch and checks what came back, pin first, so nothing unverified is parsed; it holds no network. Running a hook is the caller's: it builds a `HookRun` from what the process did and the core checks it in a fixed order (started, payload, time, size, exit, output), combines the runs of one event to the tightest decision and reports what could not be applied. `FetchedSkill.files` are the paths the digest covers: write those and nothing else, since the digest leaves out entries under an excluded name (`node_modules`, `__pycache__`, `*.pyc`, `.git`). A `pre-env` hook's output is read exactly as an env script's. A hook is off until the user allows it at the overlay's digest (`HookFacts.allowed`); `HookPlan.activates` is false for a guard that is off.

## Gotchas

- JSON decoded as `Map<String, Object?>` is not a `Document` at run time (`is Map<String, Object>` fails): build documents with the readers, or copy with `fromPlain`.
- Equal mapping keys are refused, and a validator names the **later** of two keys equal under case (`env-name-case-duplicate`), so mappings keep insertion order.
- `readTree` and `treeDigest` are the only places the core asks for a file, and they are `Future`s because a caller's `FileSystem` may be. Everything else is synchronous, except `fetchPlanned`.
- The YAML parser's cost grows with the square of flow nesting, so a document with flow collections nested past `manifestDepth` is refused before it is scanned.
- The tests read the specification's vectors from `../vectors`, which are not in the package.
