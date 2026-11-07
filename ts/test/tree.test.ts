import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { defaultPaths, rulesOf } from "../src/defaults.ts";
import { readTree, treeDigest } from "../src/digest.ts";
import { AosError } from "../src/error.ts";
import type { FileKind, FileSystem, Metadata } from "../src/fs.ts";
import { Settings } from "../src/limits.ts";
import { NodeFs } from "../src/nodefs.ts";
import { readOverlay } from "../src/overlay.ts";
import { readDocument } from "../src/read.ts";
import { OverlayTree } from "../src/tree.ts";

const ENGINEERING: Array<[string, string]> = [
  ["overlay.cfg", 'name = "engineering"\ndescription = "How work is planned and committed."\n'],
  ["flows/PLAN.md", "# Plans\n\nOne file per plan.\n"],
  ["rules/commits.md", "- **Commits** are logical, one concern each.\n"],
];

const RUST: Array<[string, string]> = [
  ["overlay.cfg", 'requires = ["engineering"]\npriority = 600\n'],
  ["kb/RUST.md", "# Rust\n\nClippy with warnings denied.\n"],
  ["bin/check-all", "#!/bin/sh\ncargo clippy --all-targets\n"],
];

async function write(root: string, files: Array<[string, string]>): Promise<void> {
  for (const [path, text] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

async function within(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "aos-ts-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const settings = new Settings();

test("a directory gives its tree digest without the excluded names", () =>
  within(async (root) => {
    await write(root, ENGINEERING);
    await write(root, [
      [".git/HEAD", "ref: refs/heads/main\n"],
      ["lib/__pycache__/x.pyc", "x"],
    ]);
    const tree = await treeDigest(new NodeFs(), root, settings);
    assert.deepEqual([...tree.files.keys()], ["flows/PLAN.md", "overlay.cfg", "rules/commits.md"]);
    const manifest = readDocument(new Uint8Array(await readFile(join(root, "overlay.cfg"))), settings);
    assert.deepEqual(rulesOf(manifest, OverlayTree.fromPaths(tree.files.keys())), ["rules/commits.md"]);
  }));

test("a directory with a bin folder adds it to the path", () =>
  within(async (root) => {
    await write(root, RUST);
    const tree = await treeDigest(new NodeFs(), root, settings);
    const manifest = readDocument(new Uint8Array(await readFile(join(root, "overlay.cfg"))), settings);
    assert.equal(defaultPaths(manifest, OverlayTree.fromPaths(tree.files.keys()))[0]?.get("variable"), "PATH");
  }));

test("a changed file changes the tree digest", () =>
  within(async (root) => {
    await write(root, RUST);
    const digest = async (): Promise<string> => (await treeDigest(new NodeFs(), root, settings)).digest.toString();
    const before = await digest();
    await write(root, [["kb/RUST.md", "# Rust\n\nClippy with warnings denied!\n"]]);
    const edited = await digest();
    assert.notEqual(before, edited, "an edited file");
    await write(root, [["kb/NEW.md", "new\n"]]);
    const added = await digest();
    assert.notEqual(edited, added, "an added file");
    await rename(join(root, "kb/NEW.md"), join(root, "kb/OTHER.md"));
    assert.notEqual(added, await digest(), "a renamed file");
    const now = await digest();
    await mkdir(join(root, "empty/inner"), { recursive: true });
    await write(root, [["node_modules/x/index.js", "x\n"]]);
    assert.equal(now, await digest(), "an empty directory and an excluded one change nothing");
  }));

test("a tree past a limit is refused naming the limit", () =>
  within(async (root) => {
    await write(root, RUST);
    await assert.rejects(treeDigest(new NodeFs(), root, settings.with({ treeFiles: 2 })), (error: unknown) => {
      assert.ok(error instanceof AosError);
      assert.equal(error.class, "too-large");
      assert.ok(error.subject.includes("more than 2 files"), error.message);
      return true;
    });
    await assert.rejects(treeDigest(new NodeFs(), root, settings.with({ fileBytes: 4 })), (error: unknown) => {
      return error instanceof AosError && error.class === "too-large";
    });
  }));

/** A tree held in memory, so a link, a device and a name that is not UTF-8 can be had on every platform. */
class Memory implements FileSystem {
  readonly entries = new Map<string, { kind: FileKind; bytes: Uint8Array }>();

  with(path: string, kind: FileKind, bytes = ""): this {
    this.entries.set(path, { kind, bytes: new TextEncoder().encode(bytes) });
    return this;
  }

  metadata(path: string): Metadata {
    if (path === "/o") return { kind: "directory", len: 0 };
    const found = this.entries.get(path);
    if (found === undefined) throw new Error("not found");
    return { kind: found.kind, len: found.bytes.length };
  }

  read(path: string, max: number): Uint8Array {
    const found = this.entries.get(path);
    if (found === undefined) throw new Error("not found");
    return found.bytes.slice(0, max);
  }

  list(path: string): string[] {
    return [...this.entries.keys()].filter((candidate) => dirnameOf(candidate) === path).map((candidate) => candidate.slice(path.length + 1));
  }
}

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

async function refusal(run: () => Promise<unknown>): Promise<AosError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AosError) return error;
    throw error;
  }
  throw new Error("not refused");
}

test("a link in the tree is refused and never followed", async () => {
  const files = new Memory().with("/o/overlay.cfg", "file", 'name = "x"\n').with("/o/shortcut", "symlink");
  const error = await refusal(() => treeDigest(files, "/o", settings));
  assert.equal(error.class, "symlink");
  assert.equal(error.subject, "shortcut");
});

test("a device in the tree is refused", async () => {
  const error = await refusal(() => treeDigest(new Memory().with("/o/pipe", "other"), "/o", settings));
  assert.equal(error.class, "special-file");
});

test("a tree held in memory has the digest of the same files on disk", () =>
  within(async (root) => {
    await write(root, ENGINEERING);
    const onDisk = await treeDigest(new NodeFs(), root, settings);
    const files = new Memory();
    for (const [path, text] of ENGINEERING) files.with(`/o/${path}`, "file", text);
    files.with("/o/flows", "directory").with("/o/rules", "directory");
    assert.equal((await treeDigest(files, "/o", settings)).digest.toString(), onDisk.digest.toString());
  }));

test("a directory read whole is a tree a manifest can be read from", () =>
  within(async (root) => {
    await write(root, ENGINEERING);
    await write(root, [[".git/HEAD", "ref: refs/heads/main\n"]]);
    const { tree, digest } = await readTree(new NodeFs(), root, settings);
    assert.equal(digest.digest.toString(), (await treeDigest(new NodeFs(), root, settings)).digest.toString());
    assert.ok(tree.contains("flows/PLAN.md") && !tree.contains(".git/HEAD"));
    assert.equal(tree.text("rules/commits.md"), ENGINEERING[2]![1]);
    const read = readOverlay(tree, settings);
    assert.equal(read.manifestFile, "overlay.cfg");
    assert.equal(read.manifest.get("name"), "engineering");
  }));

/** A tree whose every directory lists the same names, so it is as deep as the walk goes. */
class Endless implements FileSystem {
  readonly names: Array<string | Uint8Array>;
  constructor(names: Array<string | Uint8Array>) {
    this.names = names;
  }
  metadata(): Metadata {
    return { kind: "directory", len: 0 };
  }
  read(): Uint8Array {
    return new Uint8Array(0);
  }
  list(): Array<string | Uint8Array> {
    return this.names;
  }
}

test("directories nested past the depth setting are refused, not followed", async () => {
  const error = await refusal(() => treeDigest(new Endless(["d"]), "/o", settings.with({ treeDepth: 5 })));
  assert.equal(error.class, "too-large");
  assert.ok(error.subject.includes("deeper than 5"), error.message);
});

test("a listed name that is not one path component is refused", async () => {
  for (const name of ["..", ".", "a/b", "a\\b", ""]) {
    const error = await refusal(() => treeDigest(new Endless([name]), "/o", settings));
    assert.equal(error.class, "invalid-name", JSON.stringify(name));
  }
});

test("a listed name that is not Unicode is refused", async () => {
  const error = await refusal(() => treeDigest(new Endless([new Uint8Array([0xff, 0x61])]), "/o", settings));
  assert.equal(error.class, "non-utf8-name");
});

test("empty directories count against the entry limit", async () => {
  const error = await refusal(() => treeDigest(new Endless(["a", "b"]), "/o", settings.with({ treeFiles: 3 })));
  assert.equal(error.class, "too-large");
});
