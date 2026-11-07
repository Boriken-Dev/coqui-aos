/**
 * Hooks: which an overlay declares, whether they are on, what each event tells them, and the
 * checking of what a run left. This library never runs a hook: the caller does, and builds a
 * {@link HookRun} from what the process did.
 */
import { readJson } from "./codecs.ts";
import { DEFAULT_SCRIPTS, INTERPRETERS, defaultOn } from "./defaults.ts";
import { Digest, checkEntries, digestEntries } from "./digest.ts";
import { AosError } from "./error.ts";
import type { TreeEntry } from "./digest.ts";
import { words } from "./kinds.ts";
import type { Settings } from "./limits.ts";
import { asciiUpper, isReservedVariable, isSensitiveVariable, isVariableName, osMatches } from "./names.ts";
import { readEnvScriptOutput } from "./read.ts";
import { compareText, decodeUtf8 } from "./text.ts";
import type { OverlayTree } from "./tree.ts";
import type { Document, Value } from "./value.ts";

export const HOOK_EVENTS = [
  "pre-env",
  "session-start",
  "session-end",
  "prompt",
  "turn-end",
  "cd",
  "pre-compact",
  "pre-tool",
  "post-tool",
] as const;
/** A moment a hook may run at. */
export type HookEvent = (typeof HOOK_EVENTS)[number];
export const hookEvent = words(HOOK_EVENTS);

export const DECISIONS = ["block", "deny", "ask", "refuse"] as const;
/** What a hook's output decides for its event. */
export type Decision = (typeof DECISIONS)[number];
export const decision = words(DECISIONS);

export const ON_FAILURES = ["report", "refuse"] as const;
/** What a failed hook does to its event. */
export type OnFailure = (typeof ON_FAILURES)[number];
export const onFailure = words(ON_FAILURES);

export const HOOK_SCOPES = ["overlay", "user", "project"] as const;
/** Whose hooks they are: an overlay's, the user's own (always on) or a project's. */
export type HookScope = (typeof HOOK_SCOPES)[number];
export const hookScope = words(HOOK_SCOPES);

export const HOOK_FAILURES = [
  "not-run",
  "payload-too-large",
  "timeout",
  "too-large",
  "exit",
  "grant",
  "output",
  "event-timeout",
] as const;
/** Every way a run fails. */
export type HookFailure = (typeof HOOK_FAILURES)[number];
export const hookFailure = words(HOOK_FAILURES);

/** A hook's failure as a thrown value: the `HookFailure` word. */
export class HookFailed extends AosError {
  readonly failure: HookFailure;
  constructor(failure: HookFailure) {
    super("hook-refused", failure);
    this.name = "HookFailed";
    this.failure = failure;
  }
}

const EVENT_DEFAULT_ON: Record<HookEvent, boolean> = {
  "pre-env": true,
  "session-start": true,
  "session-end": true,
  prompt: false,
  "turn-end": true,
  cd: true,
  "pre-compact": true,
  "pre-tool": false,
  "post-tool": false,
};

/** The outputs an event's hook may give. */
const OUTPUTS: Record<HookEvent, readonly string[]> = {
  "pre-env": ["env"],
  cd: ["env"],
  "session-start": ["context", "env"],
  "session-end": [],
  "turn-end": [],
  prompt: ["context", "block", "env"],
  "pre-compact": ["context", "block"],
  "pre-tool": ["context", "deny", "ask", "env"],
  "post-tool": ["context"],
};

const REFUSALS: Partial<Record<HookEvent, Decision>> = {
  "pre-env": "refuse",
  "session-start": "refuse",
  prompt: "block",
  "pre-compact": "block",
  "pre-tool": "deny",
};

const SELECTS: Partial<Record<HookEvent, "reason" | "kind">> = {
  "session-start": "reason",
  "pre-tool": "kind",
  "post-tool": "kind",
};

const PAYLOAD_KEYS: Record<HookEvent, readonly string[]> = {
  "pre-env": ["event", "harness", "cwd"],
  "session-start": ["event", "harness", "cwd", "session", "reason"],
  "session-end": ["event", "harness", "cwd", "session"],
  "turn-end": ["event", "harness", "cwd", "session"],
  prompt: ["event", "harness", "cwd", "session", "prompt"],
  cd: ["event", "harness", "cwd", "session", "previous"],
  "pre-compact": ["event", "harness", "cwd", "session", "trigger"],
  "pre-tool": ["event", "harness", "cwd", "session", "tool"],
  "post-tool": ["event", "harness", "cwd", "session", "tool", "status"],
};

/** The payload keys an event's hook is told, `event` first. */
export function payloadKeys(event: HookEvent): readonly string[] {
  return PAYLOAD_KEYS[event];
}

function rank(decided: Decision | undefined): number {
  if (decided === undefined) return 0;
  return decided === "ask" ? 1 : 2;
}

/** A hook as an overlay declares it. */
export interface Hook {
  readonly event: HookEvent;
  /** The script's path in the overlay; undefined when none is chosen. */
  readonly path: string | undefined;
  readonly interpreter: string | undefined;
  /** Whether the consumer has the interpreter. */
  readonly runs: boolean;
  /** The `match` list, when one is written. */
  readonly select: string[] | undefined;
  /** The variables the hook may set. */
  readonly sets: string[];
  /** Seconds. */
  readonly timeout: number;
  readonly onFailure: OnFailure;
  /** The payload keys it is told. */
  readonly payload: string[];
}

function extensionInterpreter(path: string): string | undefined {
  const at = path.lastIndexOf(".");
  if (at === -1) return undefined;
  switch (path.slice(at)) {
    case ".py":
      return "python";
    case ".sh":
      return "sh";
    case ".bash":
      return "bash";
    case ".ps1":
      return "powershell";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "node";
    default:
      return undefined;
  }
}

function defaultHook(
  tree: OverlayTree,
  os: string,
  interpreters: readonly string[],
): { chosen: { path: string; interpreter: string } | undefined; present: string[] } {
  const members = tree.members();
  const present = DEFAULT_SCRIPTS.map(([extension]) => `hook${extension}`).filter((path) => members.includes(path));
  for (const [extension, interpreter, on] of DEFAULT_SCRIPTS) {
    const path = `hook${extension}`;
    const names = on === undefined ? undefined : [on];
    if (present.includes(path) && osMatches(names, os) && interpreters.includes(interpreter)) {
      return { chosen: { path, interpreter }, present };
    }
  }
  return { chosen: undefined, present };
}

const asNumber = (value: Value | undefined): number | undefined =>
  typeof value === "bigint" && value >= 0n ? Number(value) : undefined;

function strings(value: Value | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * The hooks a manifest declares or defaults to, and the `hook.<ext>` files reported
 * `script-not-run` because no consumer interpreter runs them. Call `validate` first.
 */
export function hooksOf(
  manifest: Document,
  tree: OverlayTree,
  os: string,
  interpreters: readonly string[],
): { hooks: Hook[]; notRun: string[] } {
  const declaredValue = manifest.get("hooks");
  const declared = declaredValue instanceof Map ? declaredValue : undefined;
  const { chosen, present } = defaultHook(tree, os, interpreters);
  const entries: Hook[] = [];
  let needsDefault = false;
  for (const event of HOOK_EVENTS) {
    const given = declared?.get(event);
    let table: Document;
    if (given === false) continue;
    if (given instanceof Map) table = given;
    else if (given !== undefined) table = new Map([["run", given]]);
    else if (EVENT_DEFAULT_ON[event] && defaultOn(manifest, "hooks") && present.length > 0) table = new Map();
    else continue;
    let path: string | undefined;
    let interpreter: string | undefined;
    const run = table.get("run");
    if (typeof run === "string") {
      path = run;
      interpreter = extensionInterpreter(run);
    } else if (chosen !== undefined) {
      path = chosen.path;
      interpreter = chosen.interpreter;
    } else {
      needsDefault = true;
      if (declared === undefined || !declared.has(event)) continue;
    }
    entries.push({
      event,
      path,
      interpreter,
      runs: interpreter !== undefined && interpreters.includes(interpreter),
      select: strings(table.get("match")),
      sets: strings(table.get("sets")) ?? [],
      timeout: asNumber(table.get("timeout")) ?? 30,
      onFailure: table.get("on_failure") === "refuse" ? "refuse" : "report",
      payload: [...PAYLOAD_KEYS[event]],
    });
  }
  return { hooks: entries, notRun: needsDefault ? present : [] };
}

/** What a consumer knows when it asks whether an overlay's hooks are on. */
export interface HookFacts {
  readonly os: string;
  /** The interpreters the consumer has; undefined means every one AOS names. */
  readonly interpreters: readonly string[] | undefined;
  readonly identity: string;
  readonly scope: HookScope;
  /** The overlay's tree digest, as text. */
  readonly digest: string | undefined;
  /** A project's files by path and bytes: its digest replaces `digest`. */
  readonly tree: ReadonlyArray<readonly [string, Uint8Array]> | undefined;
  /** The digest the user allowed. */
  readonly allowed: string | undefined;
  /** The events the consumer fires; undefined means every one. */
  readonly fires: readonly HookEvent[] | undefined;
  /** Events it fires in part. */
  readonly partial: readonly HookEvent[];
  /** A bound on a hook's seconds. */
  readonly timeout: number | undefined;
}

/** Facts for an `os` and an overlay `identity`; the rest by default, changed by `changes`. */
export function hookFacts(os: string, identity: string, changes: Partial<HookFacts> = {}): HookFacts {
  return {
    os,
    identity,
    interpreters: undefined,
    scope: "overlay",
    digest: undefined,
    tree: undefined,
    allowed: undefined,
    fires: undefined,
    partial: [],
    timeout: undefined,
    ...changes,
  };
}

/** The result of {@link hookPlan}. */
export interface HookPlan {
  readonly hooks: Hook[];
  /** Whether the hooks are allowed and there are some. */
  readonly on: boolean;
  /** False for a guard (a hook that refuses on failure) that is off: its overlay stays inactive. */
  readonly activates: boolean;
  /** The interpreters the hooks need. */
  readonly needs: string[];
  /** `[id, subject]`: `hook-not-allowed`, `hook-unsupported`, `hook-partial`. */
  readonly reports: Array<readonly [string, string]>;
  /** `[id, subject]`: `hook` and `script-not-run`. */
  readonly nonDefaults: Array<readonly [string, string]>;
}

function sameDigest(a: string, b: string): boolean {
  try {
    return Digest.parse(a).toString() === Digest.parse(b).toString();
  } catch {
    return false;
  }
}

function comparePairs(a: readonly [string, string], b: readonly [string, string]): number {
  return compareText(a[0], b[0]) || compareText(a[1], b[1]);
}

/** Plans an overlay's hooks against what the consumer knows. A hook is off until the user allows it at the overlay's digest. */
export function hookPlan(manifest: Document, files: OverlayTree, facts: HookFacts, settings: Settings): HookPlan {
  const interpreters = facts.interpreters ?? INTERPRETERS;
  const found = hooksOf(manifest, files, facts.os, interpreters);
  const bound = facts.timeout ?? settings.hookTimeout ?? Number.MAX_SAFE_INTEGER;
  const hooks = found.hooks.map((hook): Hook => ({ ...hook, timeout: Math.min(hook.timeout, bound) }));
  let digest = facts.digest;
  if (facts.tree !== undefined) {
    // Every file of the directory, not only those the hooks name: a module beside a script is loaded by it.
    const entries: Array<[string[], TreeEntry]> = facts.tree.map(([path, bytes]) => [
      path.split("/"),
      { kind: "file", bytes },
    ]);
    checkEntries(entries, settings);
    digest = digestEntries(entries).digest.toString();
  }
  const on =
    facts.scope === "user" || (digest !== undefined && facts.allowed !== undefined && sameDigest(digest, facts.allowed));
  const fires: readonly HookEvent[] = facts.fires ?? HOOK_EVENTS;
  const nonDefaults: Array<readonly [string, string]> = found.notRun.map((path) => ["script-not-run", path] as const);
  const reports: Array<readonly [string, string]> = [];
  if (hooks.length > 0 && !on) {
    reports.push(["hook-not-allowed", facts.identity]);
  } else if (on) {
    for (const hook of hooks) {
      if (!fires.includes(hook.event)) {
        reports.push(["hook-unsupported", hook.event]);
        continue;
      }
      nonDefaults.push(["hook", hook.event]);
      if (facts.partial.includes(hook.event)) reports.push(["hook-partial", hook.event]);
    }
  }
  const guarded = hooks.some((hook) => hook.onFailure === "refuse");
  const needs = [...new Set(hooks.flatMap((hook) => (hook.interpreter === undefined ? [] : [hook.interpreter])))].sort(compareText);
  reports.sort(comparePairs);
  nonDefaults.sort(comparePairs);
  return { hooks, on: on && hooks.length > 0, activates: on || !guarded, needs, reports, nonDefaults };
}

/** Whether a hook's `match` selects `value`; no `match` selects everything, and a tool's `other` kind is always selected. */
export function hookMatches(event: HookEvent, select: readonly string[] | undefined, value: string): boolean {
  if (select === undefined) return true;
  if (SELECTS[event] === "kind" && value === "other") return true;
  return select.includes(value);
}

/** The payload a hook is told: `event`, then the event's keys that `known` holds; a tool keeps only its `kind`, `name` and `input`. */
export function hookPayload(event: HookEvent, known: ReadonlyMap<string, Value>): Document {
  const payload: Document = new Map();
  payload.set("event", event);
  for (const key of PAYLOAD_KEYS[event].slice(1)) {
    const value = known.get(key);
    if (value === undefined) continue;
    if (key === "tool" && value instanceof Map) {
      const tool: Document = new Map();
      for (const field of ["kind", "name", "input"]) {
        const item = value.get(field);
        if (item !== undefined) tool.set(field, item);
      }
      payload.set(key, tool);
    } else payload.set(key, value);
  }
  return payload;
}

/** What a hook's output decided and asked for. Its text is never shown by `toJSON` or inspection. */
export class HookOutput {
  decision: Decision | undefined;
  reason: string | undefined;
  context: string | undefined;
  /** Variables to set; `undefined` unsets one. */
  env: Array<[string, string | undefined]> | undefined;

  constructor(parts: Partial<Pick<HookOutput, "decision" | "reason" | "context" | "env">> = {}) {
    this.decision = parts.decision;
    this.reason = parts.reason;
    this.context = parts.context;
    this.env = parts.env;
  }

  private shown(): Record<string, unknown> {
    return {
      decision: this.decision,
      reason: this.reason?.length,
      context: this.context?.length,
      env: this.env?.map(([name]) => name),
    };
  }

  toJSON(): Record<string, unknown> {
    return this.shown();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `HookOutput ${JSON.stringify(this.shown())}`;
  }
}

const HOOK_TEXT_REFUSED = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]");

const hookText = (text: string): boolean => !HOOK_TEXT_REFUSED.test(text);

/** Trims space, tab, CR and LF from both ends in one pass over the character codes. */
function trimBlank(text: string): string {
  const blank = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;
  let start = 0;
  let end = text.length;
  while (start < end && blank(text.charCodeAt(start))) start += 1;
  while (end > start && blank(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

const charCount = (text: string): number => [...text].length;

/** Reads what a hook printed for `event`; `sets` are the variables it declared. Throws {@link HookFailed}. */
export function readHookOutput(event: HookEvent, data: Uint8Array, sets: readonly string[], settings: Settings): HookOutput {
  const outputs = OUTPUTS[event];
  if (event === "pre-env") {
    let set: Array<[string, string | undefined]>;
    try {
      set = readEnvScriptOutput(data, settings);
    } catch {
      throw new HookFailed("output");
    }
    for (const [name, value] of set) {
      if (value !== undefined && !hookText(value)) throw new HookFailed("output");
    }
    return new HookOutput({ env: set });
  }
  let text: string;
  try {
    text = decodeUtf8(data);
  } catch {
    throw new HookFailed("output");
  }
  const whole = trimBlank(text);
  if (whole === "") return new HookOutput();
  let value: Value;
  try {
    value = readJson(whole, settings.manifestDepth, true);
  } catch {
    throw new HookFailed("output");
  }
  if (!(value instanceof Map)) throw new HookFailed("output");
  const out = new HookOutput();
  const decided = value.get("decision");
  if (decided !== undefined) {
    if (decided === "block" && outputs.includes("block")) out.decision = "block";
    else if (decided === "deny" && outputs.includes("deny")) out.decision = "deny";
    else if (decided === "ask" && outputs.includes("ask")) out.decision = "ask";
    else throw new HookFailed("grant");
  }
  for (const key of value.keys()) {
    if (key !== "context" && key !== "decision" && key !== "reason" && key !== "env") throw new HookFailed("output");
  }
  const reason = value.get("reason");
  if (reason !== undefined) {
    if (
      typeof reason !== "string" ||
      out.decision === undefined ||
      !hookText(reason) ||
      (settings.hookReasonChars !== null && charCount(reason) > settings.hookReasonChars)
    ) {
      throw new HookFailed("output");
    }
    out.reason = reason;
  }
  const context = value.get("context");
  if (context !== undefined) {
    if (typeof context === "string" && outputs.includes("context") && hookText(context)) out.context = context;
    else throw new HookFailed("output");
  }
  const env = value.get("env");
  if (env !== undefined) {
    if (!(env instanceof Map) || !outputs.includes("env")) throw new HookFailed("output");
    const folded: string[] = [];
    const set: Array<[string, string | undefined]> = [];
    for (const [name, item] of env) {
      if (!isVariableName(name) || isReservedVariable(name) || !sets.includes(name) || folded.includes(asciiUpper(name))) {
        throw new HookFailed("output");
      }
      folded.push(asciiUpper(name));
      if ((item as unknown) === null) set.push([name, undefined]);
      else if (typeof item === "string" && !item.includes("\0")) set.push([name, item]);
      else throw new HookFailed("output");
    }
    out.env = set;
  }
  return out;
}

/** What a caller saw of one hook process. Its output text is never shown by `toJSON` or inspection. */
export class HookRun {
  source: string;
  onFailure: OnFailure | undefined;
  seconds: number;
  notRun: boolean;
  payloadSize: number;
  timedOut: boolean;
  stdout: Uint8Array;
  exit: number;
  sets: string[];

  constructor(source: string, stdout: Uint8Array = new Uint8Array()) {
    this.source = source;
    this.stdout = stdout;
    this.onFailure = undefined;
    this.seconds = 0;
    this.notRun = false;
    this.payloadSize = 0;
    this.timedOut = false;
    this.exit = 0;
    this.sets = [];
  }

  toJSON(): Record<string, unknown> {
    return { source: this.source, exit: this.exit, timedOut: this.timedOut, stdoutBytes: this.stdout.length };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `HookRun ${JSON.stringify(this.toJSON())}`;
  }
}

/** A run for the hook `source` with its `stdout`; set the other fields on it. */
export function hookRun(source: string, stdout: Uint8Array = new Uint8Array()): HookRun {
  return new HookRun(source, stdout);
}

/** Checks a run in a fixed order (started, payload, time, size, exit, output). Throws {@link HookFailed}. */
export function hookResult(event: HookEvent, run: HookRun, settings: Settings): HookOutput {
  if (run.notRun) throw new HookFailed("not-run");
  if (settings.hookPayloadBytes !== null && run.payloadSize > settings.hookPayloadBytes) throw new HookFailed("payload-too-large");
  if (run.timedOut) throw new HookFailed("timeout");
  if (settings.hookOutputBytes !== null && run.stdout.length > settings.hookOutputBytes) throw new HookFailed("too-large");
  if (run.exit !== 0) throw new HookFailed("exit");
  return readHookOutput(event, run.stdout, run.sets, settings);
}

/** One thing worth telling the user about an event. */
export interface HookReport {
  /** `hook-failed`, `hook-ask-denied` or `hook-not-applied`. */
  readonly id: string;
  /** The hook's source, the event, and for some the cause or the output refused. */
  readonly about: string[];
}

/** The combined result of one event's runs. Context and variable values are never shown by `toJSON` or inspection. */
export class FiredEvent {
  ran: string[] = [];
  decision: Decision | undefined;
  by: string | undefined;
  reason: string | undefined;
  /** `[source, context]` of each run that gave some. */
  context: Array<[string, string]> = [];
  env: Array<[string, string | undefined]> = [];
  reports: HookReport[] = [];
  /** `[id, subject]`: `env-sensitive`. */
  nonDefaults: Array<[string, string]> = [];

  toJSON(): Record<string, unknown> {
    return {
      ran: this.ran,
      decision: this.decision,
      by: this.by,
      contextFrom: this.context.map(([source]) => source),
      env: this.env.map(([name]) => name),
      reports: this.reports,
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `FiredEvent ${JSON.stringify(this.toJSON())}`;
  }
}

/**
 * Combines the runs of one event: the tightest decision wins, each run is checked and a failure
 * that refuses (`on_failure`) becomes the event's refusal. `applies` lists what the consumer can
 * apply (`context`, `env`, `ask`, `block`, `deny`, ...); undefined means everything the event
 * allows. `windows` makes variable names compare without regard to ASCII case.
 */
export function fireEvent(
  event: HookEvent,
  runs: readonly HookRun[],
  applies: readonly string[] | undefined,
  settings: Settings,
  windows: boolean,
): FiredEvent {
  const can = (output: string): boolean =>
    applies === undefined ? output === "refuse" || OUTPUTS[event].includes(output) : applies.includes(output);
  let spent = 0;
  const fired = new FiredEvent();
  for (const run of runs) {
    const source = run.source;
    let out: HookOutput;
    let failure: HookFailure | undefined;
    if (settings.hookEventTimeout !== null && spent >= settings.hookEventTimeout) failure = "event-timeout";
    else {
      fired.ran.push(source);
      spent += run.seconds;
      try {
        out = hookResult(event, run, settings);
      } catch (error) {
        if (!(error instanceof HookFailed)) throw error;
        failure = error.failure;
      }
    }
    if (failure !== undefined) {
      fired.reports.push({ id: "hook-failed", about: [source, event, failure] });
      const refusal = REFUSALS[event];
      if (run.onFailure === "refuse" && refusal !== undefined) out = new HookOutput({ decision: refusal });
      else continue;
    }
    out = out!;
    let decided = out.decision;
    if (decided === "ask" && !can("ask")) {
      fired.reports.push({ id: "hook-ask-denied", about: [source, event] });
      decided = "deny";
    }
    if (decided !== undefined && !can(decided)) {
      fired.reports.push({ id: "hook-not-applied", about: [source, event, decided] });
      decided = undefined;
    }
    if (rank(decided) > rank(fired.decision)) {
      fired.decision = decided;
      fired.by = source;
      fired.reason = out.reason;
    }
    if (rank(decided) === 2) {
      // The prompt, compaction, call or session does not happen: nothing else applies.
      fired.context = [];
      fired.env = [];
      break;
    }
    if (out.context !== undefined && out.context !== "") {
      if (can("context")) fired.context.push([source, out.context]);
      else fired.reports.push({ id: "hook-not-applied", about: [source, event, "context"] });
    }
    if (out.env !== undefined && out.env.length > 0) {
      if (!can("env")) {
        fired.reports.push({ id: "hook-not-applied", about: [source, event, "env"] });
        continue;
      }
      for (const [name, value] of out.env) {
        // On Windows a name set under another case keeps the spelling it has.
        const at = fired.env.findIndex(
          ([held]) => held === name || (windows && asciiUpper(held) === asciiUpper(name)),
        );
        if (at !== -1) fired.env[at]![1] = value;
        else fired.env.push([name, value]);
      }
    }
  }
  fired.nonDefaults = fired.env
    .filter(([name]) => isSensitiveVariable(name))
    .map(([name]) => ["env-sensitive", name] as [string, string])
    .sort(comparePairs);
  return fired;
}
