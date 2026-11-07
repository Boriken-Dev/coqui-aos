/** Skills from elsewhere: where a name resolves, what is fetched, and the check of what came back. */
import type { Catalog, CatalogEntry } from "./catalog.ts";
import { listCatalogs } from "./catalog.ts";
import { Cycle, compositionOrder, resolve } from "./compose.ts";
import { OverlayTree } from "./tree.ts";
import { skillEntries } from "./defaults.ts";
import { Digest, checkEntries, digestEntries } from "./digest.ts";
import type { TreeEntry } from "./digest.ts";
import { AosError } from "./error.ts";
import { readFrontMatter, splitFrontMatter } from "./front_matter.ts";
import { words } from "./kinds.ts";
import type { Settings } from "./limits.ts";
import { EXCLUDED_COMPONENTS, asciiLower, normalizeName } from "./names.ts";
import { type Source, hostIsPrivate, sourceHost } from "./source.ts";
import { compareText, startsWithBytes } from "./text.ts";
import type { Document } from "./value.ts";

/** What holds a skill's name: a bundled skill of an overlay, or a source and its pin. */
export type Held =
  | { readonly kind: "bundled"; readonly identity: string }
  | { readonly kind: "elsewhere"; readonly key: string | undefined; readonly pin: string | undefined };

function sameHeld(a: Held, b: Held): boolean {
  if (a.kind === "bundled") return b.kind === "bundled" && a.identity === b.identity;
  return b.kind === "elsewhere" && a.key === b.key && a.pin === b.pin;
}

/** Which overlay's skill is delivered under each name, folding case; two different holders of one name collide and a bundled skill wins. */
export class Delivery {
  private readonly winners = new Map<string, { name: string; identity: string; held: Held }>();
  private readonly clashes = new Set<string>();

  /** Offers a skill; false when an earlier holder keeps the name. */
  offer(name: string, identity: string, bundled: boolean, held: Held): boolean {
    const folded = name.toLowerCase();
    const earlier = this.winners.get(folded);
    if (earlier !== undefined && !sameHeld(earlier.held, held)) {
      this.clashes.add(folded);
      if (!bundled) return false;
    }
    this.winners.set(folded, { name, identity, held });
    return true;
  }

  /** Name to the identity of the overlay that delivers it. */
  delivered(): Map<string, string> {
    const entries = [...this.winners.values()].map((item) => [item.name, item.identity] as [string, string]);
    entries.sort((a, b) => compareText(a[0], b[0]));
    return new Map(entries);
  }

  /** The folded names two holders offered. */
  collisions(): string[] {
    return [...this.clashes].sort(compareText);
  }

  holds(name: string, identity: string): boolean {
    return this.winners.get(name.toLowerCase())?.identity === identity;
  }
}

export const PLANNED_ORIGINS = ["bundled", "source", "catalog", "missing", "ambiguous"] as const;
/** Where a planned skill comes from. */
export type PlannedOrigin = (typeof PLANNED_ORIGINS)[number];
export const plannedOrigin = words(PLANNED_ORIGINS);

export interface PlannedSkill {
  readonly name: string;
  readonly overlay: string;
  readonly origin: PlannedOrigin;
  /** The source as shown: no user information or query. */
  readonly source: string | undefined;
  readonly pin: string | undefined;
  /** The catalog a `catalog` skill came from. */
  readonly catalog: string | undefined;
  /** The catalogs an `ambiguous` name is offered by. */
  readonly catalogs: string[] | undefined;
}

/** A skill the caller must fetch. */
export interface Fetch {
  readonly name: string;
  readonly overlay: string;
  readonly from: Source;
  readonly pin: string | undefined;
}

export interface SkillPlan {
  readonly skills: PlannedSkill[];
  /** `[name, overlay]` of each catalog skill no catalog offers. */
  readonly missing: Array<readonly [string, string]>;
  /** `[name, overlay, catalogs]`. */
  readonly ambiguous: Array<readonly [string, string, string[]]>;
  readonly unpinned: Array<readonly [string, string]>;
  /** `[id, name, overlay]` such as `insecure-transport` and `private-source`. */
  readonly nonDefaults: Array<readonly [string, string, string]>;
  /** `[name, overlay]`: asked of a consumer that does not fetch. */
  readonly notFetched: Array<readonly [string, string]>;
  readonly nameMismatch: Array<readonly [string, string]>;
  readonly shadowing: Array<readonly [string, string]>;
  /** Name to the overlay that delivers it. */
  delivered: Map<string, string>;
  collisions: string[];
  readonly toFetch: Fetch[];
}

function bundledName(data: Uint8Array, settings: Settings): string | undefined {
  const name = readFrontMatter(data, settings).data?.get("name");
  if (name === undefined) return undefined;
  return typeof name === "string" ? name : `\u0000${typeof name}`;
}

function ranked<T>(offers: Array<[string, T]>, rank: readonly string[]): Array<[string, T]> {
  for (const label of rank) {
    const at = offers.findIndex(([offered]) => normalizeName(offered) === label);
    if (at !== -1) return [offers[at]!];
  }
  return offers;
}

/**
 * Plans the skills of the overlays `requested` (and what they require): where each comes from,
 * what the caller must fetch, and what could not be placed. `catalogs` are `[label, catalog]`;
 * `order` ranks labels where several offer a name; `fetches` is false for a consumer that does not
 * fetch. Nothing is fetched here.
 */
export function resolveSkills(
  overlays: ReadonlyMap<string, Document>,
  requested: readonly string[],
  trees: ReadonlyMap<string, OverlayTree>,
  catalogs: ReadonlyArray<readonly [string, Catalog]>,
  order: readonly string[],
  fetches: boolean,
  settings: Settings,
): SkillPlan {
  let resolution;
  try {
    resolution = resolve(overlays, requested);
  } catch (error) {
    if (error instanceof Cycle) throw new AosError("cycle", error.chain.join(" -> "));
    throw error;
  }
  const active = compositionOrder(overlays, resolution.installOrder);
  listCatalogs(catalogs);
  const rank = order.map(normalizeName);
  const empty = OverlayTree.fromPaths([]);
  const plan: SkillPlan = {
    skills: [],
    missing: [],
    ambiguous: [],
    unpinned: [],
    nonDefaults: [],
    notFetched: [],
    nameMismatch: [],
    shadowing: [],
    delivered: new Map(),
    collisions: [],
    toFetch: [],
  };
  const delivery = new Delivery();
  for (const identity of active) {
    const tree = trees.get(identity) ?? empty;
    for (const entry of skillEntries(overlays.get(identity)!, tree)) {
      let origin: PlannedOrigin = entry.origin === "bundled" ? "bundled" : entry.origin === "source" ? "source" : "catalog";
      let source = entry.source;
      let pin = entry.pin;
      let catalog: string | undefined;
      let catalogLabels: string[] | undefined;
      let key = entry.key;
      let from = entry.from;
      if (entry.origin === "catalog") {
        const wanted = entry.name.toLowerCase();
        const offers: Array<[string, CatalogEntry]> = [];
        for (const [label, listed] of catalogs) {
          if (listed.skills === undefined) continue;
          for (const [name, offer] of listed.skills.entries) {
            if (name.toLowerCase() === wanted) offers.push([label, offer]);
          }
        }
        const chosen = ranked(offers, rank);
        if (chosen.length === 0) {
          origin = "missing";
          plan.missing.push([entry.name, identity]);
        } else if (chosen.length === 1) {
          const [label, offer] = chosen[0]!;
          catalog = label;
          source = offer.source.shown();
          key = offer.source.keyWith(undefined);
          from = offer.source;
          pin = offer.pin;
        } else {
          const labels = chosen.map(([label]) => label).sort(compareText);
          origin = "ambiguous";
          catalogLabels = labels;
          plan.ambiguous.push([entry.name, identity, labels]);
        }
      }
      plan.skills.push({ name: entry.name, overlay: identity, origin, source, pin, catalog, catalogs: catalogLabels });
      if (origin === "missing" || origin === "ambiguous") continue;
      const bundled = origin === "bundled";
      if (bundled) {
        const text = tree.bytes(`skills/${entry.name}/SKILL.md`);
        if (text !== undefined) {
          const named = bundledName(text, settings);
          if (named !== undefined && named !== entry.name) {
            plan.nameMismatch.push([entry.name, identity]);
            continue;
          }
        }
      } else {
        if (!fetches) {
          plan.notFetched.push([entry.name, identity]);
          continue;
        }
        if (pin === undefined) plan.unpinned.push([entry.name, identity]);
        const location = (key ?? "").split("#")[0] ?? "";
        let lower = asciiLower(location);
        if (lower.startsWith("git+")) lower = lower.slice(4);
        if (lower.startsWith("http://") || lower.startsWith("git://")) {
          plan.nonDefaults.push(["insecure-transport", entry.name, identity]);
        }
        if (hostIsPrivate(sourceHost(location))) plan.nonDefaults.push(["private-source", entry.name, identity]);
      }
      const held: Held = bundled ? { kind: "bundled", identity } : { kind: "elsewhere", key, pin };
      if (!delivery.offer(entry.name, identity, bundled, held)) {
        plan.shadowing.push([entry.name, identity]);
      } else if (!bundled && from !== undefined) {
        plan.toFetch.push({ name: entry.name, overlay: identity, from, pin });
      }
    }
  }
  plan.delivered = delivery.delivered();
  plan.collisions = delivery.collisions();
  // A skill later displaced by a bundled one of the same name is not fetched.
  const kept = plan.toFetch.filter((item) => delivery.holds(item.name, item.overlay));
  plan.toFetch.splice(0, plan.toFetch.length, ...kept);
  return plan;
}

/** A fetched skill that passed: its tree digest, the front-matter keys beyond the inert ones, and the files the digest covers. */
export interface FetchedSkill {
  readonly digest: Digest;
  readonly reported: string[];
  /** The paths the digest covers, sorted: a caller writes these and nothing else, since the digest leaves out entries under an excluded name (`node_modules`, `__pycache__`, `*.pyc`, `.git`) that Python, Node.js and Git load code from. */
  readonly files: string[];
}

const INERT_KEYS = ["name", "description", "license", "compatibility", "metadata"];

/**
 * Checks a skill that was fetched, as `[path, bytes]` files: the tree limits first, then the
 * digest against `pin` (so nothing unverified is parsed), then `SKILL.md`'s YAML front matter,
 * whose `name` must be `name`.
 */
export function readFetchedSkill(
  name: string,
  files: ReadonlyArray<readonly [string, Uint8Array]>,
  pin: string | undefined,
  settings: Settings,
): FetchedSkill {
  const entries: Array<[string[], TreeEntry]> = files.map(([path, bytes]) => [
    path.split("/"),
    { kind: "file", bytes },
  ]);
  checkEntries(entries, settings);
  const tree = digestEntries(entries);
  const digest = tree.digest;
  if (pin !== undefined) {
    let pinned: Digest | undefined;
    try {
      pinned = Digest.parse(pin);
    } catch {
      pinned = undefined;
    }
    if (pinned === undefined || pinned.toString() !== digest.toString()) throw new AosError("pin-mismatch", name);
  }
  const skill = files.find(([path]) => path === "SKILL.md");
  if (skill === undefined) throw new AosError("not-a-skill", name);
  const found = readFrontMatter(skill[1], settings);
  if (found.error !== undefined) {
    const refused = new AosError("skill-unreadable", found.error.class);
    if (found.error.line !== undefined) refused.onLine(found.error.line);
    throw refused;
  }
  const split = splitFrontMatter(skill[1], settings);
  if (
    found.case !== "mapping" ||
    found.format !== "yaml" ||
    (split.metadata !== undefined && startsWithBytes(split.metadata, [0x23, 0x21]))
  ) {
    throw new AosError("skill-unreadable", "front matter in YAML is required");
  }
  const data = found.data ?? new Map();
  if (data.get("name") !== name) throw new AosError("skill-name-mismatch", name);
  const reported = [...data.keys()].filter((key) => !INERT_KEYS.includes(key)).sort(compareText);
  return { digest, reported, files: [...tree.files.keys()] };
}

/** The caller's way to get a skill's files, as `[path, bytes]`; fetching is the caller's alone. May be synchronous or return a promise. */
export interface SkillSource {
  fetch(source: Source): ReadonlyArray<readonly [string, Uint8Array]> | Promise<ReadonlyArray<readonly [string, Uint8Array]>>;
}

/** A planned skill's outcome: the checked skill, or why it was not. */
export interface FetchedPlanned {
  readonly name: string;
  readonly overlay: string;
  readonly outcome: { readonly ok: true; readonly skill: FetchedSkill } | { readonly ok: false; readonly error: AosError };
}

/**
 * Fetches each skill in `plan.toFetch` once through `fetcher`, one after another, and checks it
 * (pin first). A failure of the fetcher or the check is that skill's outcome alone.
 */
export async function fetchPlanned(plan: SkillPlan, fetcher: SkillSource, settings: Settings): Promise<FetchedPlanned[]> {
  const out: FetchedPlanned[] = [];
  for (const item of plan.toFetch) {
    let outcome: FetchedPlanned["outcome"];
    try {
      const files = await fetcher.fetch(item.from);
      outcome = { ok: true, skill: readFetchedSkill(item.name, files, item.pin, settings) };
    } catch (error) {
      outcome = { ok: false, error: error instanceof AosError ? error : new AosError("io", "the fetch failed") };
    }
    out.push({ name: item.name, overlay: item.overlay, outcome });
  }
  return out;
}
