/** Composition: which overlays a request activates, in what order, and what they contribute together. */
import {
  type Dependency,
  PartialLock,
  contextOf,
  declared,
  dependenciesOf,
  rulesOf,
  skillEntries,
} from "./defaults.ts";
import { AosError } from "./error.ts";
import type { LeftState, Runtime } from "./kinds.ts";
import { normalizeName, rootVariable } from "./names.ts";
import { Delivery, type Held } from "./skills.ts";
import { compareText } from "./text.ts";
import { OverlayTree } from "./tree.ts";
import type { Document } from "./value.ts";

/** A `requires` chain that returns to an overlay already in it. Thrown by `resolve` and `compose`. */
export class Cycle extends AosError {
  /** The overlays of the cycle, the first repeated at the end. */
  readonly chain: readonly string[];

  constructor(chain: readonly string[]) {
    super("cycle", chain.join(" -> "));
    this.name = "Cycle";
    this.chain = chain;
  }
}

/** What a request needs, in the order to install it. */
export interface Resolution {
  readonly installOrder: readonly string[];
  /** `[required by, name]` for each required overlay that is not available; the first is empty for a requested one. */
  readonly missing: ReadonlyArray<readonly [string, string]>;
}

/** Resolves `requested` and everything it `requires`, dependencies first. Throws {@link Cycle}. */
export function resolve(available: ReadonlyMap<string, Document>, requested: readonly string[]): Resolution {
  const installOrder: string[] = [];
  const missing: Array<[string, string]> = [];
  const visit = (name: string, chain: string[]): void => {
    if (installOrder.includes(name)) return;
    const at = chain.indexOf(name);
    if (at !== -1) throw new Cycle([...chain.slice(at), name]);
    const manifest = available.get(name);
    if (manifest === undefined) {
      missing.push([chain[chain.length - 1] ?? "", name]);
      return;
    }
    chain.push(name);
    for (const required of declared(manifest, "requires")) {
      if (typeof required === "string") visit(normalizeName(required), chain);
    }
    chain.pop();
    installOrder.push(name);
  };
  for (const name of requested) visit(normalizeName(name), []);
  return { installOrder, missing };
}

/** `active` ordered by `priority` (default 500), then name, then identity. */
export function compositionOrder(overlays: ReadonlyMap<string, Document>, active: readonly string[]): string[] {
  const key = (identity: string): [bigint, string, string] => {
    const manifest = overlays.get(identity);
    const priority = manifest?.get("priority");
    const name = manifest?.get("name");
    return [
      typeof priority === "bigint" ? priority : 500n,
      typeof name === "string" && name !== "" ? name : identity,
      identity,
    ];
  };
  const keyed = active.map((identity) => ({ identity, key: key(identity) }));
  keyed.sort((a, b) => {
    if (a.key[0] !== b.key[0]) return a.key[0] < b.key[0] ? -1 : 1;
    return compareText(a.key[1], b.key[1]) || compareText(a.key[2], b.key[2]);
  });
  return keyed.map((item) => item.identity);
}

/** What a request activates and what the active overlays contribute together. */
export interface Composition {
  readonly installOrder: readonly string[];
  readonly active: readonly string[];
  readonly missing: ReadonlyArray<readonly [string, string]>;
  /** Identity to its `NAME_OVERLAY_ROOT` variable. */
  readonly rootVariables: ReadonlyMap<string, string>;
  readonly routing: readonly string[];
  /** `[identity, path]` of each rule file. */
  readonly rules: ReadonlyArray<readonly [string, string]>;
  /** `[identity, path]` of each context file. */
  readonly context: ReadonlyArray<readonly [string, string]>;
  /** Skill name to the identity of the overlay that delivers it. */
  readonly skills: ReadonlyMap<string, string>;
  readonly skillCollisions: readonly string[];
}

const EMPTY_TREE = OverlayTree.empty();

/** Composes the overlays `requested` activates. Throws {@link Cycle}. */
export function compose(
  overlays: ReadonlyMap<string, Document>,
  requested: readonly string[],
  trees: ReadonlyMap<string, OverlayTree>,
): Composition {
  const resolution = resolve(overlays, requested);
  const active = compositionOrder(overlays, resolution.installOrder);
  const routing: string[] = [];
  const rules: Array<[string, string]> = [];
  const context: Array<[string, string]> = [];
  const delivery = new Delivery();
  for (const identity of active) {
    const manifest = overlays.get(identity)!;
    const tree = trees.get(identity) ?? EMPTY_TREE;
    for (const route of declared(manifest, "routing")) if (typeof route === "string") routing.push(route);
    for (const path of rulesOf(manifest, tree)) rules.push([identity, path]);
    for (const path of contextOf(manifest, tree)) context.push([identity, path]);
    for (const entry of skillEntries(manifest, tree)) {
      const bundled = entry.origin === "bundled";
      const held: Held = bundled
        ? { kind: "bundled", identity }
        : { kind: "elsewhere", key: entry.key, pin: entry.pin };
      delivery.offer(entry.name, identity, bundled, held);
    }
  }
  return {
    installOrder: resolution.installOrder,
    active,
    missing: resolution.missing,
    rootVariables: new Map(active.map((identity) => [identity, rootVariable(identity)] as const)),
    routing,
    rules,
    context,
    skills: delivery.delivered(),
    skillCollisions: delivery.collisions(),
  };
}

/** One package environment, shared by the overlays that name it, and the files that fill it. */
export interface PackageEnvironment {
  readonly runtime: Runtime;
  readonly environment: string;
  readonly overlays: readonly string[];
  /** `[identity, file]` of each overlay's dependency file. */
  readonly files: ReadonlyArray<readonly [string, string]>;
  readonly locked: boolean;
}

/** A package two overlays of one environment pin to different versions. */
export interface PackageConflict {
  readonly runtime: Runtime;
  readonly environment: string;
  readonly package: string;
  readonly overlays: readonly string[];
}

/** An environment a removed overlay leaves behind, and what happens to it. */
export interface LeftEnvironment {
  readonly overlay: string;
  readonly runtime: Runtime;
  readonly environment: string;
  readonly then: LeftState;
}

/** The package environments of the active overlays. */
export interface Environments {
  readonly environments: readonly PackageEnvironment[];
  readonly conflicts: readonly PackageConflict[];
  /** Overlays left out because their pins conflict. */
  readonly blocked: readonly string[];
  readonly left: readonly LeftEnvironment[];
}

/** The pinned packages (name to version) a dependency file holds. */
function pins(runtime: Runtime, text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (text === undefined) return out;
  if (runtime === "node") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return out;
    }
    const dependencies = (parsed as { dependencies?: unknown } | null)?.dependencies;
    if (dependencies !== null && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      for (const name of Object.keys(dependencies)) {
        const spec = (dependencies as Record<string, unknown>)[name];
        out.set(name, typeof spec === "string" ? spec : JSON.stringify(spec));
      }
    }
    return out;
  }
  const joined = text.replaceAll("\\\r\n", " ").replaceAll("\\\n", " ");
  for (const line of joined.split("\n")) {
    const found = pinnedRequirement((line.endsWith("\r") ? line.slice(0, -1) : line).trim());
    if (found !== undefined) out.set(found[0], found[1]);
  }
  return out;
}

/** `name==version` (extras allowed) as the normalized name and the version. */
function pinnedRequirement(line: string): [string, string] | undefined {
  if (!/^[A-Za-z0-9]/.test(line)) return undefined;
  let end = 0;
  while (end < line.length && /[A-Za-z0-9._-]/.test(line[end]!)) end += 1;
  let name = line.slice(0, end);
  while (/[._-]$/.test(name)) name = name.slice(0, -1);
  const after = line.slice(name.length);
  if (!/^[\s[=]/u.test(after)) return undefined;
  let rest = after.trimStart();
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return undefined;
    rest = rest.slice(close + 1).trimStart();
  }
  if (rest.startsWith("===")) rest = rest.slice(3);
  else if (rest.startsWith("==")) rest = rest.slice(2);
  else return undefined;
  rest = rest.trimStart();
  const version = /^[^\s;\\]*/u.exec(rest)![0];
  if (version === "") return undefined;
  let normalized = "";
  for (const c of name) {
    if (c === "-" || c === "_" || c === ".") {
      if (!normalized.endsWith("-")) normalized += "-";
    } else normalized += c.replace(/[A-Z]/g, (u) => u.toLowerCase());
  }
  return [normalized, version];
}

function dependenciesOrRefuse(manifest: Document, tree: OverlayTree, os: string): Dependency[] {
  try {
    return dependenciesOf(manifest, tree, os);
  } catch (error) {
    if (error instanceof PartialLock) throw new AosError("partial-lock", error.subject);
    throw error;
  }
}

interface Group {
  readonly runtime: Runtime;
  readonly environment: string;
  readonly owner: string;
  readonly members: Array<[string, Dependency]>;
}

/**
 * Groups the active overlays' dependencies into package environments: an `isolated` one per
 * overlay, any other shared by name. Overlays that pin one package differently are blocked.
 * `removed` overlays say what becomes of their environments. Throws `partial-lock`.
 */
export function environments(
  overlays: ReadonlyMap<string, Document>,
  active: readonly string[],
  trees: ReadonlyMap<string, OverlayTree>,
  os: string,
  removed: readonly string[],
): Environments {
  const treeOf = (identity: string): OverlayTree => trees.get(identity) ?? EMPTY_TREE;
  const keyOf = (runtime: Runtime, environment: string, identity: string): string =>
    `${runtime}\0${environment}\0${environment === "isolated" ? identity : ""}`;
  const groups = new Map<string, Group>();
  for (const identity of active) {
    const manifest = overlays.get(identity);
    if (manifest === undefined) continue;
    for (const dependency of dependenciesOrRefuse(manifest, treeOf(identity), os)) {
      const key = keyOf(dependency.runtime, dependency.environment, identity);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          runtime: dependency.runtime,
          environment: dependency.environment,
          owner: identity,
          members: [],
        };
        groups.set(key, group);
      }
      group.members.push([identity, dependency]);
    }
  }
  const conflicts: PackageConflict[] = [];
  const blocked = new Set<string>();
  for (const { runtime, environment, members } of groups.values()) {
    const asked = new Map<string, Array<[string, string[]]>>();
    for (const [identity, dependency] of members) {
      for (const [pkg, version] of pins(runtime, treeOf(identity).text(dependency.file))) {
        let versions = asked.get(pkg);
        if (versions === undefined) {
          versions = [];
          asked.set(pkg, versions);
        }
        const existing = versions.find(([known]) => known === version);
        if (existing === undefined) versions.push([version, [identity]]);
        else existing[1].push(identity);
      }
    }
    for (const pkg of [...asked.keys()].sort(compareText)) {
      const versions = asked.get(pkg)!;
      if (versions.length > 1) {
        const involved = members
          .map(([identity]) => identity)
          .filter((identity) => versions.some(([, askers]) => askers.includes(identity)));
        for (const identity of involved) blocked.add(identity);
        conflicts.push({ runtime, environment, package: pkg, overlays: involved });
      }
    }
  }
  const remaining = new Set<string>();
  const built: PackageEnvironment[] = [];
  for (const [key, group] of groups) {
    const kept = group.members.filter(([identity]) => !blocked.has(identity));
    if (kept.length === 0) continue;
    remaining.add(key);
    // npm installs one lock file; several overlays' locks cannot be combined.
    const locked =
      group.runtime === "node"
        ? kept.length === 1 && kept[0]![1].lock !== undefined
        : kept.every(([, dependency]) => dependency.lock !== undefined);
    built.push({
      runtime: group.runtime,
      environment: group.environment,
      overlays: kept.map(([identity]) => identity),
      files: kept.map(([identity, dependency]) => [identity, dependency.file] as const),
      locked,
    });
  }
  const left: LeftEnvironment[] = [];
  for (const identity of removed) {
    const manifest = overlays.get(identity);
    if (manifest === undefined) continue;
    for (const dependency of dependenciesOrRefuse(manifest, treeOf(identity), os)) {
      const key = keyOf(dependency.runtime, dependency.environment, identity);
      left.push({
        overlay: identity,
        runtime: dependency.runtime,
        environment: dependency.environment,
        then: remaining.has(key) ? "rebuilt" : "deleted",
      });
    }
  }
  return {
    environments: built,
    conflicts,
    blocked: active.filter((identity) => blocked.has(identity)),
    left,
  };
}


/**
 * The order the hooks of one event run in, as `[scope, source]` pairs: every active overlay that has a hook
 * (`has`) in composition order, then the user's own, then the project's, whichever order `scopes` (the scopes
 * that have one) names them in; a scope's own hook has the source `""`. Throws `Cycle` when `requires` loops.
 */
export function hookOrder(
  overlays: ReadonlyMap<string, Document>,
  requested: readonly string[],
  has: readonly string[],
  scopes: readonly string[],
): Array<[string, string]> {
  const active = compositionOrder(overlays, resolve(overlays, requested).installOrder);
  const order: Array<[string, string]> = active.filter((identity) => has.includes(identity)).map((identity) => ["overlay", identity]);
  for (const scope of ["user", "project"]) if (scopes.includes(scope)) order.push([scope, ""]);
  return order;
}
