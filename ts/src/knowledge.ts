/** Knowledge served through MCP (`spec/v0/knowledge.md`): the tools' schemas, their arguments, `kb_list` and `kb_read` over an overlay's files, templates rendered per call, the MCP result and the hint. The core reads no file: a tree is handed in, or built through a `FileSystem`. */
import { AosError } from "./error.ts";
import { contextOf as contextOfTree, declared, named, rulesOf as rulesOfTree } from "./defaults.ts";
import { readFrontMatter, splitFrontMatter } from "./front_matter.ts";
import type { FileKind, FileSystem } from "./fs.ts";
import { joinPath } from "./fs.ts";
import { MANIFEST_FILES } from "./kinds.ts";
import { DEFAULT_SETTINGS } from "./limits.ts";
import { EXCLUDED_COMPONENTS, isSensitiveVariable, normalizeName, validRelativePath } from "./names.ts";
import { DEFAULT_KNOWLEDGE_SETTINGS, KnowledgeError, type KnowledgeErrorClass, type KnowledgeSettings, SEARCH_MODES, type SearchMode, byteLength, hidesCharacter, inert, knowledgeLines, within } from "./knowledge_base.ts";
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
  readonly text: string;
  /** The template engine, `envsubst` or `mustache`, or `null` for a plain file. */
  readonly engine: string | null;
  /** The size as stored. */
  readonly bytes: number;
  readonly raw: Uint8Array;
}

/** An overlay's knowledge: the files served and the files skipped, in the order of their paths as UTF-8 bytes. */
export interface KnowledgeSet {
  readonly files: ReadonlyMap<string, KnowledgeFile>;
  /** `[path, reason]` with the reason `name`, `too-large`, `not-text` or `template`. */
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

/** An overlay's knowledge: its files under `kb/`, `flows/`, `references/`, `rules/` and `context/`, the root `CONTEXT.md` and the files `rules` and `context` name, served or skipped. */
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
    let engine: string | null = null;
    const found = readFrontMatter(data, DEFAULT_SETTINGS);
    if (found.case === "mapping" && found.data?.has("template") === true) {
      const value = found.data.get("template");
      if (typeof value !== "string" || !ENGINES.includes(value)) {
        skipped.push([path, "template"]);
        continue;
      }
      engine = value;
    }
    files.set(path, { text, engine, bytes: data.length, raw: data });
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

/** What a server answers a call of `kb_list` or `kb_read`: `{ result }` or `{ error: { class, message } }`. `modes` are the declared search modes; `arguments` are as `knowledgeArguments` reads them. */
export function knowledgeCall(
  tool: string,
  overlays: readonly KnowledgeOverlay[],
  args: unknown,
  modes: Iterable<string> = [],
  settings: KnowledgeSettings = DEFAULT_KNOWLEDGE_SETTINGS,
  caller: CallerFacts = {},
): KnowledgeOutcome {
  const declaredModes = [...modes];
  try {
    const checked = knowledgeArguments(tool, args, declaredModes, settings);
    if (tool === "kb_list") return { result: listResult(overlays, checked, declaredModes, settings) };
    if (tool === "kb_read") return { result: readResult(overlays, checked, settings, caller) };
    throw new KnowledgeError("invalid-arguments", `no tool is named ${tool}`);
  } catch (error) {
    if (error instanceof KnowledgeError) return failure(error);
    throw error;
  }
}

function listResult(overlays: readonly KnowledgeOverlay[], args: Record<string, unknown>, modes: readonly string[], settings: KnowledgeSettings): Record<string, unknown> {
  const listed = [];
  for (const overlay of choose(overlays, args["overlay"])) {
    const found = knowledgeSet(overlay, settings);
    const files = [...found.files].map(([path, item]) =>
      item.engine === null ? { path, lines: knowledgeLines(item.text).length, bytes: item.bytes } : { path, template: item.engine },
    );
    listed.push({
      overlay: overlay.identity,
      served: overlay.served,
      files,
      skipped: found.skipped.map(([path, reason]) => ({ path: inert(path), reason })),
    });
  }
  const result: Record<string, unknown> = { overlays: listed };
  if (ordered(modes).length > 0) result["search"] = { modes: ordered(modes) };
  return result;
}

const SKIP_CLASS: Record<string, KnowledgeErrorClass> = {
  name: "invalid-path",
  "too-large": "too-large",
  "not-text": "not-text",
  template: "unknown-template",
};
const PRIORITY: readonly KnowledgeErrorClass[] = ["link", "not-text", "too-large", "unknown-template", "not-found"];

function readResult(overlays: readonly KnowledgeOverlay[], args: Record<string, unknown>, settings: KnowledgeSettings, caller: CallerFacts): Record<string, unknown> {
  const path = args["path"] as string;
  if (!validRelativePath(path) || hasHidden(path)) throw new KnowledgeError("invalid-path", inert(path));
  const found: Array<[KnowledgeOverlay, KnowledgeFile]> = [];
  const problems: KnowledgeErrorClass[] = [];
  const parts = path.split("/");
  for (const overlay of choose(overlays, args["overlay"])) {
    const held = knowledgeSet(overlay, settings);
    const linked = parts.some((_, n) => held.entries.get(parts.slice(0, n + 1).join("/"))?.kind === "symlink");
    const item = held.files.get(path);
    if (linked) problems.push("link");
    else if (item !== undefined) found.push([overlay, item]);
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
  const [overlay, item] = found[0]!;
  let text = item.text;
  if (item.engine !== null) text = render(overlay, item, (args["context"] as Document | undefined) ?? new Map(), caller, settings);
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
  if (item.engine !== null) result["template"] = item.engine;
  return result;
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

function render(overlay: KnowledgeOverlay, item: KnowledgeFile, context: Document, caller: CallerFacts, settings: KnowledgeSettings): string {
  const facts: TemplateFacts = { ...overlay.facts, name: overlay.facts.name ?? normalizeName(overlay.identity) };
  const split = splitFrontMatter(item.raw, DEFAULT_SETTINGS);
  const body = decodeUtf8(item.raw.subarray(Math.min(split.bodyOffset ?? 0, item.raw.length)));
  const callerFacts = new Map<string, string>();
  if (typeof caller.caller?.role === "string") callerFacts.set("role", caller.caller.role);
  if (typeof caller.caller?.profile === "string") callerFacts.set("profile", caller.caller.profile);
  const env = allowedEnv(caller);
  let values: ReadonlyMap<string, string>;
  try {
    values = templateValues(overlay.manifest, facts);
  } catch (error) {
    if (error instanceof AosError) throw new KnowledgeError("invalid-option", error.subject);
    throw error;
  }
  let out: string;
  if (item.engine === "envsubst") {
    const all = new Map(values);
    if (callerFacts.has("role")) all.set("AOS_CALLER_ROLE", callerFacts.get("role")!);
    if (callerFacts.has("profile")) all.set("AOS_CALLER_PROFILE", callerFacts.get("profile")!);
    for (const [name, value] of env) all.set(`AOS_ENV_${name}`, value);
    for (const [key, value] of context) {
      if (typeof value === "boolean") all.set(`AOS_ARG_${key}`, value ? "true" : "false");
      else if (typeof value === "bigint" || typeof value === "string") all.set(`AOS_ARG_${key}`, String(value));
    }
    out = template(body, all);
  } else {
    const options: Document = new Map();
    const configured = facts.options ?? new Map<string, Value>();
    const declaredOptions = overlay.manifest.get("options");
    if (declaredOptions instanceof Map) {
      for (const [name, spec] of declaredOptions) {
        if (!(spec instanceof Map) || spec.get("sensitive") === true) continue;
        const given = configured.get(name);
        if (given !== undefined) {
          if (!optionTypeOk(spec.get("type"), given)) throw new KnowledgeError("invalid-option", name);
          options.set(name, given);
        } else if (spec.has("default")) options.set(name, spec.get("default")!);
      }
    }
    const overlayData: Document = new Map();
    for (const [key, source] of [["root", facts.root], ["state", facts.state], ["name", facts.name], ["scope", facts.scope]] as const) {
      if (source !== undefined) overlayData.set(key, source);
    }
    const data: Document = new Map<string, Value>([
      ["overlay", overlayData],
      ["project", facts.project === undefined ? new Map() : new Map([["root", facts.project]])],
      ["caller", callerFacts],
      ["env", env],
      ["options", options],
      ["context", context],
    ]);
    out = mustache(body, data, settings);
  }
  if (!within(settings.maxRenderedBytes, encodeUtf8(out).length)) throw new KnowledgeError("too-large", "the rendered text");
  return out;
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

/** `kb_read` as a request in and a result out. The file is rendered here, per call, from the overlay's facts, the caller's (`role`, `profile`, the allowed environment names with their values) and the call's `context`, so a consumer never writes envsubst or Mustache of its own. `context` is a mapping or a plain object whose whole numbers are integers. */
export function kbRead(
  overlays: readonly KnowledgeOverlay[],
  request: { readonly path: string; readonly from?: number | undefined; readonly to?: number | undefined; readonly overlay?: string | undefined; readonly context?: Document | Readonly<Record<string, unknown>> | undefined },
  options: { readonly caller?: CallerFacts | undefined; readonly settings?: KnowledgeSettings | undefined } = {},
): KnowledgeResult {
  const args = asArguments(request);
  if (args instanceof KnowledgeError) return knowledgeResult(failure(args));
  return knowledgeResult(knowledgeCall("kb_read", overlays, args, [], options.settings ?? DEFAULT_KNOWLEDGE_SETTINGS, options.caller ?? {}));
}

/** `kb_list` as a request in and a result out; `modes` are the search modes the consumer declares, none when it offers no search. */
export function kbList(
  overlays: readonly KnowledgeOverlay[],
  request: { readonly overlay?: string | undefined; readonly modes?: Iterable<string> | undefined } = {},
  options: { readonly settings?: KnowledgeSettings | undefined } = {},
): KnowledgeResult {
  const args = asArguments(request.overlay === undefined ? {} : { overlay: request.overlay });
  if (args instanceof KnowledgeError) return knowledgeResult(failure(args));
  return knowledgeResult(knowledgeCall("kb_list", overlays, args, request.modes ?? [], options.settings ?? DEFAULT_KNOWLEDGE_SETTINGS));
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
