/** Applying an overlay: the environment it builds and what it needs, on one operating system. */
import {
  type Dependency,
  INTERPRETERS,
  PartialLock,
  declared,
  defaultPaths,
  defaultScript,
  dependenciesOf,
  entryOn,
  envFilesOf,
  firstVariant,
  named,
} from "./defaults.ts";
import { Environment, Facts, textOf } from "./environment.ts";
import { AosError } from "./error.ts";
import { type HookRun, fireEvent } from "./hooks.ts";
import type { HookReport } from "./hooks.ts";
import type { NonDefaultId } from "./kinds.ts";
import {
  asciiUpper,
  isPathVariable,
  isReservedVariable,
  isSensitiveVariable,
  normalizeName,
  rootVariable,
  stateVariable,
  isVariableName,
  validRelativePath,
} from "./names.ts";
import { parseDotenv, readDocument } from "./read.ts";
import { compareText, encodeUtf8 } from "./text.ts";
import { validate } from "./validate.ts";
import type { Document, Value } from "./value.ts";

/** A setting a reading turned out to use that is not the default: its id and what it is about, never a value. */
export interface NonDefaultSetting {
  readonly id: NonDefaultId;
  readonly subject: string;
}

function setting(id: NonDefaultId, subject: string): NonDefaultSetting {
  return { id, subject };
}

function asMap(value: unknown): Document | undefined {
  return value instanceof Map ? value : undefined;
}

function asList(value: unknown): Value[] {
  return Array.isArray(value) ? value : [];
}

function stringsOf(entry: unknown, key: string): string[] {
  const list = entry instanceof Map ? entry.get(key) : undefined;
  return asList(list).filter((item): item is string => typeof item === "string");
}

/** A non-negative whole number a manifest wrote, or `fallback`. */
function unsignedOf(entry: unknown, key: string, fallback: number): number {
  const value = entry instanceof Map ? entry.get(key) : undefined;
  return typeof value === "bigint" && value >= 0n ? Number(value) : fallback;
}

function isTrue(entry: Document, key: string): boolean {
  return entry.get(key) === true;
}

function referenceName(entry: Document): string {
  const secret = entry.get("secret");
  if (typeof secret === "string") return `secret:${secret}`;
  return `${textOf(entry, "provider")}:${textOf(entry, "key")}`;
}

/** An overlay-relative path under `root`, with the platform's separator; a path that is not a valid relative path is `invalid-reference`. */
export function resolvePath(root: string, relative: string, windows: boolean): string {
  if (!validRelativePath(relative)) throw new AosError("invalid-reference", "a path that is not relative to the overlay");
  const separator = windows ? "\\" : "/";
  return `${root.replace(/[/\\]+$/, "")}${separator}${relative.split("/").join(separator)}`;
}

function isReference(entry: unknown): boolean {
  return entry instanceof Map && (entry.has("provider") || entry.has("secret"));
}

function applyMapping(
  env: Environment,
  mapping: Document,
  facts: Facts,
  root: string,
  nonDefaults: NonDefaultSetting[],
): void {
  const windows = env.windows;
  const before = env.clone();
  for (const [name, given] of mapping) {
    if (!isVariableName(name)) throw new AosError("invalid-reference", "a name that is not a variable");
    if (isReservedVariable(name)) throw new AosError("reserved-variable", name);
    let entry: Document;
    if (typeof given === "string") entry = new Map<string, Value>([["value", given]]);
    else if (given instanceof Map) entry = given;
    else continue;
    if (isTrue(entry, "if_unset") && before.get(name) !== undefined) continue;
    let secret = false;
    let value: string;
    const text = entry.get("value");
    const path = entry.get("path");
    if (typeof text === "string") {
      // Mapping order carries no meaning, so no entry sees another of the same mapping.
      value = before.substitute(text, name);
    } else if (typeof path === "string") {
      value = resolvePath(root, path, windows);
    } else {
      const held = facts.secret(entry);
      if (held === undefined) {
        if (isTrue(entry, "optional")) continue;
        throw new AosError("unresolved-reference", name);
      }
      value = held;
      secret = true;
      if (entry.get("provider") === "env") nonDefaults.push(setting("env-passthrough", textOf(entry, "key")));
      else nonDefaults.push(setting("secret-read", referenceName(entry)));
    }
    if (isSensitiveVariable(name)) nonDefaults.push(setting("env-sensitive", name));
    env.set(name, value, secret);
  }
}

function applyPaths(
  env: Environment,
  paths: readonly Value[],
  root: string,
  os: string,
  nonDefaults: NonDefaultSetting[],
): void {
  const windows = env.windows;
  const separator = windows ? ";" : ":";
  const order: string[] = [];
  const grouped = new Map<string, { variable: string; entries: Document[] }>();
  for (const entry of paths) {
    if (!(entry instanceof Map) || !entryOn(entry, os)) continue;
    const variable = textOf(entry, "variable");
    const key = windows ? asciiUpper(variable) : variable;
    let group = grouped.get(key);
    if (group === undefined) {
      order.push(key);
      group = { variable, entries: [] };
      grouped.set(key, group);
    }
    group.entries.push(entry);
  }
  for (const key of order) {
    const { variable, entries } = grouped.get(key)!;
    if (isSensitiveVariable(variable) && !isPathVariable(variable)) {
      nonDefaults.push(setting("env-sensitive", variable));
    }
    const prepend: string[] = [];
    const append: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const packages = entry.get("packages");
      const resolved =
        typeof packages === "string" ? packages : resolvePath(root, textOf(entry, "path"), windows);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (entry.get("position") === "append") append.push(resolved);
      else prepend.push(resolved);
    }
    const kept = (env.get(variable) ?? "").split(separator).filter((part) => part !== "" && !seen.has(part));
    const secret = env.isSecret(variable);
    env.set(variable, [...prepend, ...kept, ...append].join(separator), secret);
  }
}

/** An env script to run: the interpreter, the file, its arguments and its time in seconds (0 is none). */
export interface ScriptRun {
  readonly interpreter: string;
  readonly path: string;
  readonly args: readonly string[];
  readonly timeout: number;
}

/** A setup script to run, and whether it may use the network. */
export interface SetupRun extends ScriptRun {
  readonly network: boolean;
}

function applyOverlay(
  env: Environment,
  manifest: Document,
  facts: Facts,
  nonDefaults: NonDefaultSetting[],
): ScriptRun[] {
  env.extra = [
    ["AOS_OVERLAY_ROOT", facts.root],
    ["AOS_OVERLAY_NAME", normalizeName(facts.identity)],
  ];
  if (facts.state !== undefined) env.extra.push(["AOS_OVERLAY_STATE", facts.state]);
  try {
    return applyOverlayInner(env, manifest, facts, nonDefaults);
  } finally {
    env.extra = [];
  }
}

function partialLock(subject: string): AosError {
  return new AosError("partial-lock", subject);
}

function dependenciesOrRefuse(manifest: Document, tree: Facts["tree"], os: string): Dependency[] {
  try {
    return dependenciesOf(manifest, tree, os);
  } catch (error) {
    if (error instanceof PartialLock) throw partialLock(error.subject);
    throw error;
  }
}

function applyOverlayInner(
  env: Environment,
  manifest: Document,
  facts: Facts,
  nonDefaults: NonDefaultSetting[],
): ScriptRun[] {
  const { os, root, tree } = facts;
  const paths: Value[] = defaultPaths(manifest, tree);
  for (const dependency of dependenciesOrRefuse(manifest, tree, os)) {
    const packages = facts.packages.get(dependency.runtime);
    if (packages !== undefined) {
      const variable = dependency.runtime === "python" ? "PYTHONPATH" : "NODE_PATH";
      paths.push(
        new Map<string, Value>([
          ["variable", variable],
          ["packages", packages],
        ]),
      );
    }
  }
  paths.push(...declared(manifest, "paths"));
  const listed = new Set<string>();
  for (const entry of paths) {
    const variable = entry instanceof Map ? entry.get("variable") : undefined;
    if (typeof variable === "string") listed.add(asciiUpper(variable));
  }
  const ownEnv = asMap(manifest.get("env")) ?? new Map<string, Value>();
  for (const name of ownEnv.keys()) {
    if (listed.has(asciiUpper(name))) throw new AosError("env-path-conflict", name);
  }
  for (const item of envFilesOf(manifest, tree)) {
    if (!entryOn(item, os)) continue;
    const path = named(item) ?? "";
    const dotenv = item instanceof Map && item.get("format") === "dotenv";
    const text = tree.text(path);
    if (text === undefined) throw new AosError("missing-file", path);
    const invalid = (): AosError => new AosError("invalid-env-file", path);
    if (dotenv) {
      let lines;
      try {
        lines = parseDotenv(encodeUtf8(text));
      } catch {
        throw invalid();
      }
      const clash = lines.find((line) => listed.has(asciiUpper(line.name)));
      if (clash !== undefined) throw new AosError("env-path-conflict", clash.name);
      for (const line of lines) {
        if (isReservedVariable(line.name)) throw new AosError("reserved-variable", line.name);
        const value = line.literal ? line.text : env.substitute(line.text, line.name);
        if (isSensitiveVariable(line.name)) nonDefaults.push(setting("env-sensitive", line.name));
        env.set(line.name, value, false);
      }
    } else {
      let mapping: Document;
      try {
        mapping = readDocument(encodeUtf8(text), facts.settings);
      } catch {
        throw invalid();
      }
      if (validate(new Map<string, Value>([["env", mapping]])).length > 0) throw invalid();
      for (const name of mapping.keys()) {
        if (listed.has(asciiUpper(name))) throw new AosError("env-path-conflict", name);
      }
      applyMapping(env, mapping, facts, root, nonDefaults);
    }
  }
  applyMapping(env, ownEnv, facts, root, nonDefaults);
  applyPaths(env, paths, root, os, nonDefaults);
  const scripts: ScriptRun[] = [];
  if (facts.envScriptsEnabled !== false) {
    const choice = defaultScript(manifest, "env_scripts", "env", tree, os, facts.interpreters ?? [...INTERPRETERS]);
    if (choice.chosen === undefined) {
      for (const path of choice.present) nonDefaults.push(setting("script-not-run", path));
    }
    const chosen = choice.chosen === undefined ? [] : [choice.chosen];
    for (const script of [...chosen, ...choice.others]) {
      if (!entryOn(script, os)) continue;
      const run: ScriptRun = {
        interpreter: textOf(script, "interpreter"),
        path: textOf(script, "path"),
        args: stringsOf(script, "args"),
        timeout: unsignedOf(script, "timeout", 60),
      };
      nonDefaults.push(setting("env-script", run.path));
      if (run.timeout === 0) nonDefaults.push(setting("no-timeout", run.path));
      scripts.push(run);
    }
  }
  return scripts;
}

/** Reads `dotenv` text, substituting each value against `env` and what the lines before it set; sets them in `env` and returns them. */
export function readDotenv(data: Uint8Array, env: Environment): Array<[string, string]> {
  const set: Array<[string, string]> = [];
  for (const line of parseDotenv(data)) {
    const value = line.literal ? line.text : env.substitute(line.text, line.name);
    env.set(line.name, value, false);
    set.push([line.name, value]);
  }
  return set;
}

/** What running an overlay needs on the machine. */
export interface Needs {
  readonly interpreters: readonly string[];
  readonly commands: readonly string[];
}

/** An overlay's effective settings on one operating system. */
export interface Effective {
  /** References the user has not granted, by name. */
  readonly ungranted: readonly string[];
  /** Whether `runtime.os` admits this system. */
  readonly supported: boolean;
  readonly env: Environment;
  readonly envScripts: readonly ScriptRun[];
  readonly setup: SetupRun | undefined;
  readonly python: Document | undefined;
  readonly node: Document | undefined;
  readonly dependencies: readonly Dependency[];
  readonly needs: Needs;
  readonly nonDefaults: readonly NonDefaultSetting[];
}

function sortedUnique(items: Iterable<string>): string[] {
  return [...new Set(items)].sort(compareText);
}

const SCRIPT_INTERPRETERS: Record<string, string> = {
  ".py": "python",
  ".sh": "sh",
  ".bash": "bash",
  ".ps1": "powershell",
};

/** What `manifest` builds and needs on the system `facts` describes. */
export function effective(manifest: Document, facts: Facts): Effective {
  const os = facts.os;
  const nonDefaults: NonDefaultSetting[] = [];
  if (!facts.pinned) nonDefaults.push(setting("unpinned", ""));
  const runtime = manifest.get("runtime");
  const supported = !(runtime instanceof Map && runtime.has("os")) || entryOn(runtime, os);
  const env = new Environment(facts.baseEnv, facts.windows).settings(facts.settings);
  env.set(rootVariable(facts.identity), facts.root, false);
  if (facts.state !== undefined) env.set(stateVariable(facts.identity), facts.state, false);
  const scripts = applyOverlay(env, manifest, facts, nonDefaults);
  const interpretersKnown = facts.interpreters ?? [...INTERPRETERS];
  const choice = defaultScript(manifest, "setup", "setup", facts.tree, os, interpretersKnown);
  // Declared variants come first; the default setup is the last one.
  let network = false;
  let variantFound = firstVariant(choice.others, os);
  if (variantFound === undefined) {
    variantFound = choice.chosen;
    // A default setup that declares nothing is taken to need the network.
    network = !choice.configured;
    if (variantFound === undefined) {
      for (const path of choice.present) nonDefaults.push(setting("script-not-run", path));
    }
  }
  const networkSet = variantFound instanceof Map ? variantFound.get("network") : undefined;
  const setup: SetupRun | undefined =
    variantFound === undefined
      ? undefined
      : {
          interpreter: textOf(variantFound, "interpreter"),
          path: textOf(variantFound, "path"),
          args: stringsOf(variantFound, "args"),
          timeout: unsignedOf(variantFound, "timeout", 300),
          network: typeof networkSet === "boolean" ? networkSet : network,
        };
  if (setup !== undefined) {
    if (setup.network) nonDefaults.push(setting("setup-network", setup.path));
    else if (facts.enforcesNetwork === false) nonDefaults.push(setting("network-not-enforced", setup.path));
    if (setup.timeout === 0) nonDefaults.push(setting("no-timeout", setup.path));
  }
  const variant = (name: string): Document | undefined => {
    const variants = runtime instanceof Map ? asList(runtime.get(name)) : [];
    const first = firstVariant(variants, os);
    if (!(first instanceof Map)) return undefined;
    const copy = new Map(first);
    copy.delete("os");
    return copy;
  };
  const python = variant("python");
  const dependencies = dependenciesOrRefuse(manifest, facts.tree, os);
  for (const dependency of dependencies) {
    // Installing fetches packages: it needs the network, locked or not.
    nonDefaults.push(setting("deps-network", dependency.file));
    if (dependency.lock === undefined) nonDefaults.push(setting("unlocked-dependencies", dependency.file));
  }
  const node = variant("node");
  const interpreters = new Set<string>(scripts.map((script) => script.interpreter));
  if (setup !== undefined) interpreters.add(setup.interpreter);
  const declaredScripts = asMap(manifest.get("scripts"));
  if (declaredScripts !== undefined) {
    for (const target of declaredScripts.values()) {
      if (typeof target === "string") {
        const dot = target.lastIndexOf(".");
        interpreters.add(SCRIPT_INTERPRETERS[dot === -1 ? "" : target.slice(dot)] ?? "node");
      } else if (target instanceof Map && entryOn(target, os)) {
        interpreters.add(textOf(target, "interpreter"));
      }
    }
  }
  if (python !== undefined) interpreters.add("python");
  if (node !== undefined) interpreters.add("node");
  const commands = new Set<string>();
  for (const command of runtime instanceof Map ? asList(runtime.get("commands")) : []) {
    if (typeof command === "string") commands.add(command);
    else if (entryOn(command, os)) commands.add(textOf(command, "name"));
  }
  for (const dependency of dependencies) {
    interpreters.add(dependency.runtime);
    if (dependency.runtime === "node") commands.add("npm");
  }
  const ungranted = new Set<string>();
  const hostGrants = facts.grants.get("env") ?? [];
  const mcp = asMap(manifest.get("mcp"));
  for (const server of mcp === undefined ? [] : asList(mcp.get("servers"))) {
    const serverEnv = server instanceof Map ? asMap(server.get("env")) : undefined;
    for (const value of serverEnv?.values() ?? []) {
      if (!(value instanceof Map) || !isReference(value)) continue;
      if (!facts.granted(value)) ungranted.add(referenceName(value));
      else if (value.get("provider") === "env") nonDefaults.push(setting("env-passthrough", textOf(value, "key")));
      else nonDefaults.push(setting("secret-read", referenceName(value)));
    }
    const headersEnv = server instanceof Map ? asMap(server.get("headers_env")) : undefined;
    const headers = [...(headersEnv?.values() ?? [])].filter((item): item is string => typeof item === "string");
    for (const name of [...stringsOf(server, "env_passthrough"), ...headers]) {
      if (hostGrants.includes(name)) nonDefaults.push(setting("env-passthrough", name));
      else ungranted.add(`env:${name}`);
    }
    const url = textOf(server, "url");
    if (url.slice(0, 7).toLowerCase() === "http://") {
      const authority = (url.slice(7).split("/")[0] ?? "").split("?")[0] ?? "";
      const colon = authority.lastIndexOf(":");
      const host = (colon === -1 ? authority : authority.slice(0, colon)).replace(/[A-Z]/g, (c) => c.toLowerCase());
      if (host !== "localhost" && host !== "[::1]" && !host.startsWith("127.")) {
        nonDefaults.push(setting("insecure-transport", textOf(server, "name")));
      }
    }
  }
  const own = asMap(manifest.get("env"));
  for (const entry of own?.values() ?? []) {
    if (entry instanceof Map && isReference(entry) && isTrue(entry, "optional") && !facts.granted(entry)) {
      ungranted.add(referenceName(entry));
    }
  }
  const unique = new Map<string, NonDefaultSetting>();
  for (const item of nonDefaults) unique.set(`${item.id}\0${item.subject}`, item);
  return {
    ungranted: sortedUnique(ungranted),
    supported,
    env,
    envScripts: scripts,
    setup,
    python,
    node,
    dependencies,
    needs: { interpreters: sortedUnique(interpreters), commands: sortedUnique(commands) },
    nonDefaults: [...unique.values()].sort((a, b) => compareText(a.id, b.id) || compareText(a.subject, b.subject)),
  };
}

/** The environment of several overlays together, or the refusal that stopped it, with what `pre-env` hooks reported. */
export interface ComposedEnvironment {
  readonly env: Environment | undefined;
  /** What stopped it; set when `env` is not. */
  readonly error: AosError | undefined;
  readonly hookReports: readonly HookReport[];
  readonly hookNonDefaults: ReadonlyArray<readonly [string, string]>;
}

/**
 * The environment `active` overlays (each manifest with its facts, in composition order) build in
 * turn, on `base`: every overlay's root first, then each `pre-env` hook's variables, then each
 * overlay's own. Non-default settings are appended to `nonDefaults`.
 */
export function composedEnvironment(
  active: ReadonlyArray<readonly [Document, Facts]>,
  base: Environment,
  preEnv: ReadonlyMap<string, HookRun>,
  nonDefaults: NonDefaultSetting[],
): ComposedEnvironment {
  const env = base;
  for (const [, facts] of active) {
    env.set(rootVariable(facts.identity), facts.root, false);
    if (facts.state !== undefined) env.set(stateVariable(facts.identity), facts.state, false);
  }
  const hookReports: HookReport[] = [];
  const hookNonDefaults: Array<readonly [string, string]> = [];
  const refused = (error: AosError): ComposedEnvironment => ({ env: undefined, error, hookReports, hookNonDefaults });
  for (const [, facts] of active) {
    const given = preEnv.get(facts.identity);
    if (given === undefined) continue;
    const run: HookRun = Object.assign(Object.create(Object.getPrototypeOf(given) as object) as HookRun, given, {
      source: facts.identity,
    });
    const fired = fireEvent("pre-env", [run], undefined, facts.settings, env.windows);
    hookReports.push(...fired.reports);
    hookNonDefaults.push(...fired.nonDefaults);
    if (fired.decision === "refuse") return refused(new AosError("hook-refused", facts.identity));
    for (const [name, value] of fired.env) {
      if (value === undefined) env.unset(name);
      else env.set(name, value, false);
    }
  }
  for (const [manifest, facts] of active) {
    try {
      applyOverlay(env, manifest, facts, nonDefaults);
    } catch (error) {
      if (error instanceof AosError) return refused(error);
      throw error;
    }
  }
  return { env, error: undefined, hookReports, hookNonDefaults };
}
