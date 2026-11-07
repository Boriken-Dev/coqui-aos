import assert from "node:assert/strict";
import { test } from "node:test";
import { effective } from "../src/apply.ts";
import { Cycle, compose } from "../src/compose.ts";
import { PartialLock } from "../src/defaults.ts";
import { Facts } from "../src/environment.ts";
import { AosError } from "../src/error.ts";
import { HookFailed, hookPlan, hookFacts, hookResult, hookRun, readHookOutput } from "../src/hooks.ts";
import { Settings, allows } from "../src/limits.ts";
import { readDocument } from "../src/read.ts";
import { readFetchedSkill } from "../src/skills.ts";
import { OverlayTree } from "../src/tree.ts";
import { validate } from "../src/validate.ts";
import type { Document, Value } from "../src/value.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const settings = new Settings();
const map = (entries: Array<[string, Value]>): Document => new Map(entries);

function refusal(run: () => unknown): AosError {
  try {
    run();
  } catch (error) {
    if (error instanceof AosError) return error;
    throw error;
  }
  throw new Error("not refused");
}

test("a hook's output with a long run of blanks is read in linear time", () => {
  const started = Date.now();
  const text = `{"decision": "block", "reason": "x"}${" ".repeat(200_000)}y`;
  assert.throws(() => readHookOutput("prompt", bytes(text), [], settings), HookFailed);
  assert.ok(Date.now() - started < 2000);
});

test("a fetched skill lists the files its pin covers, not the excluded entries it carries", () => {
  const skill = bytes("---\nname: s\ndescription: d\n---\nbody\n");
  const pin = readFetchedSkill("s", [["SKILL.md", skill]], undefined, settings).digest.toString();
  for (const extra of ["node_modules/x/index.js", "__pycache__/a.pyc", "lib/a.pyc", ".git/HEAD"]) {
    const files: Array<[string, Uint8Array]> = [["SKILL.md", skill], ["docs/a.md", bytes("x")], [extra, bytes("x")]];
    const withDocs = readFetchedSkill("s", [["SKILL.md", skill], ["docs/a.md", bytes("x")]], undefined, settings).digest.toString();
    const got = readFetchedSkill("s", files, withDocs, settings);
    assert.deepEqual(got.files, ["SKILL.md", "docs/a.md"], extra);
  }
  assert.deepEqual(readFetchedSkill("s", [["SKILL.md", skill]], pin, settings).files, ["SKILL.md"]);
});

test("pre-env output keeps what the vectors accept: undeclared variables are read", () => {
  assert.deepEqual(readHookOutput("pre-env", bytes('{"LD_PRELOAD": "/x"}'), [], settings).env, [["LD_PRELOAD", "/x"]]);
});

test("pre-env output with a control character is refused", () => {
  assert.throws(() => readHookOutput("pre-env", bytes('{"A": "\u001b[2J"}'), ["A"], settings), { failure: "output" });
});

test("effective refuses a path that leaves the overlay and a name that is not a variable", () => {
  const facts = new Facts("linux", { identity: "x", root: "/o" });
  const escaping = map([["env", map([["P", map([["path", "../../../etc"]])]])]]);
  assert.equal(refusal(() => effective(escaping, facts)).class, "invalid-reference");
  const badName = map([["env", map([["BAD NAME=\n", "v"]])]]);
  assert.equal(refusal(() => effective(badName, facts)).class, "invalid-reference");
});

test("validate and effective tolerate any shape", () => {
  const facts = new Facts("linux", { identity: "x", root: "/o" });
  for (const doc of [map([["env", 1n]]), map([["paths", "x"]]), map([["runtime", [1n]]]), map([["env", [map([])]]])]) {
    assert.ok(Array.isArray(validate(doc)));
    try {
      effective(doc, facts);
    } catch (error) {
      assert.ok(error instanceof AosError, String(error));
    }
  }
});

test("settings read from a Map, with bigint numbers, and name no unknown key's text", () => {
  const read = readDocument(bytes("manifest_bytes = 10\ntree_depth = \"none\"\n"), settings);
  const loaded = Settings.fromData(read);
  assert.equal(loaded.manifestBytes, 10);
  assert.equal(loaded.treeDepth, null);
  try {
    Settings.fromData({ "evil\u001b[2Jkey": 1 });
    assert.fail("accepted");
  } catch (error) {
    assert.ok(error instanceof RangeError);
    assert.ok(!error.message.includes("evil") && !error.message.includes("\u001b"), error.message);
  }
});

test("a negative or NaN count is never within a limit", () => {
  assert.equal(allows(5, -1), false);
  assert.equal(allows(5, Number.NaN), false);
  assert.equal(allows(null, -1), false);
  assert.equal(allows(5, 5), true);
  assert.equal(allows(5, 5n), true);
});

test("every thrown refusal is an AosError with a class", () => {
  const cycle = refusal(() => {
    const a = map([["requires", ["b"]]]);
    const b = map([["requires", ["a"]]]);
    compose(new Map([["a", a], ["b", b]]), ["a"], new Map());
  });
  assert.ok(cycle instanceof Cycle && cycle.class === "cycle" && cycle.chain.length > 0);
  assert.ok(refusal(() => hookResult("prompt", Object.assign(hookRun("x"), { exit: 1 }), settings)) instanceof HookFailed);
  const lock = new PartialLock("r.txt");
  assert.ok(lock instanceof AosError && lock.class === "partial-lock");
});

test("an error's position cannot be assigned from outside", () => {
  const error = new AosError("parse-error", "x").at(2, 3);
  assert.equal(error.line, 2);
  assert.throws(() => {
    (error as { line: number | undefined }).line = 9;
  }, TypeError);
  assert.equal(error.line, 2);
});

test("hookPlan leaves the manifest's hooks alone", () => {
  const manifest = map([["hooks", [map([["event", "prompt"], ["run", "hooks/p.sh"], ["timeout", 500n]])]]]);
  const tree = OverlayTree.fromTexts([["hooks/p.sh", "x"]]);
  const before = hookPlan(manifest, tree, hookFacts("linux", "x"), settings).hooks.map((hook) => hook.timeout);
  const again = hookPlan(manifest, tree, hookFacts("linux", "x"), settings).hooks.map((hook) => hook.timeout);
  assert.deepEqual(before, again);
});

test("validate does not overflow the stack on a deep caller-built list", () => {
  let deep: Value = "x";
  for (let level = 0; level < 200_000; level += 1) deep = [deep];
  assert.ok(Array.isArray(validate(map([["env", map([["A", deep]])]]))));
});
