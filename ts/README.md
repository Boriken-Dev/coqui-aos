# coqui-aos (TypeScript)

[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](https://github.com/Boriken-Dev/coqui-aos/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](https://nodejs.org/)

**The Agent Overlay Specification (AOS) in pure TypeScript:** read an overlay's manifest, validate it, hash a tree, compose overlays and build the environment they ask for. No wasm, no native addon, no build step to run it from source. The core reads no file itself, so it runs in a browser wherever you supply the files; `NodeFs` is the one module that needs Node.

This is the TypeScript implementation of [coqui-aos](https://github.com/Boriken-Dev/coqui-aos). It passes every one of the specification's conformance vectors in `../vectors/`, none skipped, the same ones the Rust and Python implementations pass.

## Installation

Not published. The package is `private` and named `coqui-aos`, an unscoped working name: npm needs a verified scope before anything is published, and none has been named yet. Until then, use it from a checkout:

```sh
cd ts
npm ci
npm run build   # dist/: JavaScript and .d.ts, from a plain tsc
```

Node 22.18 or later runs `src/` directly by type stripping, with no build (`node --test "test/*.test.ts"` does). The published form is the `tsc` output in `dist/` instead, because Node does not strip types from files under `node_modules`. The declaration files keep `.ts` import specifiers, which TypeScript resolves to the declarations beside them.

Runtime dependencies: `yaml` (a YAML 1.2 parser whose tokens expose tags, anchors and aliases before anything is composed), `smol-toml` (TOML 1.0, integers as `bigint`) and `@noble/hashes` (SHA-256 that is synchronous and runs in a browser).

## Quick start

```ts
import { Settings, readDocument, validate } from "coqui-aos";

const manifest = readDocument(new TextEncoder().encode('name = "docs"\npriority = 450\n'), new Settings());
console.log(manifest.get("priority")); // 450n: an integer is a bigint, a float a number
console.log(validate(manifest).length); // 0
```

Reading a directory through `node:fs`:

```ts
import { Settings, readOverlay, readTree } from "coqui-aos";
import { NodeFs } from "coqui-aos/node";

const settings = new Settings();
const { tree, digest } = await readTree(new NodeFs(), "/path/to/overlay", settings);
const overlay = readOverlay(tree, settings);
console.log(digest.digest.toString(), overlay.issues);
```

## API overview

| Area | Start with |
| --- | --- |
| Reading | `readDocument`, `readFrontMatter`, `readOverlay`, `parseDotenv`, `readEnvScriptOutput` |
| Validation | `validate`, `applies`, `namedFiles`, `skillFlags` |
| Trees and digests | `OverlayTree`, `FileSystem`, `readTree`, `treeDigest`, `digestEntries`, `Digest` |
| Composition | `resolve`, `compose`, `environments`, `effective`, `Facts`, `Environment`, `preparation` |
| Catalogs, skills, hooks | `readCatalog`, `listCatalogs`, `resolveSkills`, `fetchPlanned`, `hookPlan`, `fireEvent` |
| Bounds | `Settings`, `Settings.nonDefaults()` |

[`AGENTS.md`](AGENTS.md) is the API header: every public item with its contract and gotchas.

## Development

```sh
npm ci
npm run typecheck   # tsc --noEmit, strict
npm test            # node --test --test-timeout=300000 over ../vectors/ and the tests beside them
npm run build
```

Source is erasable TypeScript only (no enums, namespaces or parameter properties), so type stripping can run it.

## License

MPL-2.0, see [LICENSE](../LICENSE).
