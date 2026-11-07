/** What an overlay's files contribute by default, merged with what its manifest declares. */
import { AosError } from "./error.ts";
import { splitFrontMatter } from "./front_matter.ts";
import { type Runtime, runtime as runtimeWords } from "./kinds.ts";
import { Settings } from "./limits.ts";
import { normalizeName, osMatches, validToolName } from "./names.ts";
import { Source } from "./source.ts";
import { compareText, trimWhitespace } from "./text.ts";
import { OverlayTree } from "./tree.ts";
import type { Document, Value } from "./value.ts";

/** The `defaults` keys a manifest may turn off. */
export const DEFAULT_KEYS: readonly string[] = [
  "bin",
  "lib",
  "env",
  "env_scripts",
  "setup",
  "deps",
  "context",
  "skills",
  "rules",
  "hooks",
];

const DEFAULT_PATHS: ReadonlyArray<readonly [string, string, string]> = [
  ["bin", "PATH", "bin"],
  ["lib", "PYTHONPATH", "lib/python"],
  ["lib", "NODE_PATH", "lib/node"],
];

/** A script's file extension, the interpreter that runs it, and the operating systems it is for. */
export const DEFAULT_SCRIPTS: ReadonlyArray<readonly [string, string, string | undefined]> = [
  [".py", "python", undefined],
  [".js", "node", undefined],
  [".mjs", "node", undefined],
  [".cjs", "node", undefined],
  [".ps1", "powershell", "windows"],
  [".bash", "bash", "unix"],
  [".sh", "sh", "unix"],
];

/** The interpreters a manifest may name. */
export const INTERPRETERS: readonly string[] = ["python", "node", "powershell", "bash", "sh"];

/** The mapping inside a value, if it is one. */
export function asMap(value: Value | undefined): Document | undefined {
  return value instanceof Map ? value : undefined;
}

/** The text of a value, if it is text. */
export function asText(value: Value | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The list inside a value, if it is one. */
export function asList(value: Value | undefined): Value[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** A mapping from pairs. */
export function mapOf(entries: ReadonlyArray<readonly [string, Value]>): Document {
  return new Map(entries);
}

/** Whether a default is on: unless `defaults.<key>` is `false`. */
export function defaultOn(manifest: Document, key: string): boolean {
  return asMap(manifest.get("defaults"))?.get(key) !== false;
}

/** The entries a manifest declares under `field`, or none. */
export function declared(manifest: Document, field: string): Value[] {
  return asList(manifest.get(field)) ?? [];
}

/** The path an entry names: the text itself, or a mapping's `path`. */
export function named(entry: Value): string | undefined {
  if (typeof entry === "string") return entry;
  return entry instanceof Map ? asText(entry.get("path")) : undefined;
}

function merge(defaults: Value[], given: Value[]): Value[] {
  const names = new Set(given.map(named).filter((name): name is string => name !== undefined));
  return [...defaults.filter((entry) => {
    const name = named(entry);
    return name === undefined || !names.has(name);
  }), ...given];
}

/** An entry's `os` list, if it has one. */
export function osList(entry: Value): string[] | undefined {
  const names = entry instanceof Map ? asList(entry.get("os")) : undefined;
  return names?.filter((name): name is string => typeof name === "string");
}

/** Whether an entry applies on `os`. */
export function entryOn(entry: Value, os: string): boolean {
  return osMatches(osList(entry), os);
}

/** The first variant that applies on `os`. */
export function firstVariant(variants: Value[], os: string): Value | undefined {
  return variants.find((variant) => entryOn(variant, os));
}

/** The paths added to a variable by default: `bin`, `lib/python` and `lib/node` that the tree holds and the manifest does not name. */
export function defaultPaths(manifest: Document, tree: OverlayTree): Document[] {
  const names = new Set(declared(manifest, "paths").map(named).filter((name): name is string => name !== undefined));
  const members = tree.members();
  return DEFAULT_PATHS.filter(
    ([key, , directory]) =>
      defaultOn(manifest, key) && !names.has(directory) && members.some((path) => path.startsWith(`${directory}/`)),
  ).map(([, variable, directory]) => mapOf([["variable", variable], ["path", directory]]));
}

/** The default paths, then the declared. */
export function pathsOf(manifest: Document, tree: OverlayTree): Value[] {
  return [...defaultPaths(manifest, tree), ...declared(manifest, "paths")];
}

/** The rule files: `rules/*.md` by default, then the declared, a declared path replacing a default of its name. */
export function rulesOf(manifest: Document, tree: OverlayTree): string[] {
  let found: Value[] = [];
  if (defaultOn(manifest, "rules")) {
    found = tree.members().filter((path) => {
      const name = path.startsWith("rules/") ? path.slice("rules/".length) : undefined;
      return name !== undefined && !name.includes("/") && name.endsWith(".md");
    });
  }
  return strings(merge(found, declared(manifest, "rules")));
}

function hasBody(tree: OverlayTree): boolean {
  const data = tree.bytes("OVERLAY.md");
  if (data === undefined) return false;
  const split = splitFrontMatter(data, new Settings({ manifestBytes: null }));
  return split.body(data).some((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a);
}

function bodyIsContext(manifest: Document, tree: OverlayTree): boolean {
  return hasBody(tree) && (defaultOn(manifest, "context") || declared(manifest, "context").some((entry) => entry === "OVERLAY.md"));
}

/** The context files: `OVERLAY.md`'s body, else `CONTEXT.md`, then the declared. */
export function contextOf(manifest: Document, tree: OverlayTree): string[] {
  let found: Value[] = [];
  if (defaultOn(manifest, "context")) {
    if (hasBody(tree)) found = ["OVERLAY.md"];
    else if (tree.hasMember("CONTEXT.md")) found = ["CONTEXT.md"];
  }
  const merged = strings(merge(found, declared(manifest, "context")));
  return bodyIsContext(manifest, tree) ? merged.filter((entry) => entry !== "CONTEXT.md") : merged;
}

/** Context files the overlay carries and does not use: `CONTEXT.md` beside a body that is the context. */
export function contextIgnored(manifest: Document, tree: OverlayTree): string[] {
  return bodyIsContext(manifest, tree) && tree.hasMember("CONTEXT.md") ? ["CONTEXT.md"] : [];
}

/** The context files a harness's hints list. */
export function harnessContextOf(manifest: Document, harness: string, tree: OverlayTree): string[] {
  const listed = strings(asList(asMap(asMap(manifest.get("harness"))?.get(harness))?.get("context")) ?? []);
  return bodyIsContext(manifest, tree) ? listed.filter((entry) => entry !== "CONTEXT.md") : listed;
}

function strings(entries: Value[]): string[] {
  return entries.filter((entry): entry is string => typeof entry === "string");
}

/** Where a skill comes from. */
export type SkillOrigin = "bundled" | "source" | "catalog";

/** A skill a manifest asks for. */
export interface SkillEntry {
  readonly name: string;
  readonly origin: SkillOrigin;
  /** The source as shown: no user information. */
  readonly source: string | undefined;
  /** The source with everything that identifies it; never shown. */
  readonly key: string | undefined;
  readonly pin: string | undefined;
  readonly from: Source | undefined;
}

/** The skills the overlay bundles: `skills/<name>/SKILL.md`. */
export function bundledSkills(tree: OverlayTree): Set<string> {
  const found = new Set<string>();
  for (const path of tree.members()) {
    const parts = path.split("/");
    if (parts.length === 3 && parts[0] === "skills" && parts[2] === "SKILL.md" && validToolName(parts[1]!)) found.add(parts[1]!);
  }
  return found;
}

/** The skills an overlay asks for, by name in byte order: bundled, from a source, or from a catalog. */
export function skillEntries(manifest: Document, tree: OverlayTree): SkillEntry[] {
  const bundled = bundledSkills(tree);
  const found = new Map<string, SkillEntry>();
  const plain = (name: string, origin: SkillOrigin): SkillEntry => ({
    name,
    origin,
    source: undefined,
    key: undefined,
    pin: undefined,
    from: undefined,
  });
  if (defaultOn(manifest, "skills")) for (const name of bundled) found.set(name, plain(name, "bundled"));
  for (const entry of declared(manifest, "skills")) {
    if (entry instanceof Map) {
      const name = asText(entry.get("name"));
      const source = asText(entry.get("source"));
      if (name === undefined || source === undefined) continue;
      let parsed: Source;
      try {
        parsed = Source.parse(source);
      } catch (error) {
        if (error instanceof AosError) continue;
        throw error;
      }
      const reference = asText(entry.get("ref"));
      found.set(name, {
        name,
        origin: "source",
        source: parsed.shownWith(reference ?? parsed.reference),
        key: parsed.keyWith(reference),
        pin: asText(entry.get("pin")),
        from: reference === undefined ? parsed : parsed.withReference(reference),
      });
    } else if (typeof entry === "string") {
      found.set(entry, plain(entry, bundled.has(entry) ? "bundled" : "catalog"));
    }
  }
  return [...found.entries()].sort(([a], [b]) => compareText(a, b)).map(([, skill]) => skill);
}

/** The skill names {@link skillEntries} lists. */
export function skillsOf(manifest: Document, tree: OverlayTree): string[] {
  return skillEntries(manifest, tree).map((entry) => entry.name);
}

/** The environment files: `env` by default, then the declared. */
export function envFilesOf(manifest: Document, tree: OverlayTree): Value[] {
  const found: Value[] = [];
  if (defaultOn(manifest, "env") && tree.hasMember("env")) found.push(mapOf([["path", "env"], ["format", "dotenv"]]));
  return merge(found, declared(manifest, "env_files"));
}

/** The default script of a field, which interpreter runs it, and what was declared besides. */
export interface DefaultScript {
  readonly chosen: Document | undefined;
  readonly configured: boolean;
  readonly present: string[];
  readonly others: Value[];
}

/** Chooses `<stem>.<ext>`: the first script present that applies on `os` and whose interpreter the consumer has. */
export function defaultScript(
  manifest: Document,
  field: string,
  stem: string,
  tree: OverlayTree,
  os: string,
  interpreters: readonly string[],
): DefaultScript {
  const given = declared(manifest, field);
  if (!defaultOn(manifest, field)) return { chosen: undefined, configured: false, present: [], others: given };
  const present = DEFAULT_SCRIPTS.map(([extension]) => `${stem}${extension}`).filter((path) => tree.hasMember(path));
  const configured = new Map<string, Document>();
  for (const entry of given) {
    if (!(entry instanceof Map)) continue;
    const path = named(entry);
    if (path !== undefined && present.includes(path)) configured.set(path, entry);
  }
  const others = given.filter((entry) => {
    const path = named(entry);
    return path === undefined || !configured.has(path);
  });
  for (const [extension, interpreter, on] of DEFAULT_SCRIPTS) {
    const path = `${stem}${extension}`;
    if (!present.includes(path)) continue;
    let entry = configured.get(path);
    if (entry === undefined) {
      entry = mapOf([["interpreter", interpreter], ["path", path]]);
      if (on !== undefined) entry.set("os", [on]);
    }
    const name = asText(entry.get("interpreter"));
    const runs = name !== undefined && interpreters.includes(name);
    if (entryOn(entry, os) && runs) return { configured: configured.has(path), chosen: entry, present, others };
  }
  return { chosen: undefined, configured: false, present, others };
}

/** A variant's `environment` name, normalized, or `shared`. */
export function environmentName(variant: Value | undefined): string {
  const name = variant instanceof Map ? asText(variant.get("environment")) : undefined;
  return normalizeName(name ?? "shared");
}

/** A dependency file an overlay brings, and the lock beside it. */
export interface Dependency {
  readonly runtime: Runtime;
  readonly file: string;
  readonly lock: string | undefined;
  readonly environment: string;
}

/** A requirements file that pins some requirements by hash and not others. Its text is the file's path. */
export class PartialLock extends AosError {
  constructor(subject: string) {
    super("partial-lock", subject);
    this.name = "PartialLock";
  }
}

/** Whether every requirement carries a hash; a file with some and not all is a {@link PartialLock}. */
export function requirementsLocked(text: string, path: string): boolean {
  const joined = text.replaceAll("\\\r\n", " ").replaceAll("\\\n", " ");
  const hashed = splitLines(joined)
    .map(trimWhitespace)
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      for (let at = line.indexOf("--hash"); at !== -1; at = line.indexOf("--hash", at + 1)) {
        const before = at === 0 || /\s$/u.test(line.slice(0, at));
        const next = line[at + "--hash".length];
        const after = next !== undefined && (next === "=" || /\s/u.test(next));
        if (before && after) return true;
      }
      return false;
    });
  if (hashed.length > 0 && hashed.every(Boolean)) return true;
  if (hashed.some(Boolean)) throw new PartialLock(path);
  return false;
}

/** Splits text into lines as Rust's `str::lines` does: on `\n`, dropping a `\r` before it. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Checks a requirements file reads as requirements only: no option but `--hash`, no direct URL, and every one pinned with `==` when `locked`. */
export function checkRequirements(text: string, locked: boolean): void {
  const joined = text.replaceAll("\\\r\n", " ").replaceAll("\\\n", " ");
  const lines = splitLines(joined);
  for (const [number, whole] of lines.entries()) {
    const refused = (why: string): AosError => new AosError("invalid-requirements", why).onLine(number + 1);
    const line = trimWhitespace(whole.split(" #")[0] ?? "");
    if (line === "" || line.startsWith("#")) continue;
    const cut = line.indexOf(" --");
    const requirement = cut === -1 ? line : line.slice(0, cut);
    const options = cut === -1 ? "" : line.slice(cut + 3);
    if (requirement.startsWith("-")) throw refused("an option, and only requirements are read");
    if (requirement.includes("://") || requirement.includes(" @ ")) throw refused("a direct URL");
    if (options !== "" && options.split(" --").some((option) => !option.replace(/^-+/, "").startsWith("hash"))) {
      throw refused("an option other than --hash");
    }
    if (locked && !requirement.includes("==")) throw refused("a requirement not pinned with ==");
  }
}

/** The dependency files an overlay brings on `os`: Python's requirements and Node's package, each with its lock. Throws {@link PartialLock}. */
export function dependenciesOf(manifest: Document, tree: OverlayTree, os: string): Dependency[] {
  const runtimeTable = asMap(manifest.get("runtime"));
  const variants = (name: string): Value[] => asList(runtimeTable?.get(name)) ?? [];
  const found: Dependency[] = [];
  for (const [name, byDefault, beside] of [
    ["python", "lib/python/requirements.txt", undefined],
    ["node", "lib/node/package.json", "lib/node/package-lock.json"],
  ] as const) {
    const variant = firstVariant(variants(name), os);
    const field = (key: string): string | undefined => (variant instanceof Map ? asText(variant.get(key)) : undefined);
    let file: string;
    let lock: string | undefined;
    if (name === "python" && (field("lock") !== undefined || field("requirements") !== undefined)) {
      file = field("lock") ?? field("requirements") ?? "";
      lock = field("lock");
    } else if (name === "node" && field("package") !== undefined) {
      file = field("package") ?? "";
      const candidate = file.endsWith("package.json") ? `${file.slice(0, -"package.json".length)}package-lock.json` : undefined;
      lock = candidate !== undefined && tree.hasMember(candidate) ? candidate : undefined;
    } else if (defaultOn(manifest, "deps") && tree.hasMember(byDefault)) {
      if (beside === undefined) {
        const text = tree.text(byDefault);
        lock = text !== undefined && requirementsLocked(text, byDefault) ? byDefault : undefined;
      } else {
        lock = tree.hasMember(beside) ? beside : undefined;
      }
      file = byDefault;
    } else {
      continue;
    }
    found.push({ runtime: runtimeWords.named(name) ?? "python", file, lock, environment: environmentName(variant) });
  }
  return found;
}
