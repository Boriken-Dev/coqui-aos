import assert from "node:assert/strict";
import { test } from "node:test";
import { AosError } from "../src/error.ts";
import { Settings } from "../src/limits.ts";
import { readDocument } from "../src/read.ts";
import { isDocument, toPlain, valuesEqual } from "../src/value.ts";
import type { Document, Value } from "../src/value.ts";

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

const read = (text: string, given: Settings = settings): Document => readDocument(bytes(text), given);

test("an integer is a bigint and a float a number, in every format", () => {
  for (const text of ["x = 30\ny = 30.0\n", '#!json\n{"x": 30, "y": 30.0}', "#!yaml\nx: 30\ny: 30.0\n"]) {
    const document = read(text);
    assert.equal(document.get("x"), 30n, text);
    assert.equal(document.get("y"), 30, text);
    assert.ok(!valuesEqual(document.get("x"), document.get("y")), text);
  }
});

test("a key named __proto__ is data, not a prototype", () => {
  for (const text of ['"__proto__" = 1\n', '#!json\n{"__proto__": 1}', "#!yaml\n__proto__: 1\n"]) {
    const document = read(text);
    assert.equal(document.get("__proto__"), 1n, text);
    assert.equal(Object.keys(toPlain(document) as object).length, 1, text);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  }
});

test("JSON nested a million deep is refused, with the default and with no bound", () => {
  const deep = `#!json\n${"[".repeat(1_000_000)}${"]".repeat(1_000_000)}`;
  assert.equal(refusal(() => read(`#!json\n{"a": ${deep.slice(7)}}`, settings.with({ manifestBytes: null }))).class, "too-deep");
  assert.equal(refusal(() => read(`#!json\n{"a": ${deep.slice(7)}}`)).class, "too-large");
  const unbounded = settings.with({ manifestDepth: null, manifestBytes: null });
  const value = read(`#!json\n{"a": ${"[".repeat(100_000)}${"]".repeat(100_000)}}`, unbounded);
  assert.ok(isDocument(value));
});

test("YAML and TOML nested far past the bound are refused, not a stack overflow", () => {
  const yaml = `#!yaml\na: ${"[".repeat(100_000)}${"]".repeat(100_000)}\n`;
  assert.equal(refusal(() => read(yaml)).class, "too-deep");
  const block = `#!yaml\n${Array.from({ length: 1000 }, (_, level) => `${" ".repeat(level)}a:`).join("\n")} 1\n`;
  assert.equal(refusal(() => read(block)).class, "too-deep");
  const toml = `a = ${"[".repeat(100_000)}${"]".repeat(100_000)}\n`;
  assert.equal(refusal(() => read(toml)).class, "too-deep");
});

test("a billion-laughs document is refused before anything is expanded", () => {
  let text = "#!yaml\na: &a [x, x, x, x, x, x, x, x, x]\n";
  for (const [name, previous] of [["b", "a"], ["c", "b"], ["d", "c"], ["e", "d"], ["f", "e"], ["g", "f"], ["h", "g"], ["i", "h"]]) {
    text += `${name}: &${name} [${Array.from({ length: 9 }, () => `*${previous}`).join(", ")}]\n`;
  }
  const started = Date.now();
  assert.equal(refusal(() => read(text)).class, "yaml-anchor");
  assert.ok(Date.now() - started < 2000);
});

test("a tag, an anchor, an alias, a merge key and a directive each have their class", () => {
  const cases: Array<[string, string]> = [
    ["#!yaml\na: !!str b\n", "yaml-tag"],
    ["#!yaml\na: &x b\n", "yaml-anchor"],
    ["#!yaml\na: &x b\nc: *x\n", "yaml-anchor"],
    ["#!yaml\na: *x\n", "yaml-anchor"],
    ["#!yaml\nbase: {x: 1}\n<<: {y: 2}\n", "yaml-merge-key"],
    ["#!yaml\n%YAML 1.2\n---\na: b\n", "yaml-directive"],
    ["#!yaml\n%TAG ! tag:x,2000:\n---\na: b\n", "yaml-directive"],
    ["#!yaml\na: 1\n---\nb: 2\n", "parse-error"],
    ["#!yaml\n? [a]\n: b\n", "non-string-key"],
    ["#!yaml\n1: b\n", "non-string-key"],
    ["#!yaml\na: ~\n", "null-value"],
    ["#!yaml\na: .inf\n", "non-finite-float"],
    ["#!yaml\na: 9223372036854775808\n", "integer-range"],
    ["#!yaml\na: 1\na: 2\n", "duplicate-key"],
  ];
  for (const [text, expected] of cases) assert.equal(refusal(() => read(text)).class, expected, text);
});

test("YAML 1.2 core typing: yes is text, 0x and 0o are integers, an exponent is a float", () => {
  const document = read("#!yaml\na: yes\nb: 0x1F\nc: 0o17\nd: 1e3\ne: -7\nf: 'null'\ng: true\n");
  assert.deepEqual(
    [...document.entries()],
    [["a", "yes"], ["b", 31n], ["c", 15n], ["d", 1000], ["e", -7n], ["f", "null"], ["g", true]] as Array<[string, Value]>,
  );
});

test("a TOML date, infinity and an integer past 64 bits are refused", () => {
  assert.equal(refusal(() => read("a = 1979-05-27\n")).class, "datetime-value");
  assert.equal(refusal(() => read("a = inf\n")).class, "non-finite-float");
  assert.equal(refusal(() => read("a = nan\n")).class, "non-finite-float");
  assert.equal(refusal(() => read("a = 9223372036854775808\n")).class, "integer-range");
  assert.equal(read("a = -9223372036854775808\n").get("a"), -(2n ** 63n));
});

test("JSON refuses a lone surrogate, a duplicate key, NaN, a comment and a trailing comma", () => {
  const cases: Array<[string, string]> = [
    ['{"a": "\\ud800"}', "invalid-unicode"],
    ['{"a": "\\udc00"}', "invalid-unicode"],
    ['{"a": 1, "a": 2}', "duplicate-key"],
    ['{"a": NaN}', "parse-error"],
    ['{"a": 1} // x', "parse-error"],
    ['{"a": 1,}', "parse-error"],
    ['{"a": 1e999}', "non-finite-float"],
    ['{"a": null}', "null-value"],
    ["[1]", "not-a-mapping"],
  ];
  for (const [text, expected] of cases) assert.equal(refusal(() => read(`#!json\n${text}`)).class, expected, text);
  assert.equal(read('#!json\n{"a": "\\ud83d\\ude00"}').get("a"), "\u{1f600}");
});

test("a byte-order mark where a document starts is refused, and one before the format line is not", () => {
  assert.equal(read("﻿a = 1\n").get("a"), 1n);
  assert.equal(refusal(() => read("#!json\n﻿{}")).class, "parse-error");
  assert.equal(refusal(() => read("﻿﻿a = 1\n")).class, "parse-error");
});

test("a document that is not UTF-8 is refused", () => {
  assert.equal(refusal(() => readDocument(new Uint8Array([0x61, 0x20, 0x3d, 0x20, 0xff]), settings)).class, "invalid-utf8");
});

test("a document past manifestBytes is too large, before it is read", () => {
  assert.equal(refusal(() => read("a = 1\n", settings.with({ manifestBytes: 3 }))).class, "too-large");
});
