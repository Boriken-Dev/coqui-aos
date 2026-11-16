/** Knowledge served through MCP (`spec/v0/knowledge.md`): the tools' schemas, their arguments, `kb_list` and `kb_read` over an overlay's files, templates rendered per call, the MCP result and the hint. The core reads no file: a tree is handed in, or built through a `FileSystem`. */
import { AosError } from "./error.ts";
import { contextOf as contextOfTree, declared, named, rulesOf as rulesOfTree } from "./defaults.ts";
import { splitFrontMatter } from "./front_matter.ts";
import type { FileKind, FileSystem } from "./fs.ts";
import { joinPath } from "./fs.ts";
import { MANIFEST_FILES } from "./kinds.ts";
import { DEFAULT_SETTINGS } from "./limits.ts";
import { EXCLUDED_COMPONENTS, asciiLower, isSensitiveVariable, normalizeName, validRelativePath } from "./names.ts";
import { DEFAULT_KNOWLEDGE_SETTINGS, KnowledgeError, type KnowledgeErrorClass, type KnowledgeSettings, SEARCH_MODES, type SearchMode, byteLength, hidesCharacter, inert, knowledgeLines, within } from "./knowledge_base.ts";
import { IMPLEMENTED_FEATURES, envsubst, envsubstOptions } from "./envsubst.ts";
import { mustache } from "./mustache.ts";
import { type TemplateFacts, template, templateValues } from "./template.ts";
import { OverlayTree } from "./tree.ts";
import { compareText, decodeUtf8, encodeUtf8 } from "./text.ts";
import { type Document, type Value, fromPlain } from "./value.ts";

export * from "./knowledge_base.ts";
export { mustache } from "./mustache.ts";

const MAX_INTEGER = 9007199254740991n;
const DEFAULT_TOP = 5;
const KB_DIRS = ["kb", "flows", "references", "rules", "context"];
const ENGINES = ["envsubst", "mustache"];
const AS_WRITTEN = ["markdown", "md", "raw"];
const EXPANDED = ["aos", "agentic"];

/** One entry of an overlay's tree: a file with its bytes, or what else the path is (a link is never followed). */
export interface KnowledgeEntry {
  readonly path: string;
  readonly kind: FileKind;
  /** The bytes of a file; at most `maxFileBytes` + 1 of them are needed. */
  readonly bytes?: Uint8Array | undefined;
}

/** One active overlay of a session, as the knowledge tools see it. */
export interface KnowledgeOverlay {
  /** The identity the consumer holds the overlay under, as `kb_list` and `kb_read` answer it. */
  readonly identity: string;
  /** The overlay's manifest. */
  readonly manifest: Document;
  /** Every entry of the tree, links and directories included. */
  readonly tree: readonly KnowledgeEntry[];
  /** Whether the consumer left this overlay's `rules` and `context` files out of the context because they are served. */
  readonly served: boolean;
  /** What a template reads of the overlay: its root, state, scope, project and configured options. */
  readonly facts: TemplateFacts;
}

/** What a template reads of the call's caller. A fact with no value is absent. */
export interface CallerFacts {
  /** The role and profile the consumer has the agent in, as its own labels. */
  readonly caller?: { readonly role?: string | undefined; readonly profile?: string | undefined } | undefined;
  /** The consumer's environment, by name. */
  readonly env?: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined;
  /** The names the user allowed templates to read; a sensitive one is never given. */
  readonly envAllow?: readonly string[] | undefined;
}

/** A call's outcome: a result object, or a refusal. */
export type KnowledgeOutcome = { readonly result: Record<string, unknown> } | { readonly error: { readonly class: KnowledgeErrorClass; readonly message: string } };

/** MCP's `tools/call` result: the same JSON as `structuredContent` and as one text block. */
export interface KnowledgeResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: Record<string, unknown>;
  readonly isError: boolean;
}

/** A tool as `tools/list` names it. */
export interface KnowledgeTool {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
}

function ordered(modes: Iterable<string>): SearchMode[] {
  const given = new Set(modes);
  return SEARCH_MODES.filter((mode) => given.has(mode));
}

/** The tools `tools/list` names, in order, with their input schemas and no descriptions: `kb_list`, `kb_read` and, when `modes` is not empty, `kb_search`. */
export function knowledgeTools(modes: Iterable<string>, settings: KnowledgeSettings = DEFAULT_KNOWLEDGE_SETTINGS): KnowledgeTool[] {
  const declaredModes = ordered(modes);
  const line = (): Record<string, unknown> => ({ type: "integer", minimum: 1, maximum: Number(MAX_INTEGER) });
  const tools: KnowledgeTool[] = [
    { name: "kb_list", inputSchema: { type: "object", properties: { overlay: { type: "string" } }, additionalProperties: false } },
    {
      name: "kb_read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, from: line(), to: line(), overlay: { type: "string" }, context: { type: "object" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ];
  if (declaredModes.length > 0) {
    const query: Record<string, unknown> = { type: "string", minLength: 1 };
    if (settings.maxQueryCharacters !== null) query["maxLength"] = settings.maxQueryCharacters;
    const top: Record<string, unknown> = { type: "integer", minimum: 1 };
    if (settings.maxTop !== null) top["maximum"] = settings.maxTop;
    top["default"] = DEFAULT_TOP;
    tools.push({
      name: "kb_search",
      inputSchema: {
        type: "object",
        properties: { query, top, overlay: { type: "string" }, mode: { type: "string", enum: ["auto", ...declaredModes], default: "auto" }, path: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    });
  }
  return tools;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function contextOk(value: unknown, depth: number, budget: { n: number }, settings: KnowledgeSettings): boolean {
  if (!within(settings.maxContextDepth, depth)) return false;
  if (typeof value === "boolean") return true;
  if (typeof value === "bigint") return (value < 0n ? -value : value) <= MAX_INTEGER;
  if (typeof value === "string") {
    budget.n += byteLength(value);
    return within(settings.maxContextBytes, budget.n);
  }
  if (Array.isArray(value)) return value.every((item) => contextOk(item, depth + 1, budget, settings));
  if (value instanceof Map) {
    for (const [key, item] of value) {
      if (!IDENT.test(key)) return false;
      budget.n += byteLength(key);
      if (!within(settings.maxContextBytes, budget.n)) return false;
      if (!contextOk(item, depth + 1, budget, settings)) return false;
    }
    return true;
  }
  return false;
}

/** The arguments of a call with the defaults applied. A `null` is the argument absent; integers are `bigint`s in `arguments` (see `fromPlain`) and plain numbers in the result; `context` stays a mapping. Throws `invalid-arguments`. */
export function knowledgeArguments(
  tool: string,
  args: unknown,
  modes: Iterable<string>,
  settings: KnowledgeSettings = DEFAULT_KNOWLEDGE_SETTINGS,
): Record<string, unknown> {
  const schema = knowledgeTools(modes, settings).find((candidate) => candidate.name === tool)?.inputSchema;
  if (schema === undefined) throw new KnowledgeError("invalid-arguments", `no tool is named ${tool}`);
  if (!(args instanceof Map)) throw new KnowledgeError("invalid-arguments", "the arguments are an object");
  const properties = schema["properties"] as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of args) {
    const spec = Object.hasOwn(properties, key) ? properties[key]! : undefined;
    if (spec === undefined) throw new KnowledgeError("invalid-arguments", `no argument is named ${key}`);
    if (value === null) continue;
    if (spec["type"] === "string") {
      if (typeof value !== "string") throw new KnowledgeError("invalid-arguments", `${key} is text`);
      const choices = spec["enum"] as string[] | undefined;
      if (choices !== undefined && !choices.includes(value)) throw new KnowledgeError("invalid-arguments", `${key} is not one of its values`);
      if (key === "query") {
        const longest = spec["maxLength"] as number | undefined;
        if ((longest !== undefined && [...value].length > longest) || !/[^ \t\n\v\f\r]/.test(value)) {
          throw new KnowledgeError("invalid-arguments", "the query is empty or too long");
        }
      }
    } else if (spec["type"] === "integer") {
      if (typeof value !== "bigint") throw new KnowledgeError("invalid-arguments", `${key} is a whole number`);
      const high = spec["maximum"] as number | undefined;
      if (value < BigInt(spec["minimum"] as number) || (high !== undefined && value > BigInt(high))) {
        throw new KnowledgeError("invalid-arguments", `${key} is out of range`);
      }
      out[key] = Number(value);
      continue;
    } else if (!(value instanceof Map) || !contextOk(value, 1, { n: 0 }, settings)) {
      throw new KnowledgeError("invalid-arguments", `${key} is not a usable context`);
    }
    out[key] = value;
  }
  for (const key of (schema["required"] as string[] | undefined) ?? []) {
    if (!(key in out)) throw new KnowledgeError("invalid-arguments", `${key} is required`);
  }
  if (tool === "kb_search") {
    out["top"] ??= DEFAULT_TOP;
    out["mode"] ??= "auto";
  }
  return out;
}

/** One file of an overlay's knowledge. */
export interface KnowledgeFile {
  /** The stored text. */
  readonly text: string;
  /** The engine the first line of a markdown file names, other than `markdown`, `md`, `raw`, `aos` and `agentic`; `null` for none. */
  readonly engine: string | null;
  /** The `name=value` options of the first line, as written. */
  readonly options: Readonly<Record<string, string>>;
  /** Whether the file is served as written: a markdown file naming `markdown`, `md` or `raw`, and every file that is not markdown. */
  readonly raw: boolean;
  /** The stored size. */
  readonly bytes: number;
  /** The text after the first line when the file names a format, else all of it. */
  readonly rest: string;
}

/** An overlay's knowledge: the files served and the files skipped, in the order of their paths as UTF-8 bytes. */
export interface KnowledgeSet {
  readonly files: ReadonlyMap<string, KnowledgeFile>;
  /** `[path, reason]` with the reason `name`, `too-large` or `not-text`. */
  readonly skipped: ReadonlyArray<readonly [string, string]>;
  readonly entries: ReadonlyMap<string, KnowledgeEntry>;
}

function selected(path: string, manifest: Document): boolean {
  if ((MANIFEST_FILES as readonly string[]).includes(path) || !validRelativePath(path)) return false;
  const parts = path.split("/");
  for (const field of ["rules", "context"]) {
    for (const entry of declared(manifest, field)) if (named(entry) === path) return true;
  }
  return (parts.length > 1 && KB_DIRS.includes(parts[0]!)) || path === "CONTEXT.md";
}

const hasHidden = (path: string): boolean => [...path].some((char) => hidesCharacter(char.codePointAt(0)!));

const OPTION = /^([a-z][a-z_]*)=([^\s]+)$/;

/** The name and the options the first line of `data` gives its format, or `null` for none: `#!` and words, a word `name=value` an option, the last of the others, after any `/` or `\`, with leading dots dropped and ASCII capitals lower-cased, the name. */
export function formatLine(data: Uint8Array): { readonly name: string; readonly options: Readonly<Record<string, string>> } | null {
  if (data.length < 2 || data[0] !== 0x23 || data[1] !== 0x21) return null;
  let stop = data.indexOf(0x0a);
  if (stop < 0) stop = data.length;
  let line: string;
  try {
    line = decodeUtf8(data.subarray(2, stop));
  } catch {
    return null;
  }
  const options: Record<string, string> = Object.create(null) as Record<string, string>;
  const names: string[] = [];
  for (const word of line.split(/[ \t\x0c\r]+/)) {
    if (word === "") continue;
    const found = OPTION.exec(word);
    if (found === null) names.push(word);
    else options[found[1]!] = found[2]!;
  }
  if (names.length === 0) return null;
  const name = names[names.length - 1]!.split(/[/\\]/).pop()!.replace(/^\.+/, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
  return name === "" ? null : { name, options };
}

/** The name the first line of `data` gives its format, or `null`. */
export function formatName(data: Uint8Array): string | null {
  return formatLine(data)?.name ?? null;
}

const afterFirstLine = (text: string): string => {
  const end = text.indexOf("\n");
  return end < 0 ? "" : text.slice(end + 1);
};

/** An overlay's knowledge: its files under `kb/`, `flows/`, `references/`, `rules/` and `context/`, the root `CONTEXT.md` and the files `rules` and `context` name, served or skipped, each with the format its first line names. */
export function knowledgeSet(overlay: KnowledgeOverlay, settings: KnowledgeSettings = DEFAULT_KNOWLEDGE_SETTINGS): KnowledgeSet {
  const entries = new Map<string, KnowledgeEntry>();
  for (const entry of overlay.tree) entries.set(entry.path, entry);
  const files = new Map<string, KnowledgeFile>();
  const skipped: Array<readonly [string, string]> = [];
  for (const path of [...entries.keys()].sort(compareText)) {
    const entry = entries.get(path)!;
    if (entry.kind !== "file" || !selected(path, overlay.manifest)) continue;
    const data = entry.bytes ?? new Uint8Array(0);
    if (hasHidden(path)) {
      skipped.push([path, "name"]);
      continue;
    }
    if (!within(settings.maxFileBytes, data.length)) {
      skipped.push([path, "too-large"]);
      continue;
    }
    let text: string;
    try {
      text = decodeUtf8(data);
    } catch {
      skipped.push([path, "not-text"]);
      continue;
    }
    const lower = asciiLower(path);
    const markdown = lower.endsWith(".md") || lower.endsWith(".markdown");
    const line = markdown ? formatLine(data) : null;
    const name = line?.name ?? null;
    const engine = name === null || AS_WRITTEN.includes(name) || EXPANDED.includes(name) ? null : name;
    files.set(path, { text, engine, options: line?.options ?? {}, raw: !markdown || (name !== null && AS_WRITTEN.includes(name)), bytes: data.length, rest: name === null ? text : afterFirstLine(text) });
  }
  return { files, skipped, entries };
}

function choose(overlays: readonly KnowledgeOverlay[], wanted: unknown): readonly KnowledgeOverlay[] {
  if (wanted === undefined || wanted === null) return overlays;
  const want = normalizeName(String(wanted));
  const chosen = overlays.filter((overlay) => normalizeName(overlay.identity) === want);
  if (chosen.length === 0) throw new KnowledgeError("unknown-overlay", String(wanted));
  return chosen;
}

/** The overlays a call asks, by its `overlay` argument; throws `unknown-overlay`. */
export function chooseOverlays(overlays: readonly KnowledgeOverlay[], wanted: string | undefined): readonly KnowledgeOverlay[] {
  return choose(overlays, wanted);
}

function failure(error: KnowledgeError): KnowledgeOutcome {
  return { error: { class: error.class, message: error.detail } };
}

/** The engines `engines` names that this package renders, in the order `envsubst`, `mustache`, then the option values it lacks, each as `-engine:option=value`. */
function renderable(engines: Iterable<string>): string[] {
  const given = new Set(engines);
  const lacks = [...given].filter((entry) => entry.startsWith("-"));
  return [...ENGINES.filter((engine) => given.has(engine)), ...lacks];
}

/** What a server answers a call of `kb_list` or `kb_read`: `{ result }` or `{ error: { class, message } }`. `modes` are the declared search modes, `engines` the template engines this server renders with (`envsubst` and `mustache` by default, with any `-engine:option=value` entry naming an option value it cannot honour: a file whose first line gives it is served as written, `rendered` false); `arguments` are as `knowledgeArguments` reads them. */
export function knowledgeCall(
  tool: string,
  overlays: readonly KnowledgeOverlay[],
  args: unknown,
  modes: Iterable<string> = [],
  settings: KnowledgeSettings = DEFAULT_KNOWLEDGE_SETTINGS,
  caller: CallerFacts = {},
  engines: Iterable<string> = ENGINES,
): KnowledgeOutcome {
  const declaredModes = [...modes];
  const names = renderable(engines);
  try {
    const checked = knowledgeArguments(tool, args, declaredModes, settings);
    if (tool === "kb_list") return { result: listResult(overlays, checked, declaredModes, settings, names, caller) };
    if (tool === "kb_read") return { result: readResult(overlays, checked, settings, caller, names) };
    throw new KnowledgeError("invalid-arguments", `no tool is named ${tool}`);
  } catch (error) {
    if (error instanceof KnowledgeError) return failure(error);
    throw error;
  }
}

function listResult(
  overlays: readonly KnowledgeOverlay[],
  args: Record<string, unknown>,
  modes: readonly string[],
  settings: KnowledgeSettings,
  engines: readonly string[],
  caller: CallerFacts,
): Record<string, unknown> {
  const listed = [];
  for (const overlay of choose(overlays, args["overlay"])) {
    const found = knowledgeSet(overlay, settings);
    const files: Array<Record<string, unknown>> = [];
    const skipped = [...found.skipped];
    for (const [path, item] of found.files) {
      let text: string;
      try {
        text = servedText(overlay, found, path, new Map(), caller, settings, engines);
      } catch (error) {
        if (!(error instanceof KnowledgeError)) throw error;
        skipped.push([path, "render"]);
        continue;
      }
      const entry: Record<string, unknown> = { path, lines: knowledgeLines(text).length, bytes: byteLength(text) };
      if (item.engine !== null) {
        entry["template"] = item.engine;
        entry["rendered"] = renders(item, engines);
      }
      files.push(entry);
    }
    skipped.sort((a, b) => compareText(a[0], b[0]));
    listed.push({
      overlay: overlay.identity,
      served: overlay.served,
      files,
      skipped: skipped.map(([path, reason]) => ({ path: inert(path), reason })),
    });
  }
  const result: Record<string, unknown> = { overlays: listed, engines: engines.filter((engine) => !engine.startsWith("-")) };
  if (ordered(modes).length > 0) result["search"] = { modes: ordered(modes) };
  return result;
}

const SKIP_CLASS: Record<string, KnowledgeErrorClass> = {
  name: "invalid-path",
  "too-large": "too-large",
  "not-text": "not-text",
};
const PRIORITY: readonly KnowledgeErrorClass[] = ["link", "not-text", "too-large", "not-found"];

function readResult(
  overlays: readonly KnowledgeOverlay[],
  args: Record<string, unknown>,
  settings: KnowledgeSettings,
  caller: CallerFacts,
  engines: readonly string[],
): Record<string, unknown> {
  const path = args["path"] as string;
  if (!validRelativePath(path) || hasHidden(path)) throw new KnowledgeError("invalid-path", inert(path));
  const found: Array<[KnowledgeOverlay, KnowledgeSet]> = [];
  const problems: KnowledgeErrorClass[] = [];
  const parts = path.split("/");
  for (const overlay of choose(overlays, args["overlay"])) {
    const held = knowledgeSet(overlay, settings);
    const linked = parts.some((_, n) => held.entries.get(parts.slice(0, n + 1).join("/"))?.kind === "symlink");
    if (linked) problems.push("link");
    else if (held.files.has(path)) found.push([overlay, held]);
    else {
      const reason = held.skipped.find(([skippedPath]) => skippedPath === path)?.[1];
      problems.push(reason === undefined ? "not-found" : SKIP_CLASS[reason]!);
    }
  }
  if (found.length > 1) throw new KnowledgeError("ambiguous", "more than one overlay has that path");
  if (found.length === 0) {
    const first = PRIORITY.find((cls) => problems.includes(cls)) ?? "not-found";
    throw new KnowledgeError(first, inert(path));
  }
  const [overlay, held] = found[0]!;
  const engine = held.files.get(path)!.engine;
  const text = servedText(overlay, held, path, (args["context"] as Document | undefined) ?? new Map(), caller, settings, engines);
  const lines = knowledgeLines(text);
  const total = lines.length;
  const start = (args["from"] as number | undefined) ?? 1;
  const stop = args["to"] as number | undefined;
  if ((stop !== undefined && stop < start) || start > Math.max(total, 1)) throw new KnowledgeError("line-range", `the file has ${total} lines`);
  const last = stop === undefined ? total : Math.min(stop, total);
  const chosen: string[] = [];
  let size = 0;
  let truncated = false;
  for (const line of lines.slice(start - 1, last)) {
    const add = byteLength(line) + (chosen.length > 0 ? 1 : 0);
    if (chosen.length > 0 && !within(settings.maxReadBytes, size + add)) {
      truncated = true;
      break;
    }
    chosen.push(line);
    size += add;
  }
  const result: Record<string, unknown> = {
    overlay: overlay.identity,
    path,
    from_line: start,
    to_line: start - 1 + chosen.length,
    total_lines: total,
    truncated,
    text: inert(chosen.join("\n")),
  };
  if (engine !== null) {
    result["template"] = engine;
    result["rendered"] = renders(held.files.get(path)!, engines);
  }
  return result;
}

/** Whether this server renders the file's engine with the options its first line asks for: an `envsubst` file asking for a feature this renderer lacks is served as for an engine the server does not have. */
function renders(item: KnowledgeFile, engines: readonly string[]): boolean {
  if (item.engine === null || !engines.includes(item.engine)) return false;
  for (const [key, value] of Object.entries(item.options)) if (engines.includes(`-${item.engine}:${key}=${value}`)) return false;
  if (item.engine !== "envsubst") return true;
  try {
    return [...envsubstOptions(item.options).features].every((feature) => IMPLEMENTED_FEATURES.has(feature));
  } catch {
    return true;
  }
}

function allowedEnv(caller: CallerFacts): Map<string, string> {
  const env = caller.env instanceof Map ? caller.env : new Map(Object.entries(caller.env ?? {}));
  const out = new Map<string, string>();
  for (const name of caller.envAllow ?? []) {
    const value = env.get(name);
    if (typeof value === "string" && !isSensitiveVariable(name)) out.set(name, value);
  }
  return out;
}

function optionTypeOk(kind: Value | undefined, value: Value): boolean {
  return (kind === "string" && typeof value === "string") || (kind === "integer" && typeof value === "bigint") || (kind === "boolean" && typeof value === "boolean");
}

function overlayFacts(overlay: KnowledgeOverlay): TemplateFacts {
  return { ...overlay.facts, name: overlay.facts.name ?? normalizeName(overlay.identity) };
}

/** What a template reads: the roots `overlay`, `project`, `caller`, `env`, `options` and `context`, each with what it holds; a sensitive option or variable is never in it. */
function templateData(overlay: KnowledgeOverlay, context: Document, caller: CallerFacts): Document {
  const facts = overlayFacts(overlay);
  const options: Document = new Map();
  const configured = facts.options ?? new Map<string, Value>();
  const declaredOptions = overlay.manifest.get("options");
  if (declaredOptions instanceof Map) {
    for (const [name, spec] of declaredOptions) {
      if (!(spec instanceof Map) || spec.get("sensitive") === true) continue;
      const given = configured.get(name);
      const value = given ?? (spec.has("default") ? spec.get("default") : undefined);
      if (value === undefined) continue;
      if (!optionTypeOk(spec.get("type"), value)) throw new KnowledgeError("invalid-option", name);
      options.set(name, value);
    }
  }
  const overlayData: Document = new Map();
  for (const [key, source] of [["root", facts.root], ["state", facts.state], ["name", facts.name], ["scope", facts.scope]] as const) {
    if (source !== undefined) overlayData.set(key, source);
  }
  const callerData: Document = new Map();
  if (typeof caller.caller?.role === "string") callerData.set("role", caller.caller.role);
  if (typeof caller.caller?.profile === "string") callerData.set("profile", caller.caller.profile);
  return new Map<string, Value>([
    ["overlay", overlayData],
    ["project", facts.project === undefined ? new Map() : new Map([["root", facts.project]])],
    ["caller", callerData],
    ["env", allowedEnv(caller)],
    ["options", options],
    ["context", context],
  ]);
}

/** The names `${NAME}` replaces: the overlay's, its options, the caller's, the allowed environment's and the context's. */
function substitutionValues(overlay: KnowledgeOverlay, data: Document, context: Document): Map<string, string> {
  let values: ReadonlyMap<string, string>;
  try {
    values = templateValues(overlay.manifest, overlayFacts(overlay));
  } catch (error) {
    if (error instanceof AosError) throw new KnowledgeError("invalid-option", error.subject);
    throw error;
  }
  const all = new Map(values);
  const callerData = data.get("caller") as Document;
  if (callerData.has("role")) all.set("AOS_CALLER_ROLE", callerData.get("role") as string);
  if (callerData.has("profile")) all.set("AOS_CALLER_PROFILE", callerData.get("profile") as string);
  for (const [name, value] of data.get("env") as Map<string, string>) all.set(`AOS_ENV_${name}`, value);
  for (const [key, value] of context) {
    if (typeof value === "boolean") all.set(`AOS_ARG_${key}`, value ? "true" : "false");
    else if (typeof value === "bigint" || typeof value === "string") all.set(`AOS_ARG_${key}`, String(value));
  }
  return all;
}

/** A value as one line of flow YAML: keys in UTF-8 byte order, `, ` and `: ` between, in a string only the quotation mark, the backslash and U+0000-U+001F escaped, those as `\u00xx`. */
function flow(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    let out = "";
    for (const char of value) {
      const code = char.codePointAt(0)!;
      if (char === '"' || char === "\\") out += `\\${char}`;
      else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
      else out += char;
    }
    return `"${out}"`;
  }
  if (Array.isArray(value)) return `[${value.map(flow).join(", ")}]`;
  const map = value as Map<string, unknown>;
  const keys = [...map.keys()].sort(compareText);
  return `{${keys.map((key) => `${flow(key)}: ${flow(map.get(key))}`).join(", ")}}`;
}

function contextBlock(engine: string, data: Document): string {
  const parts = [`"engine": ${flow(engine)}`];
  for (const root of ["overlay", "project", "caller", "env", "options", "context"]) {
    const held = data.get(root) as Map<string, unknown>;
    if (held.size > 0) parts.push(`"${root}": ${flow(held)}`);
  }
  return `---\naos_template_context: {${parts.join(", ")}}\n---\n`;
}

interface ServeContext {
  readonly overlay: KnowledgeOverlay;
  readonly held: KnowledgeSet;
  readonly context: Document;
  readonly caller: CallerFacts;
  readonly settings: KnowledgeSettings;
  readonly engines: readonly string[];
  values: Map<string, string> | null;
  added: number;
}

/** An engine's output for a file: rendered here, or the file kept with the context for the agent to read when this server lacks the engine. */
function renderFile(overlay: KnowledgeOverlay, held: KnowledgeSet, path: string, item: KnowledgeFile, context: Document, caller: CallerFacts, settings: KnowledgeSettings, here: boolean): string {
  const data = templateData(overlay, context, caller);
  const engine = item.engine!;
  let out: string;
  if (!here) {
    const end = item.text.indexOf("\n");
    const [first, rest] = end < 0 ? [`${item.text}\n`, ""] : [item.text.slice(0, end + 1), item.text.slice(end + 1)];
    out = first + contextBlock(engine, data) + rest;
  } else if (engine === "envsubst") {
    const values = substitutionValues(overlay, data, context);
    const asked = envsubstOptions(item.options);
    out = envsubst(item.rest, values, asked.pattern, asked.features, asked.undefined);
  } else {
    const escape = item.options["escape"] ?? "html";
    if (escape !== "html" && escape !== "none") throw new KnowledgeError("template-error", "escape is html or none");
    out = mustache(item.rest, data, {
      escape,
      path,
      maxIncludeDepth: settings.maxIncludeDepth,
      partial: (name, from) => {
        const target = from === undefined ? undefined : resolveInclude(from, name, held);
        return target === undefined ? null : { path: target, text: held.files.get(target)!.rest };
      },
    });
  }
  if (!within(settings.maxRenderedBytes, byteLength(out))) throw new KnowledgeError("too-large", "the rendered text");
  return out;
}

/** The text `kb_read` serves for a file of the knowledge, before it is cut into lines: as written, expanded or rendered. */
function servedText(
  overlay: KnowledgeOverlay,
  held: KnowledgeSet,
  path: string,
  context: Document,
  caller: CallerFacts,
  settings: KnowledgeSettings,
  engines: readonly string[],
): string {
  const item = held.files.get(path)!;
  if (item.raw) return item.rest;
  if (item.engine !== null) return renderFile(overlay, held, path, item, context, caller, settings, renders(item, engines));
  const ctx: ServeContext = { overlay, held, context, caller, settings, engines, values: null, added: 0 };
  const out = expand(item.rest, path, ctx, [path]);
  if (!within(settings.maxRenderedBytes, byteLength(out))) throw new KnowledgeError("too-large", "the served text");
  return out;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})/;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/y;
const TRAILING = ".,;:!?)]}'\"";

function opensFence(line: string): [string, number] | undefined {
  const found = FENCE.exec(line);
  return found === null ? undefined : [found[2]![0]!, found[2]!.length];
}

function closesFence(line: string, fence: [string, number]): boolean {
  const found = FENCE.exec(line);
  return found !== null && found[2]![0] === fence[0] && found[2]!.length >= fence[1] && /^[ \t\r\n]*$/.test(line.slice(found[0].length));
}

/** Which characters of a line are in a code span: a run of backticks to the next run of as many on the same line. */
function codeMask(line: string): boolean[] {
  const mask = new Array<boolean>(line.length).fill(false);
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === "`") j += 1;
    let k = j;
    let end = -1;
    while (k < line.length) {
      if (line[k] === "`") {
        let m = k;
        while (m < line.length && line[m] === "`") m += 1;
        if (m - k === j - i) {
          end = m;
          break;
        }
        k = m;
      } else k += 1;
    }
    if (end < 0) i = j;
    else {
      for (let n = i; n < end; n += 1) mask[n] = true;
      i = end;
    }
  }
  return mask;
}

function expand(text: string, path: string, ctx: ServeContext, chain: readonly string[]): string {
  const out: string[] = [];
  let fence: [string, number] | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    if (fence !== undefined) {
      out.push(expandLine(line, new Array<boolean>(line.length).fill(true), path, ctx, chain));
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    fence = opensFence(line);
    out.push(expandLine(line, fence === undefined ? codeMask(line) : new Array<boolean>(line.length).fill(true), path, ctx, chain));
  }
  return out.join("");
}

function expandLine(line: string, inCode: readonly boolean[], path: string, ctx: ServeContext, chain: readonly string[]): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (!inCode[i] && line.startsWith("$$", i)) {
      out += "$";
      i += 2;
      continue;
    }
    if (!inCode[i] && line[i] === "$") {
      PLACEHOLDER.lastIndex = i;
      const found = PLACEHOLDER.exec(line);
      if (found !== null) {
        ctx.values ??= substitutionValues(ctx.overlay, templateData(ctx.overlay, ctx.context, ctx.caller), ctx.context);
        const value = ctx.values.get(found[1]!);
        if (value !== undefined) {
          out += value;
          i += found[0].length;
          continue;
        }
      }
    }
    if (line[i] === "@" && !inCode[i] && (i === 0 || " \t\r\f\v".includes(line[i - 1]!))) {
      let name = /^[^ \t\r\n\f\v]*/.exec(line.slice(i + 1))![0];
      while (name !== "" && TRAILING.includes(name[name.length - 1]!)) name = name.slice(0, -1);
      const target = name === "" ? undefined : resolveInclude(path, name, ctx.held);
      const included = target === undefined ? undefined : include(target, ctx, chain);
      if (included !== undefined) {
        out += included;
        i += 1 + name.length;
        continue;
      }
    }
    out += line[i]!;
    i += 1;
  }
  return out;
}

/** The file of the knowledge an include names, or `undefined`: resolved from the including file's folder, `..` rising only to the root. */
function resolveInclude(path: string, name: string, held: KnowledgeSet): string | undefined {
  if ("/~".includes(name[0]!) || name.includes("\\") || /^[A-Za-z]:/.test(name)) return undefined;
  const parts = path.split("/").slice(0, -1);
  for (const part of name.split("/")) {
    if (part === "") return undefined;
    if (part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  const target = parts.join("/");
  return validRelativePath(target) && held.files.has(target) ? target : undefined;
}

function include(target: string, ctx: ServeContext, chain: readonly string[]): string | undefined {
  const item = ctx.held.files.get(target)!;
  const { settings } = ctx;
  let text: string;
  if (item.raw) text = item.rest;
  else if (item.engine !== null) {
    if (!renders(item, ctx.engines)) return undefined;
    text = renderFile(ctx.overlay, ctx.held, target, item, ctx.context, ctx.caller, settings, true);
  } else {
    if (chain.includes(target)) throw new KnowledgeError("include-error", `an include comes back to ${target}`);
    if (settings.maxIncludeDepth !== null && chain.length > settings.maxIncludeDepth) throw new KnowledgeError("include-error", "includes are nested too deep");
    let body = item.rest;
    const bytes = encodeUtf8(body);
    const split = splitFrontMatter(bytes, DEFAULT_SETTINGS);
    if (split.case === "present" || split.case === "empty") body = decodeUtf8(bytes.subarray(split.bodyOffset ?? 0));
    text = expand(body, target, ctx, [...chain, target]);
  }
  ctx.added += byteLength(text);
  if (!within(settings.maxRenderedBytes, ctx.added)) throw new KnowledgeError("too-large", "the included text");
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** The text `kb_read` serves for a file, called with no `context`, as `kb_list` and a search count it. Throws `KnowledgeError` for a file whose text cannot be made. */
export function servedFileText(
  overlay: KnowledgeOverlay,
  held: KnowledgeSet,
  path: string,
  options: { readonly context?: Document | undefined; readonly caller?: CallerFacts | undefined; readonly settings?: KnowledgeSettings | undefined; readonly engines?: Iterable<string> | undefined } = {},
): string {
  return servedText(overlay, held, path, options.context ?? new Map(), options.caller ?? {}, options.settings ?? DEFAULT_KNOWLEDGE_SETTINGS, renderable(options.engines ?? ENGINES));
}

/** A handler's outcome as MCP's `tools/call` result: the same JSON as `structuredContent` and as one text block, and `isError`. */
export function knowledgeResult(outcome: KnowledgeOutcome): KnowledgeResult {
  const failed = "error" in outcome;
  const body = failed ? { error: outcome.error } : outcome.result;
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body as Record<string, unknown>, isError: failed };
}

/** The arguments of one call as plain JavaScript give them, as the `Map` of integers `knowledgeArguments` reads. */
function asArguments(request: Readonly<Record<string, unknown>>): Map<string, unknown> | KnowledgeError {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(request)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && Number.isInteger(value)) out.set(key, BigInt(value));
    else if (key === "context" && !(value instanceof Map) && typeof value === "object") {
      try {
        out.set(key, fromPlain(value));
      } catch {
        return new KnowledgeError("invalid-arguments", "context is not a usable context");
      }
    } else out.set(key, value);
  }
  return out;
}

/** `kb_read` as a request in and a result out. The served text is made here, per call: a file's `${NAME}` and `@path` expanded, or its engine (`envsubst`, `mustache`) rendered, from the overlay's facts, the caller's (`role`, `profile`, the allowed environment names with their values) and the call's `context`, so a consumer never writes envsubst or Mustache of its own. `context` is a mapping or a plain object whose whole numbers are integers. */
export function kbRead(
  overlays: readonly KnowledgeOverlay[],
  request: { readonly path: string; readonly from?: number | undefined; readonly to?: number | undefined; readonly overlay?: string | undefined; readonly context?: Document | Readonly<Record<string, unknown>> | undefined },
  options: { readonly caller?: CallerFacts | undefined; readonly settings?: KnowledgeSettings | undefined; readonly engines?: Iterable<string> | undefined } = {},
): KnowledgeResult {
  const args = asArguments(request);
  if (args instanceof KnowledgeError) return knowledgeResult(failure(args));
  return knowledgeResult(knowledgeCall("kb_read", overlays, args, [], options.settings ?? DEFAULT_KNOWLEDGE_SETTINGS, options.caller ?? {}, options.engines ?? ENGINES));
}

/** `kb_list` as a request in and a result out; `modes` are the search modes the consumer declares, none when it offers no search. */
export function kbList(
  overlays: readonly KnowledgeOverlay[],
  request: { readonly overlay?: string | undefined; readonly modes?: Iterable<string> | undefined } = {},
  options: { readonly settings?: KnowledgeSettings | undefined; readonly engines?: Iterable<string> | undefined } = {},
): KnowledgeResult {
  const args = asArguments(request.overlay === undefined ? {} : { overlay: request.overlay });
  if (args instanceof KnowledgeError) return knowledgeResult(failure(args));
  return knowledgeResult(knowledgeCall("kb_list", overlays, args, request.modes ?? [], options.settings ?? DEFAULT_KNOWLEDGE_SETTINGS, {}, options.engines ?? ENGINES));
}

/** Whether an overlay's knowledge is served and which of its files are left out of the context because of it. The user's choice wins over the overlay's hint; the body of `OVERLAY.md` is never left out. */
export function knowledgePlan(manifest: Document, files: ReadonlyMap<string, string> | Iterable<string>, user?: boolean): { served: boolean; leftOut: string[] } {
  const tree = files instanceof Map ? OverlayTree.fromTexts(files) : OverlayTree.fromPaths(files as Iterable<string>);
  const knowledge = manifest.get("knowledge");
  const hint = knowledge instanceof Map && knowledge.get("serve") === true;
  const served = user ?? hint;
  const leftOut: string[] = [];
  if (served) {
    for (const path of [...rulesOfTree(manifest, tree), ...contextOfTree(manifest, tree)]) {
      if (path !== "OVERLAY.md" && !leftOut.includes(path)) leftOut.push(path);
    }
  }
  return { served, leftOut };
}

/** The entries of the tree under `root` on `files`, read without following a link: every file's first `maxFileBytes` + 1 bytes, a link or special file as what it is and not entered. Excluded names are not entered and a name that is not Unicode is left out. */
export async function readKnowledgeTree(files: FileSystem, root: string, settings: KnowledgeSettings = DEFAULT_KNOWLEDGE_SETTINGS): Promise<KnowledgeEntry[]> {
  const out: KnowledgeEntry[] = [];
  const most = settings.maxFileBytes === null ? Number.MAX_SAFE_INTEGER : settings.maxFileBytes + 1;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const names = (await files.list(dir)).filter((name): name is string => typeof name === "string");
    for (const name of names.sort(compareText)) {
      if (name === "" || name === "." || name === ".." || /[/\\\0]/.test(name) || EXCLUDED_COMPONENTS.includes(name)) continue;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const full = joinPath(dir, name);
      const meta = await files.metadata(full);
      if (meta.kind === "directory") {
        out.push({ path, kind: "directory" });
        await walk(full, path);
      } else if (meta.kind === "file") out.push({ path, kind: "file", bytes: await files.read(full, most) });
      else out.push({ path, kind: meta.kind });
    }
  };
  await walk(root, "");
  return out;
}
