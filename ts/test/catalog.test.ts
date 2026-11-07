import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Catalog,
  type CatalogEntry,
  type CatalogSection,
  chooseListed,
  listCatalogs,
  readCatalog,
  readCatalogDocument,
  readIcon,
} from "../src/catalog.ts";
import { AosError } from "../src/error.ts";
import { Settings } from "../src/limits.ts";
import { valuesEqual } from "../src/value.ts";
import { sourceJson, toJson } from "./g2_support.ts";
import { type Json, arr, bytesOf, num, obj, runFile, settingsOf, show, str, utf8 } from "./support.ts";

function entryJson(entry: CatalogEntry): Map<string, Json> {
  const out = new Map<string, Json>([["source", sourceJson(entry.source)]]);
  if (entry.pin !== undefined) out.set("pin", entry.pin);
  if (entry.description !== undefined) out.set("description", entry.description);
  if (entry.about !== undefined) out.set("about", entry.about as unknown as Json);
  return out;
}

function sectionJson(section: CatalogSection): Map<string, Json> {
  return new Map<string, Json>([
    ["entries", new Map([...section.entries].map(([name, entry]) => [name, entryJson(entry)] as const))],
    ["refused", section.refused.map(([name, why]) => [name, why])],
  ]);
}

function catalogJson(catalog: Catalog): Map<string, Json> {
  const out = new Map<string, Json>([["form", catalog.form]]);
  for (const [key, value] of [
    ["name", catalog.name],
    ["description", catalog.description],
    ["homepage", catalog.homepage],
  ] as const) {
    if (value !== undefined) out.set(key, value);
  }
  const overlays = sectionJson(catalog.overlays);
  out.set("entries", overlays.get("entries")!);
  out.set("refused", overlays.get("refused")!);
  if (catalog.skills !== undefined) out.set("skills", sectionJson(catalog.skills));
  out.set("ignored", catalog.ignored);
  return out;
}

function readItem(item: Map<string, Json>, settings: Settings): Catalog {
  const base = item.get("base");
  return readCatalog(utf8(str(item.get("text"))), str(item.get("name")), typeof base === "string" ? base : undefined, settings);
}

function same(got: Json, expect: Json | undefined): void {
  if (!valuesEqual(got, expect)) throw new Error(`got ${show(got)}`);
}

function catalogsCase(item: Map<string, Json>): void {
  const settings = new Settings();
  const read = arr(item.get("catalogs")).map((entry) => {
    const found = obj(entry);
    return [str(found.get("label")), readItem(found, settings)] as const;
  });
  const expect = obj(item.get("expect"));
  let listing;
  try {
    listing = listCatalogs(read);
  } catch (error) {
    if (error instanceof AosError && expect.get("error") === error.class) return;
    throw error;
  }
  const got = new Map<string, Json>([
    [
      "entries",
      listing.entries.map((entry) =>
        toJson({ catalog: entry.catalog, name: entry.name, identity: entry.identity, shown: entry.shown }),
      ),
    ],
    ["collisions", new Map([...listing.collisions].map(([identity, labels]) => [identity, labels] as const))],
  ]);
  const choose = item.get("choose");
  if (Array.isArray(choose) && choose.length > 0) {
    const chosen = new Map<string, Json>();
    for (const request of choose) {
      try {
        const entry = chooseListed(listing, str(request));
        chosen.set(str(request), toJson({ catalog: entry.catalog, name: entry.name }));
      } catch (error) {
        if (!(error instanceof AosError)) throw error;
        chosen.set(str(request), toJson({ error: error.class }));
      }
    }
    got.set("chosen", chosen);
  }
  same(got, expect);
}

function iconCase(item: Map<string, Json>): void {
  const icon = obj(item.get("icon"));
  const limits = icon.get("limits") instanceof Map ? obj(icon.get("limits")) : new Map<string, Json>();
  const changes: Record<string, number> = {};
  const bytes = num(limits.get("max_bytes"));
  if (bytes !== undefined) changes["iconBytes"] = bytes;
  const width = num(limits.get("max_width"));
  if (width !== undefined) changes["iconWidth"] = width;
  const height = num(limits.get("max_height"));
  if (height !== undefined) changes["iconHeight"] = height;
  const expect = obj(item.get("expect"));
  let read;
  try {
    read = readIcon(bytesOf(icon), str(icon.get("name")), new Settings(changes));
  } catch (error) {
    if (error instanceof AosError && expect.get("error") === error.class) return;
    throw error;
  }
  same(toJson({ format: read.format, width: read.width, height: read.height }), expect);
}

runFile("catalog.json", (item) => {
  if (item.has("icon")) return iconCase(item);
  if (item.has("catalogs")) return catalogsCase(item);
  const expect = obj(item.get("expect"));
  let catalog: Catalog;
  try {
    catalog = readItem(obj(item.get("catalog")), new Settings());
  } catch (error) {
    if (error instanceof AosError && expect.get("error") === error.class) return;
    throw error;
  }
  same(catalogJson(catalog), expect);
});

test("a catalog past catalog_bytes is too-large", () => {
  const data = utf8('[overlays]\na = "../a"\n');
  assert.throws(() => readCatalog(data, "c.toml", undefined, new Settings({ catalogBytes: 4 })), { class: "too-large" });
});

test("a skills table alone makes a catalog; neither table does not", () => {
  const skills = readCatalog(utf8('[skills]\nreview = "https://example.org/r.git#review"\n'), "c.toml", undefined, new Settings());
  assert.equal(skills.skills?.entries.size, 1);
  assert.equal(skills.overlays.entries.size, 0);
  assert.throws(() => readCatalog(utf8('name = "x"\n'), "c.toml", undefined, new Settings()), { class: "not-a-catalog" });
});

test("an icon's size is read from the header and held to the limits", () => {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 9, 0, 0, 0, 4]);
  assert.deepEqual({ ...readIcon(png, "a.png", new Settings()) }, { format: "png", width: 9, height: 4 });
  assert.throws(() => readIcon(png, "a.png", new Settings({ iconWidth: 8 })), { class: "icon-dimensions" });
  assert.throws(() => readIcon(png, "a.webp", new Settings()), { class: "icon-mismatch" });
});
