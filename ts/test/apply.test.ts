import assert from "node:assert/strict";
import { test } from "node:test";
import { effective, readDotenv } from "../src/apply.ts";
import { environments } from "../src/compose.ts";
import { PartialLock } from "../src/defaults.ts";
import { Environment, Facts } from "../src/environment.ts";
import { AosError } from "../src/error.ts";
import { preparation, setupPhase } from "../src/prepare.ts";
import { fromPlain, type Document } from "../src/value.ts";
import { utf8 } from "./support.ts";

const manifest = (plain: unknown): Document => fromPlain(plain) as Document;

test("a node package name shorter than package.json is not a crash", () => {
  for (const pkg of ["x", "é", "pack", ""]) {
    try {
      effective(manifest({ runtime: { node: [{ package: pkg }] } }), new Facts("linux"));
    } catch (error) {
      assert.ok(error instanceof AosError);
    }
  }
});

test("a URL that is not ASCII in its first seven characters is not a crash", () => {
  const doc = manifest({ mcp: { servers: [{ name: "s", transport: "streamable-http", url: "ééééé" }] } });
  effective(doc, new Facts("linux"));
});

test("an insecure URL is reported unless it is loopback", () => {
  const ids = (url: string): string[] =>
    effective(manifest({ mcp: { servers: [{ name: "s", url }] } }), new Facts("linux", { pinned: true })).nonDefaults.map(
      (item) => item.id,
    );
  assert.deepEqual(ids("http://example.com/mcp"), ["insecure-transport"]);
  assert.deepEqual(ids("HTTP://LOCALHOST:8080/mcp"), []);
  assert.deepEqual(ids("http://127.0.0.1/mcp"), []);
});

test("environments of names nobody defined is not a crash", () => {
  const got = environments(new Map(), ["ghost"], new Map(), "linux", ["gone"]);
  assert.equal(got.environments.length, 0);
  assert.equal(got.left.length, 0);
});

test("a partial lock is an error a caller can show", () => {
  assert.equal(new PartialLock("requirements.txt").message, "partial-lock: requirements.txt");
});

test("a value that doubles line after line is refused before it is large", () => {
  let text = "A0=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n";
  for (let line = 1; line < 48; line += 1) text += `A${line}=\${A${line - 1}}\${A${line - 1}}\n`;
  const started = Date.now();
  assert.throws(
    () => readDotenv(utf8(text), new Environment()),
    (error: unknown) => error instanceof AosError && error.class === "too-large",
  );
  assert.ok(Date.now() - started < 5000);
});

test("a dotenv value cannot read a secret variable", () => {
  const env = new Environment([["TOKEN", "s3"]]);
  env.set("TOKEN", "s3", true);
  assert.ok(env.isSecret("TOKEN"));
  assert.throws(
    () => readDotenv(utf8("A=${TOKEN}\n"), env),
    (error: unknown) => error instanceof AosError && error.class === "secret-placeholder" && error.subject === "A",
  );
});

test("on Windows variable names compare without regard to ASCII case", () => {
  const env = new Environment([["Path", "a"]], true);
  assert.equal(env.get("PATH"), "a");
  env.set("PATH", "b", false);
  assert.deepEqual([...env.values()], [["Path", "b"]]);
  const unix = new Environment([["Path", "a"]], false);
  assert.equal(unix.get("PATH"), undefined);
});

test("unset removes a variable and its secret mark", () => {
  const env = new Environment();
  env.set("A", "1", true);
  env.unset("A");
  assert.equal(env.get("A"), undefined);
  assert.equal(env.isSecret("A"), false);
});

test("a setup that is already recorded at the digest needs no phase on activate, in either case", () => {
  assert.equal(setupPhase("activate", "SHA256:AB", "sha256:ab"), undefined);
  assert.equal(setupPhase("sync", "sha256:ab", "sha256:ab"), "sync");
  assert.equal(setupPhase("remove", undefined, "x"), undefined);
});

test("a change with nothing to prepare records nothing and activates", () => {
  const got = preparation("add", undefined, undefined, undefined, [], undefined);
  assert.deepEqual(got.steps, []);
  assert.equal(got.activates, true);
  assert.equal(got.record, undefined);
});
