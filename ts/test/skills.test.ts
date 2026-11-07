import assert from "node:assert/strict";
import { test } from "node:test";
import { type Catalog, readCatalog } from "../src/catalog.ts";
import { AosError } from "../src/error.ts";
import { Settings } from "../src/limits.ts";
import { type SkillSource, fetchPlanned, readFetchedSkill, resolveSkills } from "../src/skills.ts";
import type { Source } from "../src/source.ts";
import { type Document, fromPlain, valuesEqual } from "../src/value.ts";
import { toJson, treesOf } from "./g2_support.ts";
import { type Json, arr, decode64, expectedErrors, obj, runFile, settingsOf, show, str, strings, utf8 } from "./support.ts";

function resolveCase(item: Map<string, Json>): void {
  const settings = new Settings();
  const overlays = new Map<string, Document>(
    [...obj(item.get("overlays"))].map(([identity, manifest]) => [identity, obj(manifest) as unknown as Document] as const),
  );
  const catalogs: Array<readonly [string, Catalog]> = arr(item.get("catalogs") ?? []).map((entry) => {
    const found = obj(entry);
    const base = found.get("base");
    return [
      str(found.get("label")),
      readCatalog(utf8(str(found.get("text"))), str(found.get("name")), typeof base === "string" ? base : undefined, settings),
    ] as const;
  });
  const fetches = item.get("fetches");
  const plan = resolveSkills(
    overlays,
    strings(item.get("requested")),
    treesOf(item),
    catalogs,
    strings(item.get("order")),
    typeof fetches === "boolean" ? fetches : true,
    settings,
  );
  const skills = plan.skills.map((skill) => {
    const out: Record<string, unknown> = { name: skill.name, origin: skill.origin, overlay: skill.overlay };
    if (skill.source !== undefined) out["source"] = skill.source;
    if (skill.pin !== undefined) out["pin"] = skill.pin;
    if (skill.catalog !== undefined) out["catalog"] = skill.catalog;
    if (skill.catalogs !== undefined) out["catalogs"] = skill.catalogs;
    return out;
  });
  const got = toJson({
    skills,
    missing: plan.missing,
    ambiguous: plan.ambiguous,
    unpinned: plan.unpinned,
    non_defaults: plan.nonDefaults,
    not_fetched: plan.notFetched,
    name_mismatch: plan.nameMismatch,
    shadowing: plan.shadowing,
    delivered: plan.delivered,
    collisions: plan.collisions,
  });
  if (!valuesEqual(got, item.get("expect"))) throw new Error(`got ${show(got)}`);
}

function fetchedCase(item: Map<string, Json>): void {
  const files = [...obj(item.get("fetched"))].map(([path, content]) => {
    const encoded = content instanceof Map ? content.get("base64") : undefined;
    return [path, typeof encoded === "string" ? decode64(encoded) : utf8(str(content))] as const;
  });
  const pin = item.get("pin");
  const expect = obj(item.get("expect"));
  let read;
  try {
    read = readFetchedSkill(str(item.get("name")), files, typeof pin === "string" ? pin : undefined, settingsOf(item));
  } catch (error) {
    if (error instanceof AosError && expectedErrors(expect).includes(error.class)) return;
    throw error;
  }
  const got = toJson({ digest: read.digest.toString(), reported: read.reported });
  if (!valuesEqual(got, expect)) throw new Error(`got ${show(got)}`);
}

runFile("skills.json", (item) => (item.has("fetched") ? fetchedCase(item) : resolveCase(item)));

const manifests = (plain: unknown): Map<string, Document> =>
  new Map([["a", fromPlain(plain) as Document]]);

test("a plan is fetched through the caller's source and checked against its pins", async () => {
  const skill = utf8("---\nname: review\ndescription: Reviews.\n---\nBody.\n");
  const digest = readFetchedSkill("review", [["SKILL.md", skill]], undefined, new Settings()).digest.toString();
  const plan = resolveSkills(
    manifests({
      skills: [
        { name: "review", source: "https://example.org/skills.git#review", pin: digest },
        { name: "lint", source: "https://example.org/skills.git#lint", pin: digest },
        { name: "gone", source: "https://example.org/skills.git#gone" },
      ],
    }),
    ["a"],
    new Map(),
    [],
    [],
    true,
    new Settings(),
  );
  assert.equal(plan.toFetch.length, 3);
  const served = new Map<string, Array<readonly [string, Uint8Array]>>([
    ["https://example.org/skills.git#review", [["SKILL.md", skill]]],
    ["https://example.org/skills.git#lint", [["SKILL.md", utf8("---\nname: lint\n---\n")]]],
  ]);
  const asked: string[] = [];
  const source: SkillSource = {
    fetch: async (from: Source) => {
      asked.push(from.shown());
      const files = served.get(from.shown());
      if (files === undefined) throw new AosError("io", "no such source");
      return files;
    },
  };
  const got = await fetchPlanned(plan, source, new Settings());
  const outcome = (name: string): string => {
    const found = got.find((entry) => entry.name === name)!;
    return found.outcome.ok ? "ok" : found.outcome.error.class;
  };
  assert.equal(outcome("review"), "ok");
  assert.equal(outcome("lint"), "pin-mismatch");
  assert.equal(outcome("gone"), "io");
  assert.equal(asked.length, 3);
});

test("a synchronous source works too", async () => {
  const skill = utf8("---\nname: x\n---\n");
  const plan = resolveSkills(
    manifests({ skills: [{ name: "x", source: "https://example.org/x.git" }] }),
    ["a"],
    new Map(),
    [],
    [],
    true,
    new Settings(),
  );
  const got = await fetchPlanned(plan, { fetch: () => [["SKILL.md", skill]] }, new Settings());
  assert.equal(got[0]?.outcome.ok, true);
});

test("a consumer that does not fetch is asked for nothing", () => {
  const plan = resolveSkills(
    manifests({ skills: [{ name: "x", source: "https://example.org/x.git" }] }),
    ["a"],
    new Map(),
    [],
    [],
    false,
    new Settings(),
  );
  assert.equal(plan.toFetch.length, 0);
  assert.equal(plan.notFetched.length, 1);
});

test("a cycle among the requested overlays is refused as cycle", () => {
  const overlays = new Map<string, Document>([
    ["a", fromPlain({ requires: ["b"] }) as Document],
    ["b", fromPlain({ requires: ["a"] }) as Document],
  ]);
  assert.throws(() => resolveSkills(overlays, ["a"], new Map(), [], [], true, new Settings()), { class: "cycle" });
});
