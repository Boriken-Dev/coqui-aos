/**
 * The three formats an AOS document may be in, each decoded to the data model. They are AOS's own
 * rather than a general reader's: AOS refuses a TOML date, a YAML tag, anchor, merge key or
 * directive, and a lone surrogate in JSON, types a YAML plain scalar by the YAML 1.2 core schema
 * (`yes` is a string), and tells a JSON `30.0` from `30`.
 *
 * A refusal names its class and where, and quotes nothing from the document.
 */
import { Parser, parseDocument, isAlias, isMap, isScalar, isSeq } from "yaml";
import type { Node as YamlNode } from "yaml";
import { parse as parseToml } from "smol-toml";
import { AosError } from "./error.ts";
import type { ErrorClass } from "./error.ts";
import { type Limit, allows, limitText } from "./limits.ts";
import { locateText } from "./text.ts";
import type { Document, Value } from "./value.ts";

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function refusal(cls: ErrorClass, detail: string): AosError {
  return new AosError(cls, detail);
}

function integer(value: bigint): bigint {
  if (value < I64_MIN || value > I64_MAX) {
    throw refusal("integer-range", "an integer outside the signed 64-bit range");
  }
  return value;
}

function float(value: number): number {
  if (!Number.isFinite(value)) throw refusal("non-finite-float", "a float that is not finite");
  return value;
}

/** The text itself, or `invalid-unicode` when an escape produced a lone surrogate. */
function wellFormed(text: string): string {
  if (!text.isWellFormed()) throw refusal("invalid-unicode", "a lone surrogate");
  return text;
}

function tooDeep(depth: Limit): AosError {
  return refusal("too-deep", `nested deeper than ${limitText(depth)}`).over("manifest_depth");
}

type Frame = { list: Value[] } | { map: Document; key: string | undefined };

/** Builds a value from a stream of scalars, keys and containers, refusing nesting past `depth` as it opens. */
class Builder {
  readonly stack: Frame[] = [];
  root: Value | undefined;
  private readonly depth: Limit;
  private readonly nulls: boolean;
  constructor(depth: Limit, nulls: boolean) {
    this.depth = depth;
    this.nulls = nulls;
  }

  wantsKey(): boolean {
    const top = this.stack[this.stack.length - 1];
    return top !== undefined && "map" in top && top.key === undefined;
  }

  key(key: string): void {
    const top = this.stack[this.stack.length - 1];
    if (top !== undefined && "map" in top) {
      if (top.map.has(key)) throw refusal("duplicate-key", "a key appears twice in one mapping");
      top.key = key;
    }
  }

  value(given: Value | null): void {
    if (given === null && !this.nulls) throw refusal("null-value", "a null");
    // A null is kept as it is only when nulls are allowed: an env script's output, where it unsets.
    const value = given as Value;
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      if (this.root !== undefined) throw refusal("parse-error", "more than one document");
      this.root = value;
    } else if ("list" in top) {
      top.list.push(value);
    } else {
      if (top.key === undefined) throw refusal("non-string-key", "a mapping key that is not a string");
      top.map.set(top.key, value);
      top.key = undefined;
    }
  }

  open(frame: Frame): void {
    if (!allows(this.depth, this.stack.length + 1)) throw tooDeep(this.depth);
    this.stack.push(frame);
  }

  openList(): void {
    this.open({ list: [] });
  }

  openMap(): void {
    this.open({ map: new Map(), key: undefined });
  }

  close(): void {
    const frame = this.stack.pop();
    if (frame === undefined) throw refusal("parse-error", "a container closed twice");
    this.value("list" in frame ? frame.list : frame.map);
  }
}

/** The deepest run of open `[` and `{` outside quotes and comments, which a parser that stops early reports only as its own failure. */
function nesting(text: string): number {
  let open = 0;
  let deepest = 0;
  let quote: string | undefined;
  let comment = false;
  let escaped = false;
  for (const c of text) {
    if (comment) {
      comment = c !== "\n";
      continue;
    }
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (c === "\\" && quote === '"') escaped = true;
      else if (c === quote || c === "\n") quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#") comment = true;
    else if (c === "[" || c === "{") {
      open += 1;
      deepest = Math.max(deepest, open);
    } else if (c === "]" || c === "}") open = Math.max(0, open - 1);
  }
  return deepest;
}

function atOffset(error: AosError, text: string, offset: number): AosError {
  const [line, column] = locateText(text, offset);
  return error.at(line, column);
}

function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}

/** TOML 1.0, a date or time refused. */
export function readToml(text: string, depth: Limit): Value {
  let table: unknown;
  try {
    table = parseToml(text, { integersAsBigInt: true });
  } catch (error) {
    const redefined = error instanceof Error && error.message.includes("redefine an already defined");
    const badEscape = error instanceof Error && error.message.includes("invalid unicode escape");
    const cls: ErrorClass = isStackOverflow(error) || !allows(depth, nesting(text))
      ? "too-deep"
      : redefined
        ? "duplicate-key"
        : badEscape
          ? "invalid-unicode"
          : "parse-error";
    const refused = refusal(
      cls,
      cls === "too-deep" ? "nested past what the reader follows" : cls === "duplicate-key" ? "a key defined twice" : cls === "invalid-unicode" ? "an escape that is no character" : "not valid TOML",
    );
    const where = error as { line?: unknown; column?: unknown };
    if (typeof where.line === "number") refused.at(where.line, typeof where.column === "number" ? where.column : 1);
    throw cls === "too-deep" ? refused.over("manifest_depth") : refused;
  }
  try {
    return tomlValue(table, 1, depth);
  } catch (error) {
    if (isStackOverflow(error)) throw tooDeep(depth);
    throw error;
  }
}

function tomlValue(item: unknown, level: number, depth: Limit): Value {
  if (typeof item === "string") return wellFormed(item);
  if (typeof item === "boolean") return item;
  if (typeof item === "bigint") return integer(item);
  if (typeof item === "number") return float(item);
  if (Array.isArray(item)) {
    if (!allows(depth, level)) throw tooDeep(depth);
    return item.map((entry) => tomlValue(entry, level + 1, depth));
  }
  if (item !== null && typeof item === "object") {
    if (item instanceof Date) throw refusal("datetime-value", "a date or time has no AOS type");
    if (!allows(depth, level)) throw tooDeep(depth);
    const map: Document = new Map();
    for (const key of Object.keys(item)) {
      map.set(wellFormed(key), tomlValue((item as Record<string, unknown>)[key], level + 1, depth));
    }
    return map;
  }
  throw refusal("parse-error", "not valid TOML");
}

/** RFC 8259 JSON: a duplicate key, a lone surrogate, `NaN`, `Infinity` and comments refused, and a number kept as the text it was written as. */
export function readJson(text: string, depth: Limit, nulls: boolean): Value {
  const reader = new JsonReader(text, depth, nulls);
  try {
    return reader.document();
  } catch (error) {
    if (error instanceof AosError && error.line === undefined) throw atOffset(error, text, reader.at);
    throw error;
  }
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

class JsonReader {
  at = 0;
  private readonly text: string;
  private readonly depth: Limit;
  private readonly nulls: boolean;
  constructor(text: string, depth: Limit, nulls: boolean) {
    this.text = text;
    this.depth = depth;
    this.nulls = nulls;
  }

  private fail(cls: ErrorClass, detail: string): never {
    throw refusal(cls, detail);
  }

  private space(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.at);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.at += 1;
      else return;
    }
  }

  document(): Value {
    const builder = new Builder(this.depth, this.nulls);
    let expectValue = true;
    for (;;) {
      this.space();
      if (this.at >= this.text.length) this.fail("parse-error", "the document ends early");
      const c = this.text[this.at]!;
      if (expectValue) {
        const isKey = builder.wantsKey();
        if ((c === "{" || c === "[") && !isKey) {
          this.at += 1;
          if (c === "{") builder.openMap();
          else builder.openList();
          this.space();
          if (this.text[this.at] === (c === "{" ? "}" : "]")) {
            this.at += 1;
            builder.close();
            expectValue = false;
            if (builder.stack.length === 0) return this.end(builder);
          }
          continue;
        }
        if (c === '"') {
          const text = this.string();
          if (isKey) {
            builder.key(text);
            this.space();
            if (this.text[this.at] !== ":") this.fail("parse-error", "a key without a colon");
            this.at += 1;
            continue;
          }
          builder.value(text);
        } else if (isKey) {
          this.fail("parse-error", "a key that is not a string");
        } else if (c === "t") this.word("true", builder, true);
        else if (c === "f") this.word("false", builder, false);
        else if (c === "n") this.word("null", builder, null);
        else if (c === "-" || isDigit(c.charCodeAt(0))) builder.value(this.number());
        else this.fail("parse-error", "not a JSON value");
        expectValue = false;
      } else {
        const top = builder.stack[builder.stack.length - 1];
        if (c === "," && top !== undefined) {
          this.at += 1;
          expectValue = true;
        } else if (top !== undefined && ((c === "}" && "map" in top) || (c === "]" && "list" in top))) {
          this.at += 1;
          builder.close();
        } else this.fail("parse-error", "an unexpected character");
      }
      if (builder.stack.length === 0 && builder.root !== undefined) return this.end(builder);
    }
  }

  private end(builder: Builder): Value {
    this.space();
    if (this.at !== this.text.length) this.fail("parse-error", "text after the document");
    return builder.root!;
  }

  private word(word: string, builder: Builder, value: boolean | null): void {
    if (!this.text.startsWith(word, this.at)) this.fail("parse-error", "not a JSON value");
    this.at += word.length;
    builder.value(value);
  }

  private digits(): number {
    const start = this.at;
    while (isDigit(this.text.charCodeAt(this.at))) this.at += 1;
    return this.at - start;
  }

  private number(): Value {
    const start = this.at;
    if (this.text[this.at] === "-") this.at += 1;
    const leadingZero = this.text[this.at] === "0";
    const whole = this.digits();
    if (whole === 0 || (leadingZero && whole > 1)) this.fail("parse-error", "a malformed number");
    let fraction = false;
    if (this.text[this.at] === ".") {
      this.at += 1;
      fraction = true;
      if (this.digits() === 0) this.fail("parse-error", "a malformed number");
    }
    if (this.text[this.at] === "e" || this.text[this.at] === "E") {
      this.at += 1;
      fraction = true;
      if (this.text[this.at] === "+" || this.text[this.at] === "-") this.at += 1;
      if (this.digits() === 0) this.fail("parse-error", "a malformed number");
    }
    const written = this.text.slice(start, this.at);
    try {
      return fraction ? float(Number(written)) : integer(BigInt(written));
    } catch (error) {
      this.at = start;
      throw error;
    }
  }

  private hex4(): number {
    const digits = this.text.slice(this.at, this.at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail("parse-error", "a malformed \\u escape");
    this.at += 4;
    return Number.parseInt(digits, 16);
  }

  private string(): string {
    this.at += 1;
    let out = "";
    for (;;) {
      if (this.at >= this.text.length) this.fail("parse-error", "a string that does not end");
      const c = this.text[this.at]!;
      if (c === '"') {
        this.at += 1;
        return out;
      }
      if (c === "\\") {
        this.at += 1;
        if (this.at >= this.text.length) this.fail("parse-error", "a string that does not end");
        const escape = this.text[this.at]!;
        this.at += 1;
        switch (escape) {
          case '"':
          case "\\":
          case "/":
            out += escape;
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const first = this.hex4();
            let code = first;
            if (first >= 0xd800 && first < 0xdc00) {
              if (!this.text.startsWith("\\u", this.at)) this.fail("invalid-unicode", "a lone surrogate");
              this.at += 2;
              const second = this.hex4();
              if (!(second >= 0xdc00 && second < 0xe000)) this.fail("invalid-unicode", "a lone surrogate");
              code = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
            } else if (first >= 0xdc00 && first < 0xe000) {
              this.fail("invalid-unicode", "a lone surrogate");
            }
            out += String.fromCodePoint(code);
            break;
          }
          default:
            this.fail("parse-error", "an unknown escape");
        }
      } else if (c.charCodeAt(0) < 0x20) {
        this.fail("parse-error", "a control character in a string");
      } else {
        const start = this.at;
        while (this.at < this.text.length) {
          const code = this.text.charCodeAt(this.at);
          if (code === 0x22 || code === 0x5c || code < 0x20) break;
          this.at += 1;
        }
        out += this.text.slice(start, this.at);
      }
    }
  }
}

const UNICODE_BREAKS = new RegExp("[\u0085\u2028\u2029]");

/** One YAML 1.2 document under the core schema, with every tag, anchor, alias, merge key and directive refused; nothing is expanded, so an alias cannot grow a document. */
export function readYaml(text: string, depth: Limit): Value {
  if (UNICODE_BREAKS.test(text)) {
    throw refusal("parse-error", "a Unicode line break YAML 1.1 and 1.2 read differently");
  }
  if (text.indexOf("﻿", 1) > 0) throw refusal("parse-error", "a byte-order mark on a later line");
  const failure = (cls: ErrorClass, detail: string, offset: number): AosError =>
    atOffset(refusal(cls, detail), text, offset);
  const guarded = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (isStackOverflow(error)) throw tooDeep(depth);
      throw error;
    }
  };
  // A directive precedes the first `---`; only a text with a line starting `%` can hold one.
  if (/^%/m.test(text)) {
    for (const top of new Parser().parse(text)) {
      if (top.type === "directive") throw failure("yaml-directive", "a %YAML or %TAG directive", top.offset);
    }
  }
  const parsed = guarded(() => parseDocument(text, { schema: "failsafe", uniqueKeys: false, intAsBigInt: true }));
  const [first] = parsed.errors;
  if (first !== undefined) {
    const deep = first.code === "RESOURCE_EXHAUSTION" || !allows(depth, nesting(text));
    const failed = failure(deep ? "too-deep" : "parse-error", "not valid YAML", first.pos[0]);
    throw deep ? failed.over("manifest_depth") : failed;
  }
  if (parsed.contents === null) return new Map();
  return guarded(() =>
    yamlValue(parsed.contents as YamlNode, depth, (node) => failure("parse-error", "", node.range?.[0] ?? 0)),
  );
}

type Typed =
  | { kind: "text" }
  | { kind: "bool"; value: boolean }
  | { kind: "integer"; value: bigint }
  | { kind: "float"; value: number };

/** A plain scalar's type under the YAML 1.2 core schema. */
function coreScalar(value: string): Typed {
  if (value === "" || value === "~" || value === "null" || value === "Null" || value === "NULL") {
    throw refusal("null-value", "a null");
  }
  if (value === "true" || value === "True" || value === "TRUE") return { kind: "bool", value: true };
  if (value === "false" || value === "False" || value === "FALSE") return { kind: "bool", value: false };
  const unsigned = value.startsWith("-") || value.startsWith("+") ? value.slice(1) : value;
  if (/^[0-9]+$/.test(unsigned)) {
    const magnitude = BigInt(unsigned);
    return { kind: "integer", value: integer(value.startsWith("-") ? -magnitude : magnitude) };
  }
  if (/^0o[0-7]+$/.test(value) || /^0x[0-9a-fA-F]+$/.test(value)) {
    return { kind: "integer", value: integer(BigInt(value)) };
  }
  if (/^(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(unsigned)) {
    return { kind: "float", value: float(Number(value)) };
  }
  if (/^\.(inf|Inf|INF)$/.test(unsigned) || value === ".nan" || value === ".NaN" || value === ".NAN") {
    throw refusal("non-finite-float", "a float that is not finite");
  }
  return { kind: "text" };
}

/** The composed document as the data model, walked with an explicit stack. */
function yamlValue(root: YamlNode, depth: Limit, where: (node: YamlNode) => AosError): Value {
  const builder = new Builder(depth, false);
  const work: Array<YamlNode | null | "close"> = [root];
  while (work.length > 0) {
    const node = work.pop()!;
    if (node === "close") {
      builder.close();
      continue;
    }
    try {
      if (node === null) throw refusal("null-value", "a null");
      if (isAlias(node)) throw refusal("yaml-anchor", "an alias");
      if (node.tag !== undefined) throw refusal("yaml-tag", "a tag");
      if (node.anchor !== undefined) throw refusal("yaml-anchor", "an anchor");
      if (isScalar(node)) {
        const written = wellFormed(node.value === null || node.value === undefined ? "" : String(node.value));
        const plain = node.type === "PLAIN" || node.type === undefined;
        const typed: Typed = plain ? coreScalar(written) : { kind: "text" };
        if (builder.wantsKey()) {
          if (typed.kind !== "text") throw refusal("non-string-key", "a mapping key that is not a string");
          if (written === "<<") throw refusal("yaml-merge-key", "a merge key");
          builder.key(written);
        } else {
          builder.value(typed.kind === "text" ? written : typed.value);
        }
      } else if (builder.wantsKey()) {
        throw refusal("non-string-key", "a mapping key that is not a string");
      } else if (isSeq(node)) {
        builder.openList();
        work.push("close");
        for (let at = node.items.length - 1; at >= 0; at -= 1) work.push(node.items[at] as YamlNode | null);
      } else if (isMap(node)) {
        builder.openMap();
        work.push("close");
        for (let at = node.items.length - 1; at >= 0; at -= 1) {
          const pair = node.items[at]!;
          work.push(pair.value as YamlNode | null);
          work.push(pair.key as YamlNode | null);
        }
      } else {
        throw refusal("parse-error", "not valid YAML");
      }
    } catch (error) {
      if (error instanceof AosError && error.line === undefined && node !== null) {
        const placed = where(node as YamlNode);
        if (placed.line !== undefined) error.at(placed.line, placed.column ?? 1);
      }
      throw error;
    }
  }
  return builder.root ?? new Map();
}
