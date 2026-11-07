import assert from "node:assert/strict";
import { digestEntries } from "../src/digest.ts";
import { AosError } from "../src/error.ts";
import { contextFileText, readFrontMatter, splitFrontMatter } from "../src/front_matter.ts";
import { readOverlay } from "../src/overlay.ts";
import { OverlayTree } from "../src/tree.ts";
import { applies, validate } from "../src/validate.ts";
import { valuesEqual } from "../src/value.ts";
import { bytesOf, decode64, expectedErrors, num, obj, runFile, settingsOf, show, str, utf8 } from "./support.ts";
import type { Json } from "./support.ts";

function fileBytes(value: Json | undefined): Uint8Array {
  if (value instanceof Map && typeof value.get("base64") === "string") return decode64(str(value.get("base64")));
  return utf8(str(value));
}

function checkBytes(got: Uint8Array, expect: Map<string, Json>, key: string, base64Key: string, sizeKey: string): void {
  const text = expect.get(key);
  if (typeof text === "string") assert.deepEqual(got, utf8(text), `${key} ${JSON.stringify(new TextDecoder().decode(got))}`);
  const encoded = expect.get(base64Key);
  if (typeof encoded === "string") assert.deepEqual(got, decode64(encoded), `${base64Key} differs`);
  const size = num(expect.get(sizeKey));
  if (size !== undefined) assert.equal(got.length, size, sizeKey);
}

function documentCase(item: Map<string, Json>): void {
  const data = bytesOf(item);
  const settings = settingsOf(item);
  const expect = obj(item.get("expect"));
  const read = readFrontMatter(data, settings);
  const split = splitFrontMatter(data, settings);
  assert.equal(read.case, expect.get("case"), "case");
  for (const [key, got] of [
    ["body_offset", split.bodyOffset],
    ["body_line", split.bodyLine],
    ["metadata_offset", split.metadataOffset],
    ["metadata_line", split.metadataLine],
  ] as const) {
    const want = num(expect.get(key));
    if (want !== undefined) assert.equal(got, want, key);
  }
  checkBytes(split.metadata ?? new Uint8Array(0), expect, "metadata", "metadata_base64", "metadata_size");
  checkBytes(split.body(data), expect, "body", "body_base64", "body_size");
  const format = expect.get("format");
  if (typeof format === "string") assert.equal(read.format, format, "format");
  if (expect.has("data")) assert.ok(read.data !== undefined && valuesEqual(read.data, expect.get("data")), `data ${show(read.data)}`);
  const classes = expectedErrors(expect);
  if (classes.length > 0) {
    assert.ok(read.error !== undefined && classes.includes(read.error.class), `error ${read.error?.message}, expected ${classes}`);
    const line = num(expect.get("line"));
    if (line !== undefined) assert.equal(read.error.line, line, "line");
  } else assert.equal(read.error, undefined, `error ${read.error?.message}`);
}

function filesCase(item: Map<string, Json>): void {
  const files = obj(item.get("files"));
  let tree = OverlayTree.empty();
  for (const [path, content] of files) tree = tree.withBytes(path, fileBytes(content));
  const settings = settingsOf(item);
  const expect = obj(item.get("expect"));
  let read;
  try {
    read = readOverlay(tree, settings);
  } catch (error) {
    if (!(error instanceof AosError) || typeof expect.get("error") !== "string") throw error;
    assert.equal(error.class, expect.get("error"), error.message);
    const line = num(expect.get("line"));
    if (line !== undefined) assert.equal(error.line, line, "line");
    return;
  }
  assert.ok(!expect.has("error"), "read, expected an error");
  const got = (key: string): unknown => {
    switch (key) {
      case "manifest_file":
        return read.manifestFile ?? null;
      case "manifest":
        return read.manifest;
      case "context":
        return read.context;
      case "context_ignored":
        return read.contextIgnored;
      case "issues":
        return read.issues;
      case "harness_context":
        return read.harnessContext === undefined ? null : read.harnessContext;
      case "applies":
        return applies(validate(read.manifest, tree));
      case "digest":
        return digestEntries(
          [...files].map(([path, content]) => [path.split("/"), { kind: "file", bytes: fileBytes(content) }] as const),
        ).digest.toString();
      default:
        throw new Error(`unknown key ${key}`);
    }
  };
  for (const [key, want] of expect) {
    const value = got(key);
    assert.ok(valuesEqual(value, want), `${key} ${show(value)}, expected ${show(want)}`);
  }
}

runFile("front_matter.json", (item) => {
  const contextFile = item.get("context_file");
  if (typeof contextFile === "string") {
    const expect = obj(item.get("expect"));
    try {
      const text = new TextDecoder().decode(contextFileText(utf8(contextFile), settingsOf(item)));
      assert.equal(text, expect.get("text"));
    } catch (error) {
      if (!(error instanceof AosError)) throw error;
      assert.equal(error.class, expect.get("error"), error.message);
    }
    return;
  }
  if (item.has("files")) filesCase(item);
  else documentCase(item);
});
