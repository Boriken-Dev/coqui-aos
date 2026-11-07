/** What the vector tests share: the vector files, their comparison rules and the JSON shapes the vectors write results in. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readJson } from "../src/codecs.ts";
import { AosError } from "../src/error.ts";
import { Settings } from "../src/limits.ts";
import { valuesEqual } from "../src/value.ts";

/** A vector's JSON: mappings are `Map`s, integers `bigint`s, floats `number`s, and null is `null`. */
export type Json = null | boolean | bigint | number | string | Json[] | Map<string, Json>;

const VECTORS = fileURLToPath(new URL("../../vectors/", import.meta.url));

export function parseVectorJson(text: string): Json {
  return readJson(text, null, true) as unknown as Json;
}

/** The cases of one vector file. */
export function cases(file: string): Map<string, Json>[] {
  const document = parseVectorJson(readFileSync(VECTORS + file, "utf8")) as Map<string, Json>;
  return document.get("cases") as Map<string, Json>[];
}

export function decode64(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function str(value: Json | undefined): string {
  assert.equal(typeof value, "string", `a string, not ${String(value)}`);
  return value as string;
}

export function obj(value: Json | undefined): Map<string, Json> {
  assert.ok(value instanceof Map, "an object");
  return value;
}

export function arr(value: Json | undefined): Json[] {
  assert.ok(Array.isArray(value), "an array");
  return value;
}

export function strings(value: Json | undefined): string[] {
  return value === undefined || value === null ? [] : arr(value).map(str);
}

export function num(value: Json | undefined): number | undefined {
  return typeof value === "bigint" ? Number(value) : undefined;
}

/** A case's document bytes: `base64`, `text`, or `parts` concatenated. */
export function bytesOf(item: Map<string, Json>): Uint8Array {
  const encoded = item.get("base64");
  if (typeof encoded === "string") return decode64(encoded);
  const parts = item.get("parts");
  if (Array.isArray(parts)) return partsBytes(parts);
  return utf8(str(item.get("text")));
}

/** Parts: text, or `[text, times]`, concatenated. */
export function partsBytes(parts: Json[]): Uint8Array {
  const out: Uint8Array[] = [];
  for (const part of parts) {
    const [text, times] = Array.isArray(part) ? [str(part[0]), Number(part[1])] : [str(part), 1];
    const bytes = utf8(text);
    for (let at = 0; at < times; at += 1) out.push(bytes);
  }
  return Buffer.concat(out);
}

/** The settings a case's `limits` write. */
export function settingsOf(item: Map<string, Json>): Settings {
  const limits = item.get("limits");
  if (!(limits instanceof Map)) return new Settings();
  const changes: Record<string, number> = {};
  const bytes = num(limits.get("max_bytes"));
  if (bytes !== undefined) {
    changes["manifestBytes"] = bytes;
    changes["catalogBytes"] = bytes;
  }
  const depth = num(limits.get("max_depth"));
  if (depth !== undefined) changes["manifestDepth"] = depth;
  const context = num(limits.get("max_context_bytes"));
  if (context !== undefined) changes["contextBytes"] = context;
  return new Settings(changes);
}

/** Runs `check` on every case of a file, collecting failures; `skip` names a case left out, with the reason. Fails when any case fails. */
export function runFile(
  file: string,
  check: (item: Map<string, Json>) => void,
  skip: (item: Map<string, Json>) => string | undefined = () => undefined,
): void {
  test(file, () => {
    let passed = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const item of cases(file)) {
      const id = str(item.get("id"));
      const reason = skip(item);
      if (reason !== undefined) {
        skipped += 1;
        console.error(`${file}: skipped ${id}: ${reason}`);
        continue;
      }
      try {
        check(item);
        passed += 1;
      } catch (error) {
        failed.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.error(`${file}: ${passed} passed, ${skipped} skipped, ${failed.length} failed`);
    assert.equal(failed.length, 0, `${file}:\n${failed.join("\n")}`);
  });
}

export function expectedErrors(expect: Map<string, Json>): string[] {
  const error = expect.get("error");
  if (typeof error === "string") return [error];
  if (Array.isArray(error)) return error.map(str);
  return [];
}

export function show(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? `${item}n` : item instanceof Map ? Object.fromEntries(item) : item,
  );
}

/** Compares a result with a case's `expect`: its `data`, or one of its error classes. */
export function compare(got: () => unknown, expect: Json | undefined): void {
  const want = obj(expect);
  const errors = expectedErrors(want);
  let data: unknown;
  try {
    data = got();
  } catch (error) {
    if (!(error instanceof AosError)) throw error;
    if (errors.includes(error.class)) return;
    throw new Error(`refused ${error.message}, expected ${show(want)}`);
  }
  if (!want.has("data")) throw new Error(`read ${show(data)}, expected an error ${errors.join(",")}`);
  if (!valuesEqual(data, want.get("data"))) throw new Error(`read ${show(data)}, expected ${show(want.get("data"))}`);
}
