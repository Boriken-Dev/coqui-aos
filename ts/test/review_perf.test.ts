import assert from "node:assert/strict";
import { test } from "node:test";
import { readDotenv } from "../src/apply.ts";
import { checkRequirements } from "../src/defaults.ts";
import { readTree, treeDigest } from "../src/digest.ts";
import { AosError } from "../src/error.ts";
import { Environment, Facts } from "../src/environment.ts";
import type { FileSystem } from "../src/fs.ts";
import { Settings } from "../src/limits.ts";
import { parseDotenv, readEnvScriptOutput } from "../src/read.ts";
import { Source, hostIsLocal, hostIsPrivate } from "../src/source.ts";
import { substitute, substituteWith } from "../src/subst.ts";
import { safeSubject, trimWhitespace } from "../src/text.ts";
import { OverlayTree } from "../src/tree.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const settings = new Settings();

function timed<T>(limitMs: number, run: () => T): T {
  const started = Date.now();
  const result = run();
  const took = Date.now() - started;
  assert.ok(took < limitMs, `took ${took} ms, limit ${limitMs}`);
  return result;
}

function refusal(run: () => unknown): AosError {
  try {
    run();
  } catch (error) {
    if (error instanceof AosError) return error;
    throw error;
  }
  throw new Error("not refused");
}

test("a dotenv value with a long run of blanks is read in linear time", () => {
  const lines = timed(2000, () => parseDotenv(bytes(`A=x${" ".repeat(100_000)}y`)));
  assert.equal(lines[0]?.text.length, 100_002);
  timed(2000, () => parseDotenv(bytes(`A=x${" ".repeat(100_000)}\n`)));
  assert.equal(timed(2000, () => refusal(() => parseDotenv(bytes(`A${" ".repeat(100_000)}y\n`)))).class, "dotenv-syntax");
});

test("an env script's output with long runs of blanks is read in linear time", () => {
  const refused = timed(2000, () => refusal(() => readEnvScriptOutput(bytes(`{"A": "x"}${" \t".repeat(100_000)}y`), settings)));
  assert.equal(refused.class, "parse-error");
  const padded = `${" \t".repeat(100_000)}{"A": "x"}${" \t".repeat(100_000)}`;
  assert.deepEqual(timed(2000, () => readEnvScriptOutput(bytes(padded), settings)), [["A", "x"]]);
});

test("trimWhitespace trims Unicode white space and is linear", () => {
  assert.equal(trimWhitespace("   a b　\u0085\n"), "a b");
  assert.equal(trimWhitespace("﻿a"), "﻿a");
  assert.equal(trimWhitespace(""), "");
  assert.equal(trimWhitespace(" \t "), "");
  timed(2000, () => trimWhitespace(`a${" ".repeat(200_000)}b`));
  timed(2000, () => Source.parse(`dir${" ".repeat(100_000)}x`));
  timed(2000, () => checkRequirements(`a ==1${" ".repeat(100_000)}x\n`, false));
});

test("many dotenv lines are read in linear time", () => {
  const text = Array.from({ length: 10_000 }, (_, at) => `V${at}=${at}`).join("\n");
  assert.equal(timed(3000, () => readDotenv(bytes(text), new Environment([], false))).length, 10_000);
  assert.equal(timed(3000, () => readDotenv(bytes(text), new Environment([], true))).length, 10_000);
  const script = Array.from({ length: 10_000 }, (_, at) => `{"V${at}": "x"}`).join("\n");
  assert.equal(timed(3000, () => readEnvScriptOutput(bytes(script), settings)).length, 10_000);
});

test("an Environment keeps order, first spelling and Windows case folding", () => {
  const env = new Environment([["Path", "1"], ["B", "2"]], true);
  env.set("PATH", "3", false);
  env.set("C", "4", true);
  assert.deepEqual(env.values(), [["Path", "3"], ["B", "2"], ["C", "4"]]);
  assert.equal(env.get("path"), "3");
  assert.ok(env.isSecret("c"));
  env.unset("PATH");
  assert.deepEqual(env.values().map(([name]) => name), ["B", "C"]);
  env.set("Path", "5", false);
  assert.deepEqual(env.values().map(([name]) => name), ["B", "C", "Path"]);
  const unix = new Environment([["a", "1"]], false);
  unix.set("A", "2", false);
  assert.equal(unix.values().length, 2);
  assert.equal(unix.clone().get("a"), "1");
});

test("an unclosed or nested expression is charged to substitutionSteps", () => {
  const text = "${".repeat(50_000) + "}".repeat(50_000);
  const error = timed(3000, () => refusal(() => substitute(text, () => undefined)));
  assert.ok(["too-deep", "too-complex"].includes(error.class), error.class);
  const tight = settings.with({ substitutionSteps: 1000 });
  const many = "${1}".repeat(2000);
  assert.equal(refusal(() => substituteWith(many, () => undefined, tight)).class, "too-complex");
});

test("a growing output is measured once, not each time it grows", () => {
  const text = "${A}".repeat(20_000);
  const value = "x".repeat(40);
  const out = timed(2000, () => substitute(text, (name) => (name === "A" ? value : undefined)));
  assert.equal(out.length, 800_000);
  const capped = settings.with({ substitutionBytes: 100 });
  assert.equal(refusal(() => substituteWith("${A}${A}${A}", () => value, capped)).class, "too-large");
  assert.equal(substituteWith("${A}${A}", () => "\u{1f600}", settings.with({ substitutionBytes: 8 })), "\u{1f600}\u{1f600}");
  assert.equal(refusal(() => substituteWith("${A}${A}", () => "\u{1f600}", settings.with({ substitutionBytes: 7 }))).class, "too-large");
});

test("a pattern with many unmatched brackets compiles in linear time", () => {
  const pattern = "[".repeat(100_000);
  timed(3000, () => substitute(`\${A//${pattern}/}`, () => "a".repeat(10)));
});

test("a wide character class costs steps in proportion to its members", () => {
  const members = Array.from({ length: 3000 }, (_, at) => String.fromCharCode(0x100 + at)).join("");
  const tight = settings.with({ substitutionSteps: 5000 });
  assert.equal(refusal(() => substituteWith(`\${A//[${members}]/}`, () => "z".repeat(50), tight)).class, "too-complex");
  assert.equal(substitute("${A//[abc]/}", () => "xaby"), "xy");
});

test("a subject never holds control, escape or bidirectional characters, and is capped", () => {
  assert.equal(safeSubject("a\u001b[2Jb\u202ec\n\u{e0001}"), "a\\x1b[2Jb\\u202ec\\x0a\\U000e0001");
  assert.equal(safeSubject("plain/ok.txt"), "plain/ok.txt");
  assert.equal(safeSubject("x".repeat(5000)), `${"x".repeat(256)}...`);
  assert.equal(safeSubject("x".repeat(256)), "x".repeat(256));
  assert.equal(safeSubject("\u0007".repeat(100)), `${"\\x07".repeat(64)}...`);
  const facts = new Facts("linux");
  const error = refusal(() => facts.secret(new Map([["provider", "file"], ["key", "../\u001b[2J"]])));
  assert.equal(error.class, "invalid-reference");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(error.subject), JSON.stringify(error.subject));
});

class OneLink implements FileSystem {
  metadata(path: string): { kind: "directory" | "symlink"; len: number } {
    return { kind: path === "/o" ? "directory" : "symlink", len: 0 };
  }
  read(): Uint8Array {
    return new Uint8Array(0);
  }
  list(path: string): string[] {
    return path === "/o" ? ["a\u001b[2Jb"] : [];
  }
}

test("a refused tree entry's subject is escaped", async () => {
  await assert.rejects(treeDigest(new OneLink(), "/o", settings), (error: unknown) => {
    assert.ok(error instanceof AosError && error.class === "symlink");
    assert.ok(!error.subject.includes("\u001b"), JSON.stringify(error.subject));
    return true;
  });
});

test("non-canonical IPv4 hosts are classified as the address they name", () => {
  for (const host of ["127.1", "2130706433", "0x7f.0.0.1", "0177.0.0.1", "127.0.1", "169.254.1"]) {
    assert.ok(hostIsLocal(host), `${host} is local`);
    assert.ok(!hostIsPrivate(host), `${host} is not private`);
  }
  for (const host of ["10.1", "0xa000001", "167772161", "192.168.1", "100.64.0.1", "100.127.255.255", "172.16.0.1"]) {
    assert.ok(hostIsPrivate(host), `${host} is private`);
    assert.ok(!hostIsLocal(host), `${host} is not local`);
  }
  for (const host of ["100.63.255.255", "100.128.0.0", "8.8.8.8", "example.org", "1.2.3.4.5", "0x", "256.1.1.1", "1..2"]) {
    assert.ok(!hostIsLocal(host) && !hostIsPrivate(host), `${host} is public or a name`);
  }
  assert.ok(Source.parse("http://127.1/x").isLocal());
  assert.ok(Source.parse("http://2130706433/x").isLocal());
  assert.ok(!Source.parse("http://8.8.8.8/x").isLocal());
});

test("readTree of thousands of files is not quadratic", async () => {
  const names = Array.from({ length: 8000 }, (_, at) => `f${at}`);
  class Flat implements FileSystem {
    metadata(path: string): { kind: "directory" | "file"; len: number } {
      return { kind: path === "/o" ? "directory" : "file", len: 1 };
    }
    read(): Uint8Array {
      return new Uint8Array([1]);
    }
    list(): string[] {
      return names;
    }
  }
  const started = Date.now();
  const { tree } = await readTree(new Flat(), "/o", settings.with({ treeFiles: null }));
  assert.equal(tree.paths().length, 8000);
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
});

test("an OverlayTree copies the bytes it is given", () => {
  const given = new Uint8Array([1, 2, 3]);
  const tree = OverlayTree.empty().withBytes("a", given);
  given[0] = 9;
  assert.deepEqual(tree.bytes("a"), new Uint8Array([1, 2, 3]));
  const built = OverlayTree.fromBytes([["b", given]]);
  given[1] = 9;
  assert.deepEqual(built.bytes("b"), new Uint8Array([9, 2, 3]));
  assert.ok(built.contains("b"));
});
