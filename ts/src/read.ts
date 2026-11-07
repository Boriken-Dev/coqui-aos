/** Reading a document: the format line, the three formats, `dotenv` text and an env script's output. */
import { readJson, readToml, readYaml } from "./codecs.ts";
import { AosError } from "./error.ts";
import type { Format } from "./kinds.ts";
import { type Limit, type Settings, allows, limitText } from "./limits.ts";
import { asciiLower, isReservedVariable, isVariableName } from "./names.ts";
import { decodeUtf8, startsWithBytes, trimAscii, trimBlank } from "./text.ts";
import type { Document, Value } from "./value.ts";

const BOM = [0xef, 0xbb, 0xbf] as const;

/** Splits off a `#!` format line. Returns the format, the rest of the bytes, and whether a line was removed. */
export function chooseFormat(data: Uint8Array, byDefault: Format): { format: Format; payload: Uint8Array; lined: boolean } {
  if (!(data.length >= 2 && data[0] === 0x23 && data[1] === 0x21)) {
    return { format: byDefault, payload: data, lined: false };
  }
  const rest = data.subarray(2);
  const end = rest.indexOf(0x0a);
  const lineBytes = end === -1 ? rest : rest.subarray(0, end);
  const payload = end === -1 ? rest.subarray(rest.length) : rest.subarray(end + 1);
  const line = decodeUtf8(lineBytes, "the format line is not UTF-8");
  const word = line
    .split(/[ \t\f\r]/)
    .filter((part) => part !== "")
    .pop() ?? "";
  const last = word.split(/[/\\]/).pop() ?? "";
  const name = last.replace(/^\.+/, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (name === "") throw new AosError("no-format-named", "the format line names no format");
  let format: Format;
  if (name === "toml") format = "toml";
  else if (name === "json") format = "json";
  else if (name === "yaml" || name === "yml") format = "yaml";
  else {
    const safe = /^[A-Za-z0-9_.-]*$/.test(name);
    throw new AosError(
      "unsupported-format",
      safe ? `${name} is not toml, json or yaml` : "the format line names no supported format",
    );
  }
  return { format, payload, lined: true };
}

/** Parses a payload in a format. `lined` is whether a format line came first, so positions count it. */
export function parsePayload(payload: Uint8Array, format: Format, settings: Settings, lined: boolean): Document {
  const text = decodeUtf8(payload);
  const shift = lined ? 1 : 0;
  if (text.startsWith("﻿")) {
    throw new AosError("parse-error", "a byte-order mark where the document starts").at(1 + shift, 1);
  }
  if (trimAscii(text) === "") return new Map();
  const depth = settings.manifestDepth;
  let value: Value;
  try {
    value = format === "toml" ? readToml(text, depth) : format === "json" ? readJson(text, depth, false) : readYaml(text, depth);
  } catch (error) {
    if (error instanceof AosError && error.line !== undefined) {
      if (error.column === undefined) error.onLine(error.line + shift);
      else error.at(error.line + shift, error.column);
    }
    throw error;
  }
  if (!(value instanceof Map)) throw new AosError("not-a-mapping", "the document is not a mapping");
  return value;
}

/** Reads one AOS document: an optional byte-order mark, an optional format line, else TOML, then the data model. */
export function readDocument(data: Uint8Array, settings: Settings): Document {
  if (!allows(settings.manifestBytes, data.length)) {
    throw new AosError("too-large", `over ${limitText(settings.manifestBytes)} bytes`);
  }
  const bytes = startsWithBytes(data, BOM) ? data.subarray(3) : data;
  const { format, payload, lined } = chooseFormat(bytes, "toml");
  return parsePayload(payload, format, settings, lined);
}

/** One assignment of a `dotenv` file: its text is not yet substituted unless `literal`. */
export interface DotenvLine {
  readonly name: string;
  readonly text: string;
  readonly literal: boolean;
}

function assignment(text: string): { name: string; rest: string } | undefined {
  const match = /^([A-Za-z0-9_]*)/.exec(text);
  const name = match?.[1] ?? "";
  if (!isVariableName(name)) return undefined;
  const after = text.slice(name.length).replace(/^[ \t]+/, "");
  if (!after.startsWith("=")) return undefined;
  return { name, rest: after.slice(1) };
}

/** Parses `dotenv` text into lines, without substituting. */
export function parseDotenv(data: Uint8Array): DotenvLine[] {
  const bytes = startsWithBytes(data, BOM) ? data.subarray(3) : data;
  const text = decodeUtf8(bytes);
  const lines: DotenvLine[] = [];
  const seen = new Set<string>();
  const numbered = text.split("\n");
  for (let number = 0; number < numbered.length; number += 1) {
    let line = numbered[number]!;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const stripped = trimBlank(line);
    if (stripped === "" || stripped.startsWith("#")) continue;
    const start = line.replace(/^[ \t]+/, "");
    let found: { name: string; rest: string } | undefined;
    if (start.startsWith("export")) {
      const rest = start.slice("export".length);
      const after = rest.replace(/^[ \t]+/, "");
      if (after.length < rest.length) found = assignment(after);
    }
    found ??= assignment(start);
    if (found === undefined) {
      throw new AosError("dotenv-syntax", "a line that is no NAME=VALUE").onLine(number + 1);
    }
    let value = trimBlank(found.rest);
    let literal = false;
    const chars = [...value];
    if (chars.length >= 2 && chars[0] === chars[chars.length - 1] && (chars[0] === '"' || chars[0] === "'")) {
      literal = chars[0] === "'";
      value = chars.slice(1, -1).join("");
    }
    const lower = asciiLower(found.name);
    if (seen.has(lower)) {
      throw new AosError("duplicate-key", `${found.name} is set twice`).onLine(number + 1);
    }
    seen.add(lower);
    lines.push({ name: found.name, text: value, literal });
  }
  return lines;
}

/** What an env script printed: each variable it set, in order; `undefined` unsets one. */
export type ScriptOutput = Array<[string, string | undefined]>;

/** Reads an env script's output: one JSON object, or one per line. */
export function readEnvScriptOutput(data: Uint8Array, settings: Settings): ScriptOutput {
  const text = decodeUtf8(data);
  const whole = trimAscii(text);
  if (whole === "") return [];
  const depth: Limit = settings.manifestDepth;
  const json = (piece: string): Value => readJson(piece, depth, true);
  let objects: Value[];
  try {
    objects = [json(whole)];
  } catch (error) {
    if (!(error instanceof AosError && error.class === "parse-error")) throw error;
    objects = [];
    for (let line of text.split("\n")) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (trimBlank(line) !== "") objects.push(json(line));
    }
  }
  const out = new Map<string, string | undefined>();
  for (const object of objects) {
    if (!(object instanceof Map)) throw new AosError("env-script-output", "not an object");
    for (const [name, value] of object) {
      if (!isVariableName(name) || isReservedVariable(name)) {
        throw new AosError("env-script-output", "a name that may not be set");
      }
      let set: string | undefined;
      if ((value as unknown) === null) set = undefined;
      else if (typeof value === "string" && !value.includes("\0")) set = value;
      else throw new AosError("env-script-output", "a value that is not text");
      out.delete(name);
      out.set(name, set);
    }
  }
  return [...out];
}
