/** Helpers the hook, skill and catalog tests share. */
import { HookRun, hookRun } from "../src/hooks.ts";
import type { Source } from "../src/source.ts";
import { OverlayTree } from "../src/tree.ts";
import { type Json, arr, decode64, obj, partsBytes, str, strings, utf8 } from "./support.ts";

/** An overlay tree from a case's `files`: a list of paths, or a map of path to text. */
export function treeOf(files: Json | undefined): OverlayTree {
  if (Array.isArray(files)) return OverlayTree.fromPaths(files.map(str));
  if (files instanceof Map) return OverlayTree.fromTexts([...files].map(([path, text]) => [path, str(text)] as const));
  return OverlayTree.fromPaths([]);
}

/** The trees of a case's `files`, by identity. */
export function treesOf(item: Map<string, Json>): Map<string, OverlayTree> {
  const files = item.get("files");
  const out = new Map<string, OverlayTree>();
  if (files instanceof Map) for (const [identity, tree] of files) out.set(identity, treeOf(tree));
  return out;
}

/** A source as the vectors write it. */
export function sourceJson(source: Source): Map<string, Json> {
  return new Map<string, Json>([
    ["kind", source.kind],
    ["location", source.location],
    ["ref", source.reference ?? null],
    ["path", source.path ?? null],
  ]);
}

/** A hook run from a vector's `run`. */
export function hookRunOf(value: Json | undefined): HookRun {
  const item = obj(value);
  let stdout: Uint8Array;
  const encoded = item.get("stdout_base64");
  const parts = item.get("stdout_parts");
  if (typeof encoded === "string") stdout = decode64(encoded);
  else if (Array.isArray(parts)) stdout = partsBytes(parts);
  else stdout = utf8(typeof item.get("stdout") === "string" ? str(item.get("stdout")) : "");
  const run = hookRun(typeof item.get("source") === "string" ? str(item.get("source")) : "", stdout);
  run.onFailure = item.get("on_failure") === "refuse" ? "refuse" : "report";
  run.seconds = Number(item.get("seconds") ?? 0n);
  run.notRun = item.get("not_run") === true;
  run.payloadSize = Number(item.get("payload_size") ?? 0n);
  run.timedOut = item.get("timed_out") === true;
  run.exit = Number(item.get("exit") ?? 0n);
  run.sets = strings(item.get("sets"));
  run.select = item.get("match") === undefined ? undefined : strings(item.get("match"));
  return run;
}

/** Plain JavaScript as the vectors' JSON: objects become `Map`s, whole numbers `bigint`s, `undefined` null. */
export function toJson(plain: unknown): Json {
  if (plain === undefined || plain === null) return null;
  if (Array.isArray(plain)) return plain.map(toJson);
  if (plain instanceof Map) return new Map([...plain].map(([key, item]) => [key as string, toJson(item)]));
  if (typeof plain === "number" && Number.isInteger(plain)) return BigInt(plain);
  if (typeof plain === "object") return new Map(Object.entries(plain).map(([key, item]) => [key, toJson(item)]));
  return plain as Json;
}

export { arr };
