import assert from "node:assert/strict";
import { effective } from "../src/apply.ts";
import { AosError } from "../src/error.ts";
import { failStep } from "../src/kinds.ts";
import { type Change, type Phase, type SetupRecord, preparation } from "../src/prepare.ts";
import { type Document, valuesEqual } from "../src/value.ts";
import { envData, factsOf, treeOf } from "./env_support.ts";
import { type Json, obj, runFile, show, str } from "./support.ts";

const mapOf = (entries: Array<[string, Json]>): Map<string, Json> => new Map(entries);

function run(item: Map<string, Json>): void {
  const manifest = obj(item.get("manifest")) as unknown as Document;
  const raw = obj(item.get("facts"));
  const facts = factsOf(raw);
  facts.tree = treeOf(raw.get("files"));
  const expect = item.get("expect");
  let got: Json;
  try {
    const result = effective(manifest, facts);
    const script = (s: { interpreter: string; path: string; args: readonly string[]; timeout: number }): Array<[string, Json]> => [
      ["interpreter", s.interpreter],
      ["path", s.path],
      ["args", [...s.args]],
      ["timeout", BigInt(s.timeout)],
    ];
    const body = mapOf([
      ["ungranted", [...result.ungranted]],
      ["supported", result.supported],
      ["env", envData(result.env)],
      ["env_scripts", result.envScripts.map((s) => mapOf(script(s)))],
      ["setup", result.setup === undefined ? null : mapOf([...script(result.setup), ["network", result.setup.network]])],
      ["python", (result.python ?? null) as unknown as Json],
      ["node", (result.node ?? null) as unknown as Json],
      [
        "dependencies",
        result.dependencies.map((d) =>
          mapOf([
            ["runtime", d.runtime],
            ["file", d.file],
            ["lock", d.lock ?? null],
            ["environment", d.environment],
          ]),
        ),
      ],
      ["needs", mapOf([["interpreters", [...result.needs.interpreters]], ["commands", [...result.needs.commands]]])],
      ["non_defaults", result.nonDefaults.map((w) => [w.id, w.subject])],
    ]);
    if (result.reports.length > 0) body.set("reports", result.reports.map((pair) => [...pair]));
    const change = raw.get("change");
    if (typeof change === "string") {
      const record = raw.get("record");
      const recorded: SetupRecord | undefined =
        record instanceof Map ? { digest: str(record.get("digest")), phase: str(record.get("phase")) as Phase } : undefined;
      const digest = raw.get("digest");
      const fails = raw.get("fails");
      const prepared = preparation(
        change as Change,
        recorded,
        typeof digest === "string" ? digest : undefined,
        result.setup,
        result.dependencies,
        typeof fails === "string" ? failStep.named(fails) : undefined,
      );
      body.set("setup_phase", prepared.phase ?? null);
      body.set("setup_arguments", prepared.arguments === undefined ? null : [...prepared.arguments]);
      body.set("steps", [...prepared.steps]);
      body.set(
        "record",
        prepared.record === undefined
          ? null
          : mapOf([
              ["digest", prepared.record.digest],
              ["phase", prepared.record.phase],
            ]),
      );
      body.set("activates", prepared.activates);
    }
    got = body;
  } catch (error) {
    if (!(error instanceof AosError)) throw error;
    got = mapOf([
      ["error", error.class],
      ["subject", error.subject],
    ]);
  }
  assert.ok(valuesEqual(got, expect), `${show(got)}\nexpected ${show(expect)}`);
}

runFile("effective.json", run);
