/** Catalogs of overlays and skills, listing several, and icons judged from their headers. */
import { AosError } from "./error.ts";
import { words } from "./kinds.ts";
import type { Format } from "./kinds.ts";
import { type Settings, allows } from "./limits.ts";
import { asciiLower, normalizeName, validOverlayName, validRelativePath, validToolName } from "./names.ts";
import { parsePayload, readDocument } from "./read.ts";
import { Source } from "./source.ts";
import { compareText, startsWithBytes } from "./text.ts";
import { aboutFieldValid, catalogFieldValid, isDigest, isGitRef } from "./validate.ts";
import type { Document, Value } from "./value.ts";

export const ENTRY_REFUSALS = [
  "invalid-name",
  "duplicate-name",
  "invalid-entry",
  "invalid-source",
  "invalid-pin",
  "ref-not-allowed",
  "leaves-repository",
  "local-source",
  "source-credentials",
] as const;
/** Why an entry of a catalog is refused. */
export type EntryRefusal = (typeof ENTRY_REFUSALS)[number];
export const entryRefusal = words(ENTRY_REFUSALS);

export const CATALOG_FORMS = ["minimal", "full"] as const;
/** `minimal` when every entry is a source string, else `full`. */
export type CatalogForm = (typeof CATALOG_FORMS)[number];
export const catalogForm = words(CATALOG_FORMS);

export const ICON_FORMATS = ["png", "webp"] as const;
export type IconFormat = (typeof ICON_FORMATS)[number];
export const iconFormat = words(ICON_FORMATS);

/** One entry of a catalog, its source resolved beside the catalog. `description` is a stranger's text: never render it as markup. */
export interface CatalogEntry {
  readonly source: Source;
  readonly pin: string | undefined;
  readonly description: string | undefined;
  readonly about: Document | undefined;
}

/** The entries of one table by name, and the names refused with the reason. */
export interface CatalogSection {
  readonly entries: Map<string, CatalogEntry>;
  readonly refused: Array<readonly [string, EntryRefusal]>;
}

export interface Catalog {
  readonly form: CatalogForm;
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly homepage: string | undefined;
  readonly overlays: CatalogSection;
  readonly skills: CatalogSection | undefined;
  /** JSON pointers of fields read and dropped. */
  readonly ignored: string[];
}

/** A catalog file's format from its name's extension; undefined for any other. */
export function catalogFormat(name: string): Format | undefined {
  const last = name.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot === -1) return undefined;
  switch (asciiLower(last.slice(dot + 1))) {
    case "toml":
      return "toml";
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return undefined;
  }
}

/** Reads a catalog file's document: its name's extension picks the format; any other name reads as an AOS document. */
export function readCatalogDocument(data: Uint8Array, name: string, settings: Settings): Document {
  const bounded = settings.with({ manifestBytes: settings.catalogBytes });
  const format = catalogFormat(name);
  if (format === undefined) {
    try {
      return readDocument(data, bounded);
    } catch (error) {
      if (error instanceof AosError && error.setting === "manifest_bytes") error.over("catalog_bytes");
      throw error;
    }
  }
  if (!allows(bounded.manifestBytes, data.length)) throw new AosError("too-large", "a catalog").over("catalog_bytes");
  const bytes = startsWithBytes(data, [0xef, 0xbb, 0xbf]) ? data.subarray(3) : data;
  return parsePayload(bytes, format, bounded, false);
}

const escapeToken = (token: string): string => token.replaceAll("~", "~0").replaceAll("/", "~1");

const hasDrive = (location: string): boolean => /^[A-Za-z]:/.test(location);
const hasScheme = (location: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]+:/.test(location);
const absoluteDirectory = (location: string): boolean =>
  location.startsWith("/") || location.startsWith("\\") || hasDrive(location);

function normpath(path: string): string {
  const rooted = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!rooted) parts.push("..");
    } else parts.push(part);
  }
  const joined = parts.join("/");
  if (rooted) return `/${joined}`;
  return joined === "" ? "." : joined;
}

function join(parts: readonly string[]): string {
  let out = "";
  for (const part of parts.filter((item) => item !== "")) {
    if (part.startsWith("/")) out = part;
    else if (out === "" || out.endsWith("/")) out += part;
    else out += `/${part}`;
  }
  return normpath(out === "" ? "." : out);
}

function dirname(path: string): string {
  const head = path.slice(0, path.lastIndexOf("/") + 1);
  return head !== "" && /[^/]/.test(head) ? head.replace(/\/+$/, "") : head;
}

function removeDots(path: string): string {
  const out: string[] = [];
  const segments = path.split("/");
  const last = segments.length - 1;
  segments.forEach((segment, index) => {
    if (segment === ".") {
      if (index === last) out.push("");
    } else if (segment === "..") {
      if (out.length > 1) out.pop();
      if (index === last) out.push("");
    } else out.push(segment);
  });
  const joined = out.join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function urlJoin(base: string, reference: string): string {
  if (reference === "") return base;
  if (hasScheme(reference)) return reference;
  const split = base.indexOf("://");
  if (split === -1) return reference;
  const scheme = base.slice(0, split);
  const rest = base.slice(split + 3);
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const tail = cut === -1 ? "" : rest.slice(cut);
  if (reference.startsWith("//")) return `${scheme}:${reference}`;
  const withoutFragment = tail.split("#")[0] ?? "";
  const question = withoutFragment.indexOf("?");
  const basePath = question === -1 ? withoutFragment : withoutFragment.slice(0, question);
  const baseQuery = question === -1 ? "" : withoutFragment.slice(question + 1);
  const suffixAt = reference.search(/[?#]/);
  const refPath = suffixAt === -1 ? reference : reference.slice(0, suffixAt);
  const refSuffix = suffixAt === -1 ? "" : reference.slice(suffixAt);
  if (refPath === "") {
    let path = basePath;
    if (refSuffix.startsWith("#") && baseQuery !== "") path += `?${baseQuery}`;
    return `${scheme}://${authority}${path}${refSuffix}`;
  }
  let path: string;
  if (refPath.startsWith("/")) path = removeDots(refPath);
  else {
    let head = basePath.slice(0, basePath.lastIndexOf("/") + 1);
    if (head === "" && authority !== "") head = "/";
    path = removeDots(`${head}${refPath}`);
  }
  return `${scheme}://${authority}${path}${refSuffix}`;
}

/** A copy of `source` with fields changed, whatever `Source`'s constructor takes. */
function changed(
  source: Source,
  changes: { location?: string; path?: string | undefined; reference?: string | undefined; kind?: Source["kind"] },
): Source {
  return new Source(
    changes.kind ?? source.kind,
    changes.location ?? source.location,
    "reference" in changes ? changes.reference : source.reference,
    "path" in changes ? changes.path : source.path,
  );
}

function resolveEntrySource(entry: Source, origin: Source | undefined): Source {
  const location = entry.location;
  const relative = entry.kind === "directory" && !absoluteDirectory(location) && !hasScheme(location);
  const local = !relative && entry.isLocal();
  if (origin === undefined || origin.kind === "directory") {
    if (relative && origin !== undefined) {
      const folder = dirname(origin.location.replaceAll("\\", "/"));
      return changed(entry, { location: join([folder, location]) });
    }
    return entry;
  }
  if (local) throw "local-source" satisfies EntryRefusal;
  if (!relative) {
    if (entry.kind !== "git" && !entry.isWebUrl()) throw "invalid-source" satisfies EntryRefusal;
    if (entry.holdsCredentials()) throw "source-credentials" satisfies EntryRefusal;
    return entry;
  }
  if (origin.kind === "git") {
    const folder = dirname(origin.path ?? "");
    const path = join([folder, location, entry.path ?? ""]);
    if (path === ".." || path.startsWith("../")) throw "leaves-repository" satisfies EntryRefusal;
    if (path !== "." && !validRelativePath(path)) throw "invalid-source" satisfies EntryRefusal;
    return changed(origin, { path: path === "." ? undefined : path });
  }
  return changed(entry, { kind: "url", location: urlJoin(origin.location, location), reference: undefined });
}

function storeAbout(about: Value, at: string, ignored: string[]): Document | undefined {
  if (!(about instanceof Map)) {
    ignored.push(at);
    return undefined;
  }
  const shown: Document = new Map();
  for (const [field, value] of about) {
    if (aboutFieldValid(field, value)) shown.set(field, value);
    else ignored.push(`${at}/${escapeToken(field)}`);
  }
  return shown.size > 0 ? shown : undefined;
}

const ENTRY_KEYS = ["source", "ref", "pin", "description", "about"];

/** An entry, or the reason it is refused (thrown as an `EntryRefusal` word). */
function catalogEntry(value: Value, at: string, origin: Source | undefined, ignored: string[]): CatalogEntry {
  let fields: Document;
  if (typeof value === "string") fields = new Map([["source", value]]);
  else if (value instanceof Map) {
    for (const key of value.keys()) if (!ENTRY_KEYS.includes(key)) throw "invalid-entry" satisfies EntryRefusal;
    fields = value;
  } else throw "invalid-entry" satisfies EntryRefusal;
  const text = fields.get("source");
  if (typeof text !== "string") throw "invalid-entry" satisfies EntryRefusal;
  let parsed: Source;
  try {
    parsed = Source.parse(text);
  } catch {
    throw "invalid-source" satisfies EntryRefusal;
  }
  let source = resolveEntrySource(parsed, origin);
  const reference = fields.get("ref");
  if (reference !== undefined) {
    if (typeof reference !== "string" || !isGitRef(reference)) throw "invalid-entry" satisfies EntryRefusal;
    if (parsed.kind !== "git" || parsed.reference !== undefined) throw "ref-not-allowed" satisfies EntryRefusal;
    source = changed(source, { reference });
  }
  let pin: string | undefined;
  const given = fields.get("pin");
  if (given !== undefined) {
    if (typeof given === "string" && isDigest(given)) pin = given;
    else throw "invalid-pin" satisfies EntryRefusal;
  }
  let description: string | undefined;
  const words = fields.get("description");
  if (words !== undefined) {
    if (typeof words === "string") description = words;
    else ignored.push(`${at}/description`);
  }
  const about = fields.get("about");
  return {
    source,
    pin,
    description,
    about: about === undefined ? undefined : storeAbout(about, `${at}/about`, ignored),
  };
}

function section(
  table: Document,
  prefix: string,
  nameOk: (name: string) => boolean,
  fold: (name: string) => string,
  origin: Source | undefined,
  ignored: string[],
): CatalogSection {
  const holders = new Map<string, number>();
  for (const key of table.keys()) if (nameOk(key)) holders.set(fold(key), (holders.get(fold(key)) ?? 0) + 1);
  const out: CatalogSection = { entries: new Map(), refused: [] };
  for (const key of [...table.keys()].sort(compareText)) {
    if (!nameOk(key)) out.refused.push([key, "invalid-name"]);
    else if ((holders.get(fold(key)) ?? 0) > 1) out.refused.push([key, "duplicate-name"]);
    else {
      try {
        out.entries.set(key, catalogEntry(table.get(key)!, `${prefix}/${escapeToken(key)}`, origin, ignored));
      } catch (refusal) {
        if (typeof refusal !== "string" || !entryRefusal.is(refusal)) throw refusal;
        out.refused.push([key, refusal]);
      }
    }
  }
  return out;
}

/**
 * Reads a catalog. `name` is the file's name, whose extension picks the format; `base` is the
 * source string the file came from, against which relative sources resolve. Nothing is fetched.
 */
export function readCatalog(data: Uint8Array, name: string, base: string | undefined, settings: Settings): Catalog {
  const document = readCatalogDocument(data, name, settings);
  const overlaysValue = document.get("overlays");
  const skillsValue = document.get("skills");
  const overlays = overlaysValue instanceof Map ? overlaysValue : undefined;
  const skills = skillsValue instanceof Map ? skillsValue : undefined;
  if (overlays === undefined && skills === undefined) throw new AosError("not-a-catalog", "");
  let origin: Source | undefined;
  if (base !== undefined) {
    try {
      origin = Source.parse(base);
    } catch {
      throw new AosError("invalid-source", "the catalog's base");
    }
  }
  const ignored: string[] = [];
  if (overlays === undefined && document.has("overlays")) ignored.push("/overlays");
  const listed = [...(overlays?.values() ?? []), ...(skills?.values() ?? [])];
  const form: CatalogForm = listed.every((item) => typeof item === "string") ? "minimal" : "full";
  const fields = new Map<string, string | undefined>();
  for (const field of ["name", "description", "homepage"]) {
    const value = document.get(field);
    if (value !== undefined) {
      if (catalogFieldValid(field, value)) fields.set(field, typeof value === "string" ? value : undefined);
      else ignored.push(`/${field}`);
    }
  }
  const overlaySection = section(overlays ?? new Map(), "/overlays", validOverlayName, normalizeName, origin, ignored);
  let skillSection: CatalogSection | undefined;
  if (skills !== undefined) {
    skillSection = section(
      skills,
      "/skills",
      (item) => validToolName(item) && validRelativePath(item),
      (item) => item.toLowerCase(),
      origin,
      ignored,
    );
  } else if (document.has("skills")) ignored.push("/skills");
  ignored.sort(compareText);
  return {
    form,
    name: fields.get("name"),
    description: fields.get("description"),
    homepage: fields.get("homepage"),
    overlays: overlaySection,
    skills: skillSection,
    ignored,
  };
}

/** One overlay a listing offers. */
export interface ListedEntry {
  /** The label of the catalog it comes from. */
  readonly catalog: string;
  readonly name: string;
  /** The normalized name two catalogs' entries share. */
  readonly identity: string;
  /** `name`, or `catalog/name` when another catalog offers the same identity. */
  readonly shown: string;
}

export interface Listing {
  readonly entries: ListedEntry[];
  /** Identity to the labels of the catalogs that offer it, where more than one does. */
  readonly collisions: Map<string, string[]>;
}

/** Lists the overlays of several catalogs, given as `[label, catalog]`, qualifying the names they share. Refuses a label that is no valid name or repeats (`invalid-label`). */
export function listCatalogs(catalogs: ReadonlyArray<readonly [string, Catalog]>): Listing {
  const seen = new Set<string>();
  for (const [label] of catalogs) {
    if (!validOverlayName(label) || seen.has(normalizeName(label))) throw new AosError("invalid-label", "");
    seen.add(normalizeName(label));
  }
  const offered = new Map<string, Array<[string, string]>>();
  for (const [label, catalog] of catalogs) {
    for (const name of catalog.overlays.entries.keys()) {
      const identity = normalizeName(name);
      offered.set(identity, [...(offered.get(identity) ?? []), [label, name]]);
    }
  }
  const listing: Listing = { entries: [], collisions: new Map() };
  for (const identity of [...offered.keys()].sort(compareText)) {
    const holders = offered.get(identity)!.sort((a, b) => compareText(a[0], b[0]) || compareText(a[1], b[1]));
    const qualified = holders.length > 1;
    if (qualified) listing.collisions.set(identity, holders.map(([label]) => label));
    for (const [label, name] of holders) {
      listing.entries.push({ catalog: label, name, identity, shown: qualified ? `${label}/${name}` : name });
    }
  }
  return listing;
}

/** The entry a requested `name` or `catalog/name` names: `not-found` for none, `ambiguous` for several. */
export function chooseListed(listing: Listing, requested: string): ListedEntry {
  const slash = requested.lastIndexOf("/");
  const label = slash === -1 ? undefined : requested.slice(0, slash);
  const name = slash === -1 ? requested : requested.slice(slash + 1);
  if (!validOverlayName(name) || (label !== undefined && !validOverlayName(label))) throw new AosError("not-found", "");
  const found = listing.entries.filter(
    (entry) =>
      entry.identity === normalizeName(name) &&
      (label === undefined || normalizeName(entry.catalog) === normalizeName(label)),
  );
  const [first] = found;
  if (first === undefined) throw new AosError("not-found", "");
  if (found.length > 1) throw new AosError("ambiguous", "");
  return first;
}

/** An icon judged from its header alone. */
export interface Icon {
  readonly format: IconFormat;
  readonly width: number;
  readonly height: number;
}

const le = (data: Uint8Array): number => data.reduceRight((value, byte) => value * 256 + byte, 0);
const be = (data: Uint8Array): number => data.reduce((value, byte) => value * 256 + byte, 0);
const same = (data: Uint8Array, at: number, expected: readonly number[]): boolean => startsWithBytes(data, expected, at);
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

function pngSize(data: Uint8Array): [number, number] {
  if (data.length < 24 || !same(data, 8, [0, 0, 0, 0x0d, ...ascii("IHDR")])) throw new AosError("icon-unreadable", "");
  return [be(data.subarray(16, 20)), be(data.subarray(20, 24))];
}

function webpSize(data: Uint8Array): [number, number] {
  const unreadable = (): AosError => new AosError("icon-unreadable", "");
  if (data.length < 20 || le(data.subarray(4, 8)) + 8 > data.length) throw unreadable();
  if (same(data, 12, ascii("VP8 ")) && data.length >= 30 && same(data, 23, [0x9d, 0x01, 0x2a])) {
    return [le(data.subarray(26, 28)) & 0x3fff, le(data.subarray(28, 30)) & 0x3fff];
  }
  if (same(data, 12, ascii("VP8L")) && data.length >= 25 && data[20] === 0x2f) {
    const bits = le(data.subarray(21, 25));
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (same(data, 12, ascii("VP8X")) && data.length >= 30) {
    return [le(data.subarray(24, 27)) + 1, le(data.subarray(27, 30)) + 1];
  }
  throw unreadable();
}

/** Reads an icon's format and size from its header: extension, size, signature and dimensions are checked against `settings`. */
export function readIcon(data: Uint8Array, name: string, settings: Settings): Icon {
  const last = name.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  const extension = dot === -1 ? "" : asciiLower(last.slice(dot + 1));
  if (extension !== "png" && extension !== "webp") throw new AosError("icon-format", "");
  if (!allows(settings.iconBytes, data.length)) throw new AosError("icon-too-large", "").over("icon_bytes");
  let format: IconFormat;
  if (startsWithBytes(data, [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a])) format = "png";
  else if (same(data, 0, ascii("RIFF")) && same(data, 8, ascii("WEBP"))) format = "webp";
  else throw new AosError("icon-format", "");
  if (format !== extension) throw new AosError("icon-mismatch", "");
  const [width, height] = format === "png" ? pngSize(data) : webpSize(data);
  if (width === 0 || height === 0) throw new AosError("icon-unreadable", "");
  if (!allows(settings.iconWidth, width)) throw new AosError("icon-dimensions", "").over("icon_width");
  if (!allows(settings.iconHeight, height)) throw new AosError("icon-dimensions", "").over("icon_height");
  return { format, width, height };
}
