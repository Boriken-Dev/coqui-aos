// What a host builds on: the setup record's JSON spelling, `hooksDeclared`, and the setting a
// limit's refusal names.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readCatalogDocument, readIcon } from "../src/catalog.ts";
import { treeDigest } from "../src/digest.ts";
import { AosError } from "../src/error.ts";
import { HOOK_EVENTS, hooksDeclared, hooksOf } from "../src/hooks.ts";
import { INTERPRETERS } from "../src/defaults.ts";
import { Settings } from "../src/limits.ts";
import { NodeFs } from "../src/nodefs.ts";
import { readOverlay } from "../src/overlay.ts";
import { phase, setupRecordFromJson, setupRecordToJson } from "../src/prepare.ts";
import { readDocument } from "../src/read.ts";
import { substituteWith } from "../src/subst.ts";
import { OverlayTree } from "../src/tree.ts";
import type { Document } from "../src/value.ts";
import { toJson } from "./g2_support.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const manifest = (plain: unknown): Document => toJson(plain) as Document;
const tree = (...paths: string[]): OverlayTree => OverlayTree.fromPaths(paths);

function refused(run: () => unknown, cls: string, setting: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof AosError);
    assert.equal(error.class, cls, String(error));
    assert.equal(error.setting, setting, String(error));
    return true;
  });
}

test("a phase is read from its name", () => {
  assert.equal(phase.named("install"), "install");
  assert.equal(phase.named("Install"), undefined);
  assert.equal(phase.named(""), undefined);
});

test("a record is written as digest and phase, and read back", () => {
  const record = { digest: "sha256:ab", phase: "sync" } as const;
  assert.deepEqual(setupRecordToJson(record), { digest: "sha256:ab", phase: "sync" });
  assert.deepEqual(setupRecordFromJson(setupRecordToJson(record)), record);
  assert.deepEqual(setupRecordFromJson(JSON.parse('{"digest":"d","phase":"remove"}')), { digest: "d", phase: "remove" });
});

test("a record that does not read is refused", () => {
  for (const bad of [
    { digest: "sha256:ab", phase: "later" },
    { digest: "sha256:ab", phase: "Sync" },
    { digest: "sha256:ab" },
    { phase: "sync" },
    { digest: 1, phase: "sync" },
    "sync",
    null,
  ]) {
    assert.throws(() => setupRecordFromJson(bad), TypeError, JSON.stringify(bad));
  }
});

test("an overlay with no hooks declares none", () => {
  assert.equal(hooksDeclared(manifest({}), tree("SKILL.md")), false);
  assert.equal(hooksDeclared(manifest({ hooks: {} }), tree()), false);
  const off = Object.fromEntries(HOOK_EVENTS.map((event) => [event, false]));
  assert.equal(hooksDeclared(manifest({ hooks: off }), tree("hook.sh")), false);
  assert.equal(hooksDeclared(manifest({ defaults: { hooks: false } }), tree("hook.py")), false);
});

test("a default script declares a hook whatever its os", () => {
  for (const script of ["hook.sh", "hook.bash", "hook.ps1", "hook.py", "hook.js"]) {
    assert.equal(hooksDeclared(manifest({}), tree(script)), true, script);
  }
});

test("a table entry declares a hook", () => {
  assert.equal(hooksDeclared(manifest({ hooks: { "pre-tool": { run: "guard.py" } } }), tree("guard.py")), true);
  assert.equal(hooksDeclared(manifest({ hooks: { prompt: "guard.ps1" } }), tree("guard.ps1")), true);
});

test("hooksDeclared agrees with hooksOf on every os", () => {
  const cases: Array<[unknown, string[]]> = [
    [{}, ["hook.ps1"]],
    [{ hooks: { cd: { run: "x.sh" } } }, []],
    [{ hooks: { cd: false } }, ["hook.sh"]],
  ];
  for (const [plain, paths] of cases) {
    const overlay = tree(...paths);
    const document = manifest(plain);
    const anywhere = ["windows", "linux", "macos"].some((os) => {
      const found = hooksOf(document, overlay, os, INTERPRETERS);
      return found.hooks.length > 0 || found.notRun.length > 0;
    });
    assert.equal(hooksDeclared(document, overlay), anywhere, JSON.stringify(plain));
  }
});

test("a manifest past its bytes names manifest_bytes", () => {
  refused(() => readDocument(bytes('name = "longer than eight"\n'), new Settings({ manifestBytes: 8 })), "too-large", "manifest_bytes");
});

test("a manifest past its depth names manifest_depth in every format", () => {
  for (const text of ["a = [[[1]]]\n", '#!json\n{"a": {"b": {"c": 1}}}\n', "#!yaml\na: [[[1]]]\n"]) {
    refused(() => readDocument(bytes(text), new Settings({ manifestDepth: 2 })), "too-deep", "manifest_depth");
  }
});

test("a catalog past its bytes names catalog_bytes", () => {
  for (const name of ["catalog.json", "CATALOG.aos"]) {
    refused(() => readCatalogDocument(bytes(" ".repeat(64)), name, new Settings({ catalogBytes: 8 })), "too-large", "catalog_bytes");
  }
});

test("a context body past its bytes names context_bytes", () => {
  const overlay = OverlayTree.fromTexts([["OVERLAY.md", `---\nname: x\n---\n${"Body.\n".repeat(10)}`]]);
  refused(() => readOverlay(overlay, new Settings({ contextBytes: 16 })), "too-large", "context_bytes");
});

test("an icon past its bytes or size names the setting", () => {
  const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 16, 0, 0, 0, 16]);
  refused(() => readIcon(data, "a.png", new Settings({ iconBytes: 8 })), "icon-too-large", "icon_bytes");
  refused(() => readIcon(data, "a.png", new Settings({ iconWidth: 8 })), "icon-dimensions", "icon_width");
  refused(() => readIcon(data, "a.png", new Settings({ iconHeight: 8 })), "icon-dimensions", "icon_height");
});

test("a substitution past its limits names the setting", () => {
  const nothing = (): string | undefined => undefined;
  refused(() => substituteWith("${U:-${V:-${W:-x}}}", nothing, new Settings({ substitutionDepth: 1 })), "too-deep", "substitution_depth");
  refused(() => substituteWith("${U:-xxxxxxxxxxxx}", nothing, new Settings({ substitutionBytes: 4 })), "too-large", "substitution_bytes");
  refused(() => substituteWith("${A//*z/}", () => "a".repeat(2000), new Settings({ substitutionSteps: 100 })), "too-complex", "substitution_steps");
});

test("a tree past its limits names the setting", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-limits-"));
  try {
    for (const path of ["a/b/c.md", "d.md"]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "twelve bytes");
    }
    for (const [change, setting] of [
      [{ treeFiles: 2 }, "tree_files"],
      [{ treeDepth: 1 }, "tree_depth"],
      [{ fileBytes: 4 }, "file_bytes"],
      [{ treeBytes: 13 }, "tree_bytes"],
    ] as const) {
      await assert.rejects(treeDigest(new NodeFs(), root, new Settings(change)), (error: unknown) => {
        assert.ok(error instanceof AosError);
        assert.equal(error.class, "too-large");
        assert.equal(error.setting, setting, String(error));
        return true;
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a refusal that is no limit names none", () => {
  assert.throws(
    () => readDocument(bytes("a = = 1\n"), new Settings()),
    (error: unknown) => error instanceof AosError && error.setting === undefined,
  );
});
