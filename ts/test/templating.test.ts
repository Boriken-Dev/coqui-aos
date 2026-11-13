import assert from "node:assert/strict";
import { test } from "node:test";
import { AosError } from "../src/error.ts";
import { Settings } from "../src/limits.ts";
import { type TemplateFacts, contextText, skillText, template, templateValues } from "../src/template.ts";
import { type Document, type Value, fromPlain } from "../src/value.ts";
import { bytesOf, obj, runFile } from "./support.ts";
import type { Json } from "./support.ts";

function factsOf(item: Map<string, Json>): TemplateFacts {
  const facts = obj(item.get("facts"));
  const text = (key: string): string | undefined => {
    const value = facts.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const options = facts.get("options");
  return {
    root: text("root"),
    state: text("state"),
    name: text("name"),
    scope: text("scope"),
    project: text("project"),
    options: options === undefined ? undefined : (options as unknown as ReadonlyMap<string, Value>),
  };
}

runFile("templating.json", (item) => {
  const expect = obj(item.get("expect"));
  const manifest = (item.get("manifest") ?? new Map()) as unknown as Document;
  const data = bytesOf(item);
  const settings = new Settings();
  try {
    const values = templateValues(manifest, factsOf(item));
    const got = item.get("kind") === "context" ? contextText(data, values, settings) : skillText(data, values, settings);
    if (expect.get("error") !== undefined) throw new Error(`got ${JSON.stringify(got)}, expected ${String(expect.get("error"))}`);
    if (got !== expect.get("text")) throw new Error(`text ${JSON.stringify(got)}, expected ${JSON.stringify(expect.get("text"))}`);
  } catch (error) {
    if (!(error instanceof AosError) || error.class !== expect.get("error")) throw error;
  }
});

const sample = fromPlain({
  options: { depth: { type: "string", default: "normal" }, token: { type: "string", sensitive: true } },
}) as Document;

test("a sensitive option stays as written with a configured value", () => {
  const values = templateValues(sample, { root: "/o/team", options: new Map([["token", "s3cret"], ["depth", "deep"]]) });
  assert.equal(values.has("token"), false);
  assert.equal(template("${token} ${depth} ${AOS_OVERLAY_ROOT}", values), "${token} deep /o/team");
});

test("a wrong typed value is refused", () => {
  assert.throws(
    () => templateValues(sample, { options: new Map([["depth", 3n]]) }),
    (error: unknown) => error instanceof AosError && error.class === "invalid-option" && error.subject === "depth",
  );
});

test("context drops front matter and a skill keeps it", () => {
  const values = templateValues(sample, { root: "/o/team", name: "team" });
  const file = new TextEncoder().encode("---\nk: ${AOS_OVERLAY_NAME}\n---\nroot ${AOS_OVERLAY_ROOT}\n");
  assert.equal(contextText(file, values, new Settings()), "root /o/team\n");
  assert.equal(skillText(file, values, new Settings()), "---\nk: ${AOS_OVERLAY_NAME}\n---\nroot /o/team\n");
});
