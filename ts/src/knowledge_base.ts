/** Knowledge served through MCP (`spec/v0/knowledge.md`): the settings, the refusal, written-out text and lines that every part shares. */
import { type Limit, limitText } from "./limits.ts";

const MIB = 1024 * 1024;
const encoder = new TextEncoder();

/** Every knowledge setting's key (as a configuration writes it), field and default. */
const DEFINITIONS = [
  ["max_file_bytes", "maxFileBytes", MIB],
  ["max_read_bytes", "maxReadBytes", 64 * 1024],
  ["max_rendered_bytes", "maxRenderedBytes", MIB],
  ["max_query_characters", "maxQueryCharacters", 1000],
  ["max_top", "maxTop", 100],
  ["max_context_bytes", "maxContextBytes", 16 * 1024],
  ["max_context_depth", "maxContextDepth", 8],
  ["max_template_depth", "maxTemplateDepth", 32],
  ["max_include_depth", "maxIncludeDepth", 5],
] as const;

type Field = (typeof DEFINITIONS)[number][1];

/** The knowledge limits, each a {@link Limit}. */
export type KnowledgeSettingsValues = { readonly [K in Field]: Limit };

/** A knowledge setting that differs from its default. */
export interface KnowledgeNonDefault {
  /** The setting's key as a configuration writes it, such as `max_top`. */
  readonly setting: string;
  readonly value: string;
  readonly default: string;
}

/**
 * The limits of serving knowledge, each with a default and no floor: a file served (1 MiB), the text of one read (64 KiB), a
 * rendered template (1 MiB), a query (1000 characters), `top` (100), a call's context (16 KiB and 8 levels), Mustache
 * sections nested (32) and `@path` includes nested (5). Immutable.
 */
export class KnowledgeSettings implements KnowledgeSettingsValues {
  readonly maxFileBytes!: Limit;
  readonly maxReadBytes!: Limit;
  readonly maxRenderedBytes!: Limit;
  readonly maxQueryCharacters!: Limit;
  readonly maxTop!: Limit;
  readonly maxContextBytes!: Limit;
  readonly maxContextDepth!: Limit;
  readonly maxTemplateDepth!: Limit;
  readonly maxIncludeDepth!: Limit;

  constructor(changes: Partial<KnowledgeSettingsValues> = {}) {
    for (const [, field, byDefault] of DEFINITIONS) {
      const given = changes[field];
      const limit = given === undefined ? byDefault : given;
      if (limit !== null && !(Number.isSafeInteger(limit) && limit >= 0)) {
        throw new RangeError(`${field}: a whole number, 0 or more, or null for no bound`);
      }
      (this as { -readonly [K in Field]: Limit })[field] = limit;
    }
    Object.freeze(this);
  }

  /** A copy with these limits changed. */
  with(changes: Partial<KnowledgeSettingsValues>): KnowledgeSettings {
    return new KnowledgeSettings({ ...this.values(), ...changes });
  }

  /** The limits as a plain object. */
  values(): KnowledgeSettingsValues {
    const out: Partial<Record<Field, Limit>> = {};
    for (const [, field] of DEFINITIONS) out[field] = this[field];
    return out as KnowledgeSettingsValues;
  }

  /** Reads settings as a configuration writes them: snake_case keys (`max_top`), a number or `bigint`, `null` or `"none"`. An unknown key is refused. */
  static fromData(data: Record<string, unknown> | ReadonlyMap<string, unknown>): KnowledgeSettings {
    const changes: Partial<Record<Field, Limit>> = {};
    const entries = data instanceof Map ? [...data.entries()] : Object.entries(data);
    for (const [key, value] of entries) {
      const definition = DEFINITIONS.find(([name]) => name === key);
      if (definition === undefined) throw new RangeError("unknown setting");
      let limit: unknown = value;
      if (value === "none") limit = null;
      else if (typeof value === "bigint") limit = value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.NaN : Number(value);
      changes[definition[1]] = limit as Limit;
    }
    return new KnowledgeSettings(changes);
  }

  /** Every setting that differs from its default, to report. */
  nonDefaults(): KnowledgeNonDefault[] {
    const out: KnowledgeNonDefault[] = [];
    for (const [setting, field, byDefault] of DEFINITIONS) {
      if (this[field] !== byDefault) out.push({ setting, value: limitText(this[field]), default: limitText(byDefault) });
    }
    return out;
  }
}

/** The default knowledge settings. */
export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = new KnowledgeSettings();

/** The classes a refused call is one of. */
export const KNOWLEDGE_ERROR_CLASSES = [
  "invalid-arguments",
  "invalid-path",
  "unknown-overlay",
  "ambiguous",
  "not-found",
  "link",
  "not-text",
  "too-large",
  "include-error",
  "invalid-option",
  "template-error",
  "line-range",
  "unavailable",
  "mode-unavailable",
] as const;

/** One of {@link KNOWLEDGE_ERROR_CLASSES}. */
export type KnowledgeErrorClass = (typeof KNOWLEDGE_ERROR_CLASSES)[number];

/** A refused call. `class` is the contract; `message` is for a person and never parsed. */
export class KnowledgeError extends Error {
  readonly class: KnowledgeErrorClass;

  constructor(code: KnowledgeErrorClass, message = "") {
    super(message === "" ? code : `${code}: ${message}`);
    this.name = "KnowledgeError";
    this.class = code;
    this.detail = message === "" ? code : message;
  }

  /** The text for a person, as the result's `message`. */
  readonly detail: string;
}

/** The mode names a search may declare, in the order a list gives them. */
export const SEARCH_MODES = ["words", "meaning", "llm"] as const;

/** A declared search mode. */
export type SearchMode = (typeof SEARCH_MODES)[number];

function hides(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x206f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x2060 && code <= 0x2064) ||
    code === 0x061c ||
    code === 0xfeff ||
    code === 0x00ad ||
    code === 0x180e ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0000 && code <= 0xe007f) ||
    (code >= 0xe0100 && code <= 0xe01ef) ||
    code === 0x115f ||
    code === 0x1160 ||
    code === 0x3164 ||
    code === 0xffa0 ||
    code === 0x034f ||
    (code >= 0x17b4 && code <= 0x17b5) ||
    (code >= 0x1d173 && code <= 0x1d17a) ||
    (code >= 0xfff9 && code <= 0xfffb)
  );
}

/** Whether a character of `text` is one written out. */
export function hidesCharacter(code: number): boolean {
  return hides(code);
}

/** Text as an agent may receive it: each control character but tab and line feed, and each character that hides or reorders text, written `<U+XXXX>`. */
export function inert(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === "\n" || char === "\t") out += char;
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || hides(code)) out += `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
    else out += char;
  }
  return out;
}

/** A file's lines: split at line feed, a carriage return before the line feed dropped (one anywhere else kept), no line after a final line feed, none in an empty text. */
export function knowledgeLines(text: string): string[] {
  const parts = text.split("\n");
  const last = parts.pop()!;
  const lines = parts.map((part) => (part.endsWith("\r") ? part.slice(0, -1) : part));
  if (last !== "") lines.push(last);
  return lines;
}

/** Whether `n` is within `limit` (`null` is no bound). */
export function within(limit: Limit, n: number): boolean {
  return limit === null || n <= limit;
}

/** The size of text in bytes of UTF-8. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}
