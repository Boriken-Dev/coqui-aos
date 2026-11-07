import assert from "node:assert/strict";
import { test } from "node:test";
import { OverlayTree } from "../src/tree.ts";
import { applies, namedFiles, skillFlags, validLicense, validate } from "../src/validate.ts";
import { fromPlain } from "../src/value.ts";
import type { Document } from "../src/value.ts";
import { arr, obj, runFile, str, strings } from "./support.ts";
import type { Json } from "./support.ts";

runFile("validation.json", (item) => {
  const document = obj(item.get("document")) as unknown as Document;
  const files = item.get("files");
  const tree = Array.isArray(files) ? OverlayTree.fromPaths(strings(files)) : undefined;
  const issues = validate(document, tree);
  const expect = obj(item.get("expect"));
  const flags = expect.get("flags");
  if (flags !== undefined && tree !== undefined) {
    const got = skillFlags(document, tree);
    if (JSON.stringify(got) !== JSON.stringify(arr(flags))) throw new Error(`flags ${got}, expected ${arr(flags)}`);
  }
  const wanted = expect.get("applies");
  if (typeof wanted === "boolean" && applies(issues) !== wanted) {
    throw new Error(`applies ${applies(issues)}, issues ${JSON.stringify(issues)}`);
  }
  if (expect.get("valid") === true) {
    if (issues.length !== 0) throw new Error(JSON.stringify(issues));
    return;
  }
  const at = str(expect.get("at"));
  const cls = expect.get("class");
  if (typeof cls === "string" && !issues.some((issue) => issue.at === at && issue.code === cls)) {
    throw new Error(`no ${cls} at ${at}: ${JSON.stringify(issues)}`);
  }
  const near = issues.some(
    (issue) => issue.at === at || issue.at.startsWith(`${at}/`) || (issue.at !== "" && at.startsWith(`${issue.at}/`)),
  );
  if (!near) throw new Error(`nothing at ${at}: ${JSON.stringify(issues)}`);
});

const manifest = (plain: unknown): Document => fromPlain(plain) as Document;

test("a pointer names a key with a slash by the escaped token", () => {
  const at = validate(manifest({ env: { "a/b": "x" } })).map((issue) => issue.at);
  assert.ok(at.includes("/env/a~1b"), String(at));
  assert.ok(!at.includes("/env/a/b"), String(at));
});

test("a float where an integer is required is integer-required, a bigint in range is fine", () => {
  const floaty = new Map<string, Json>([["priority", 3.0]]) as unknown as Document;
  assert.deepEqual(validate(floaty), [{ at: "/priority", code: "integer-required" }]);
  assert.deepEqual(validate(manifest({ priority: 3 })), []);
});

test("only a problem under /about leaves a manifest applying", () => {
  assert.equal(applies(validate(manifest({ about: { summary: "" } }))), true);
  assert.equal(applies(validate(manifest({ name: 1 }))), false);
  assert.equal(applies([]), true);
});

test("issues are sorted and without repeats", () => {
  const issues = validate(manifest({ skills: ["a b", "a b"], name: 1 }));
  const keys = issues.map((issue) => `${issue.at} ${issue.code}`);
  assert.deepEqual(keys, [...new Set(keys)].sort());
});

test("license expressions nest to 128 parentheses and no further", () => {
  const nested = (depth: number): string => `${"(".repeat(depth)}MIT${")".repeat(depth)}`;
  assert.equal(validLicense(nested(128)), true);
  assert.equal(validLicense(nested(129)), false);
  assert.equal(validLicense("MIT OR (Apache-2.0 WITH LLVM-exception)"), true);
  assert.equal(validLicense("MIT or Apache-2.0"), false);
  assert.equal(validLicense(""), false);
});

test("a hostile license of a million parentheses is refused without overflowing", () => {
  assert.equal(validLicense("(".repeat(1_000_000)), false);
});

test("named files are listed with their pointers", () => {
  const doc = manifest({ rules: ["r.md"], hooks: { cd: { run: "h.py" } }, about: { icon: "i.png" } });
  assert.deepEqual(namedFiles(doc), [
    ["/rules/0", "r.md"],
    ["/hooks/cd/run", "h.py"],
    ["/about/icon", "i.png"],
  ]);
});
