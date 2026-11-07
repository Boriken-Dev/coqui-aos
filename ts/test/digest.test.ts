import assert from "node:assert/strict";
import { type TreeEntry, digestEntries } from "../src/digest.ts";
import { AosError } from "../src/error.ts";
import { Source } from "../src/source.ts";
import { arr, bytesOf, decode64, obj, runFile, show, str, utf8 } from "./support.ts";
import type { Json } from "./support.ts";

runFile("digest.json", (item) => {
  const entries: Array<[Uint8Array[], TreeEntry]> = [];
  for (const entry of arr(item.get("tree"))) {
    const row = obj(entry);
    const encoded = row.get("path_base64");
    const path = typeof encoded === "string" ? decode64(encoded) : utf8(str(row.get("path")));
    const type = typeof row.get("type") === "string" ? str(row.get("type")) : "file";
    const parts: Uint8Array[] = [];
    let from = 0;
    for (let at = 0; at <= path.length; at += 1) {
      if (at === path.length || path[at] === 0x2f) {
        parts.push(path.subarray(from, at));
        from = at + 1;
      }
    }
    const kind: TreeEntry =
      type === "dir"
        ? { kind: "directory" }
        : type === "symlink"
          ? { kind: "symlink" }
          : type === "special"
            ? { kind: "special" }
            : { kind: "file", bytes: bytesOf(row) };
    entries.push([parts, kind]);
  }
  const expect = obj(item.get("expect"));
  try {
    const tree = digestEntries(entries);
    const lines = tree.lines().map((line) => new TextDecoder().decode(line));
    assert.equal(
      show({ digest: tree.digest.toString(), lines }),
      show({ digest: expect.get("digest"), lines: expect.get("lines") }),
      "digest",
    );
  } catch (error) {
    if (!(error instanceof AosError)) throw error;
    assert.equal(error.class, expect.get("error"), error.message);
  }
});

runFile("source.json", (item) => {
  const expect = obj(item.get("expect"));
  const hasError = expect.has("error");
  let source: Source | undefined;
  try {
    source = Source.parse(str(item.get("source")));
  } catch (error) {
    if (error instanceof AosError && hasError) return;
    throw error;
  }
  assert.ok(!hasError, `parsed ${source.shown()}`);
  const got = new Map<string, Json>([
    ["kind", source.kind],
    ["location", source.location],
    ["ref", source.reference ?? null],
    ["path", source.path ?? null],
  ]);
  assert.equal(show(Object.fromEntries([...got].sort())), show(Object.fromEntries([...expect].sort())));
});
