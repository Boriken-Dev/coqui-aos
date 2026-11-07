import assert from "node:assert/strict";
import { test } from "node:test";
import { AosError } from "../src/error.ts";
import { Settings } from "../src/limits.ts";
import { readDocument } from "../src/read.ts";

const settings = new Settings();
const read = (text: string, given: Settings = settings): unknown => readDocument(new TextEncoder().encode(text), given);

function classOf(text: string): string {
  try {
    read(text);
  } catch (error) {
    if (error instanceof AosError) return error.class;
    throw error;
  }
  return "accepted";
}

test("a lone surrogate escape is refused in every format", () => {
  assert.equal(classOf('#!json\n{"a": "\\ud800"}'), "invalid-unicode");
  assert.equal(classOf('#!yaml\na: "\\ud800"\n'), "invalid-unicode");
  assert.equal(classOf('#!yaml\n"\\udc00": 1\n'), "invalid-unicode");
  assert.equal(classOf('a = "\\ud800"\n'), "invalid-unicode");
  assert.equal(classOf('"\\ud800" = 1\n'), "invalid-unicode");
  assert.equal(classOf('#!yaml\na: "\\ud83d\\ude00"\n'), "accepted");
});

test("a duplicate key has one class in every format", () => {
  assert.equal(classOf("a = 1\na = 2\n"), "duplicate-key");
  assert.equal(classOf("[a]\n[a]\n"), "duplicate-key");
  assert.equal(classOf("a.b = 1\na = 2\n"), "duplicate-key");
  assert.equal(classOf('#!json\n{"a": 1, "a": 2}'), "duplicate-key");
  assert.equal(classOf("#!yaml\na: 1\na: 2\n"), "duplicate-key");
});

test("YAML refusals keep their classes with a syntax error elsewhere or a directive first", () => {
  assert.equal(classOf("#!yaml\n%YAML 1.2\n---\na: b\n"), "yaml-directive");
  assert.equal(classOf("#!yaml\n%FOO bar\n---\na: b\n"), "yaml-directive");
  assert.equal(classOf("#!yaml\na: !!str b\n"), "yaml-tag");
  assert.equal(classOf("#!yaml\na: &x b\nc: *x\n"), "yaml-anchor");
  assert.equal(classOf("#!yaml\na: 1\n---\nb: 2\n"), "parse-error");
});

test("YAML nested 100k deep is refused within a second or two", () => {
  const started = Date.now();
  assert.equal(classOf(`#!yaml\na: ${"[".repeat(100_000)}${"]".repeat(100_000)}\n`), "too-deep");
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
});
