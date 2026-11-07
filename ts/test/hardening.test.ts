import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { inspect } from "node:util";
import { test } from "node:test";
import { PartialLock, checkRequirements } from "../src/defaults.ts";
import { Digest, digestEntries } from "../src/digest.ts";
import { AosError } from "../src/error.ts";
import { Settings } from "../src/limits.ts";
import { readDocument, readEnvScriptOutput } from "../src/read.ts";
import { Source } from "../src/source.ts";
import { substitute, substituteWith } from "../src/subst.ts";
import { parseVectorJson, obj, str } from "./support.ts";

const settings = new Settings();
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function refusal(run: () => unknown): AosError {
  try {
    run();
  } catch (error) {
    if (error instanceof AosError) return error;
    throw error;
  }
  throw new Error("not refused");
}

const lookup =
  (values: Record<string, string> = {}) =>
  (name: string): string | undefined =>
    Object.hasOwn(values, name) ? values[name] : undefined;

test("an env script's output is held to the depth setting", () => {
  const tight = settings.with({ manifestDepth: 3 });
  assert.equal(refusal(() => readEnvScriptOutput(bytes('{"A": [[[[[[]]]]]]}'), tight)).class, "too-deep");
  assert.deepEqual(readEnvScriptOutput(bytes('{"A": "b"}'), tight), [["A", "b"]]);
});

test("an unclosed expression repeated is refused quickly", () => {
  const started = Date.now();
  assert.equal(refusal(() => substitute("${".repeat(200_000), lookup())).class, "too-complex");
  assert.ok(Date.now() - started < 10_000);
});

test("a refused requirements line is never quoted", () => {
  const error = refusal(() => checkRequirements("--index-url https://user:SECRET@host/simple\n", false));
  assert.equal(error.class, "invalid-requirements");
  assert.equal(error.line, 1);
  assert.ok(!`${inspect(error)} ${error.message}`.includes("SECRET"));
});

test("a source's inspected output shows no credential", () => {
  const source = Source.parse("https://user:SECRET@example.org/x.git?token=QUERY");
  for (const shown of [inspect(source), String(source), JSON.stringify(source)]) {
    assert.ok(!shown.includes("SECRET") && !shown.includes("QUERY"), shown);
  }
  assert.ok(source.holdsCredentials());
});

test("a TOML refusal quotes nothing from the document", () => {
  const error = refusal(() => readDocument(bytes('password = "hunter2"\n= 1\n'), settings));
  assert.equal(error.class, "parse-error");
  assert.ok(!`${inspect(error)} ${error.message}`.includes("hunter2"));
  assert.notEqual(error.line, undefined);
});

test("a YAML refusal quotes nothing from the document", () => {
  for (const text of ["#!yaml\npassword: !!str hunter2\n", "#!yaml\npassword: &hunter2 x\n", "#!yaml\n[hunter2\n"]) {
    const error = refusal(() => readDocument(bytes(text), settings));
    assert.ok(!`${inspect(error)} ${error.message}`.includes("hunter2"), text);
  }
});

test("a member listed twice is refused", () => {
  const entries = [
    [[bytes("a")], { kind: "file", bytes: bytes("1") }],
    [[bytes("a")], { kind: "file", bytes: bytes("2") }],
  ] as const;
  assert.equal(refusal(() => digestEntries(entries)).class, "duplicate-member");
});

test("a digest read back is the same whatever its case", () => {
  const upper = `sha256:${"AB".repeat(32)}`;
  assert.equal(Digest.parse(upper).toString(), Digest.parse(upper.toLowerCase()).toString());
  assert.ok(Digest.parse(upper).equals(Digest.parse(upper.toLowerCase())));
  for (const bad of ["", "sha256:", `sha256:${"a".repeat(63)}`, `md5:${"a".repeat(64)}`, `sha256:${"g".repeat(64)}`]) {
    assert.equal(refusal(() => Digest.parse(bad)).class, "invalid-digest", bad);
  }
});

test("a partial lock is an error a caller can show", () => {
  const lock = new PartialLock("requirements.txt");
  assert.equal(String(lock), "PartialLock: partial-lock: requirements.txt");
  assert.equal(lock.message, "partial-lock: requirements.txt");
  assert.equal(lock.class, "partial-lock");
});

test("a value that doubles line after line is refused before it is large", () => {
  let value = "x".repeat(32);
  const env = new Map<string, string>([["A0", value]]);
  const started = Date.now();
  const error = refusal(() => {
    for (let line = 1; line < 48; line += 1) {
      value = substitute(`\${A${line - 1}}\${A${line - 1}}`, (name) => env.get(name));
      env.set(`A${line}`, value);
    }
  });
  assert.equal(error.class, "too-large", error.message);
  assert.ok(Date.now() - started < 5000);
});

test("expressions nested past the limit are refused, not followed down the stack", () => {
  const depth = 200_000;
  const text = `${"${U:-".repeat(depth)}x${"}".repeat(depth)}`;
  assert.equal(refusal(() => substitute(text, lookup())).class, "too-deep");
});

test("a pattern that would take forever is refused quickly", () => {
  const values = { A: "a".repeat(20_000), P: "/usr/bin:/bin" };
  const started = Date.now();
  assert.equal(refusal(() => substitute("${A//*z/}", lookup(values))).class, "too-complex");
  assert.ok(Date.now() - started < 5000);
  assert.equal(substitute("${P//:/ }", lookup(values)), "/usr/bin /bin");
});

test("a substitution limit is a setting with no floor", () => {
  const nested = "${U:-${V:-${W:-x}}}";
  assert.equal(refusal(() => substituteWith(nested, lookup(), settings.with({ substitutionDepth: 1 }))).class, "too-deep");
  assert.equal(substituteWith(nested, lookup(), settings), "x");
  assert.equal(substituteWith("${U:-x}", lookup(), settings.with({ substitutionBytes: null })), "x");
});

test("a setting past its default is reported as data", () => {
  assert.deepEqual(new Settings().nonDefaults(), []);
  const looser = new Settings({ manifestDepth: null, treeFiles: 10 });
  assert.deepEqual(
    looser.nonDefaults().map((setting) => [setting.setting, setting.value, setting.default]),
    [
      ["manifest_depth", "none", "64"],
      ["tree_files", "10", "4096"],
    ],
  );
});

test("settings read as a configuration writes them", () => {
  const read = Settings.fromData({ manifest_bytes: 10, tree_depth: null, tree_files: "none" });
  assert.equal(read.manifestBytes, 10);
  assert.equal(read.treeDepth, null);
  assert.equal(read.treeFiles, null);
  assert.throws(() => Settings.fromData({ nope: 1 }), RangeError);
  assert.throws(() => new Settings({ treeDepth: -1 }), RangeError);
  assert.throws(() => new Settings({ treeDepth: 1.5 }), RangeError);
  assert.ok(Object.isFrozen(read));
});

test("the vector files are the ones the source file names", () => {
  const directory = new URL("../../vectors/", import.meta.url);
  const source = obj(parseVectorJson(readFileSync(new URL("AOS-SOURCE.json", directory), "utf8")));
  const files = obj(source.get("files"));
  assert.ok(files.size >= 11, `${files.size} files`);
  for (const [name, digest] of files) {
    const data = new Uint8Array(readFileSync(new URL(name, directory)));
    assert.equal(Digest.of(data).toString(), str(digest), `${name} differs from the specification's copy`);
  }
  const present = readdirSync(directory)
    .filter((name) => name !== "AOS-SOURCE.json")
    .sort();
  assert.deepEqual([...files.keys()].sort(), present, "every vector file is named, and none is missing");
});
