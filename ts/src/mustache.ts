/** The Mustache renderer of the knowledge section: the stock `mustache` package (mustache.js), which follows the official specification, behind one function so another library can replace it. Partials are served files of the overlay, found by the caller. */
import Mustache from "mustache";
import { KnowledgeError } from "./knowledge_base.ts";
import type { Limit } from "./limits.ts";
import type { Document, Value } from "./value.ts";

/** A partial the caller found: the file it is (to resolve the partials inside it from) and its text. */
export interface MustachePartial {
  readonly path: string;
  readonly text: string;
}

/** What `mustache` is given besides the template and its data. */
export interface MustacheOptions {
  /** `html` (the default) escapes `& < > "` in `{{x}}`; `none` inserts every value as it is. */
  readonly escape?: "html" | "none" | undefined;
  /** Finds the partial `name` named by a tag in the file `from`, or `null` for none, which renders as nothing. */
  readonly partial?: ((name: string, from: string | undefined) => MustachePartial | null) | undefined;
  /** The file the template is, given to `partial` as `from`. */
  readonly path?: string | undefined;
  /** Partials one in another; one more is `include-error`. `null` is no bound. */
  readonly maxIncludeDepth?: Limit | undefined;
}

const HTML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** A value as the reference writes it: text as it is, an integer in decimal, a boolean `true` or `false`, anything else as nothing. */
function text(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

/** The data as plain JavaScript for the library: mappings as objects with no prototype, integers as numbers. */
function plain(value: Value): unknown {
  if (value instanceof Map) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of value) Object.defineProperty(out, key, { value: plain(item), enumerable: true, writable: true, configurable: true });
    return out;
  }
  if (Array.isArray(value)) return value.map(plain);
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * `template` rendered by Mustache over `data`, a mapping of the roots `overlay`, `project`, `caller`, `env`, `options` and `context`. Throws `KnowledgeError` `template-error` where the library refuses the template and `include-error` for partials nested past `maxIncludeDepth`.
 */
export function mustache(template: string, data: Document, options: MustacheOptions = {}): string {
  const writer = new Mustache.Writer();
  const html = (options.escape ?? "html") === "html";
  const escape = (value: unknown): string => (html ? text(value).replace(/[&<>"]/g, (char) => HTML[char]!) : text(value));
  // The reference's text for a value, whatever the library would print for a list or an object.
  writer.escapedValue = (token, context) => {
    const value: unknown = context.lookup(token[1]!);
    return value == null ? (undefined as never) : escape(value);
  };
  writer.unescapedValue = (token, context) => {
    const value: unknown = context.lookup(token[1]!);
    return value == null ? (undefined as never) : text(value);
  };
  const files: Array<string | undefined> = [options.path];
  const resolve = options.partial;
  const partials = (name: string): string | undefined => {
    if (resolve === undefined || name === "") return undefined;
    const found = resolve(name, files[files.length - 1]);
    if (found === null) return undefined;
    if (options.maxIncludeDepth !== undefined && options.maxIncludeDepth !== null && files.length > options.maxIncludeDepth) {
      throw new KnowledgeError("include-error", "partials are nested too deep");
    }
    files.push(found.path);
    return found.text;
  };
  const inner = writer.renderPartial.bind(writer);
  writer.renderPartial = (token, context, partialsArg, config) => {
    const before = files.length;
    try {
      return inner(token, context, partialsArg, config);
    } finally {
      files.length = before;
    }
  };
  try {
    return writer.render(template, plain(data) as object, partials, { escape });
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError("template-error", error instanceof Error ? error.message : "the template is refused");
  }
}
