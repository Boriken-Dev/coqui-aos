import assert from "node:assert/strict";
import { composedEnvironment } from "../src/apply.ts";
import { Cycle, compose, environments } from "../src/compose.ts";
import { Environment } from "../src/environment.ts";
import { AosError } from "../src/error.ts";
import { type HookRun, hookRun } from "../src/hooks.ts";
import { OverlayTree } from "../src/tree.ts";
import { type Document, valuesEqual } from "../src/value.ts";
import { envData, factsOf, stringMap, treeOf } from "./env_support.ts";
import { type Json, decode64, obj, partsBytes, runFile, show, str, strings, utf8 } from "./support.ts";

function hookRunOf(value: Map<string, Json>): HookRun {
  let stdout: Uint8Array;
  const encoded = value.get("stdout_base64");
  const parts = value.get("stdout_parts");
  if (typeof encoded === "string") stdout = decode64(encoded);
  else if (Array.isArray(parts)) stdout = partsBytes(parts);
  else stdout = utf8(typeof value.get("stdout") === "string" ? str(value.get("stdout")) : "");
  const run = hookRun(typeof value.get("source") === "string" ? str(value.get("source")) : "", stdout);
  run.onFailure = value.get("on_failure") === "refuse" ? "refuse" : "report";
  const number = (key: string): number => {
    const found = value.get(key);
    return typeof found === "bigint" ? Number(found) : 0;
  };
  run.seconds = number("seconds");
  run.notRun = value.get("not_run") === true;
  run.payloadSize = number("payload_size");
  run.timedOut = value.get("timed_out") === true;
  run.exit = number("exit");
  run.sets = strings(value.get("sets"));
  return run;
}

const objectOrEmpty = (value: Json | undefined): Map<string, Json> => (value instanceof Map ? value : new Map());

function run(item: Map<string, Json>): void {
  const overlays = new Map<string, Document>(
    [...obj(item.get("overlays"))].map(([identity, manifest]) => [identity, obj(manifest) as unknown as Document]),
  );
  const requested = strings(item.get("requested"));
  const trees = new Map<string, OverlayTree>(
    [...objectOrEmpty(item.get("files"))].map(([identity, files]) => [identity, treeOf(files)]),
  );
  const expect = item.get("expect");
  const check = (got: Json): void => assert.ok(valuesEqual(got, expect), `${show(got)}\nexpected ${show(expect)}`);
  const pairsOf = (items: ReadonlyArray<readonly [string, string]>): Json => items.map(([a, b]) => [a, b]);
  let composition;
  try {
    composition = compose(overlays, requested, trees);
  } catch (error) {
    if (!(error instanceof Cycle)) throw error;
    check(new Map<string, Json>([["error", "cycle"], ["chain", [...error.chain]]]));
    return;
  }
  const facts = item.get("facts");
  if (!(facts instanceof Map)) {
    check(
      new Map<string, Json>([
        ["install_order", [...composition.installOrder]],
        ["active", [...composition.active]],
        ["missing", pairsOf(composition.missing)],
        ["root_variables", new Map(composition.rootVariables)],
        ["routing", [...composition.routing]],
        ["rules", pairsOf(composition.rules)],
        ["context", pairsOf(composition.context)],
        ["skills", new Map(composition.skills)],
        ["skill_collisions", [...composition.skillCollisions]],
      ]),
    );
    return;
  }
  const os = str(facts.get("os"));
  const got = new Map<string, Json>();
  let installed;
  try {
    installed = environments(overlays, composition.active, trees, os, strings(facts.get("removed")));
  } catch (error) {
    if (!(error instanceof AosError)) throw error;
    got.set("active", [...composition.active]);
    got.set("env", new Map<string, Json>([["error", error.class], ["subject", error.subject]]));
    check(got);
    return;
  }
  const active = composition.active.filter((identity) => !installed.blocked.includes(identity));
  got.set("active", active);
  const wanted = (key: string, value: Json): void => {
    if (obj(expect).has(key)) got.set(key, value);
  };
  wanted(
    "environments",
    installed.environments.map(
      (e) =>
        new Map<string, Json>([
          ["runtime", e.runtime],
          ["environment", e.environment],
          ["overlays", [...e.overlays]],
          ["files", pairsOf(e.files)],
          ["locked", e.locked],
        ]),
    ),
  );
  wanted(
    "conflicts",
    installed.conflicts.map(
      (c) =>
        new Map<string, Json>([
          ["runtime", c.runtime],
          ["environment", c.environment],
          ["package", c.package],
          ["overlays", [...c.overlays]],
        ]),
    ),
  );
  wanted("blocked", [...installed.blocked]);
  wanted(
    "left",
    installed.left.map(
      (l) =>
        new Map<string, Json>([
          ["overlay", l.overlay],
          ["runtime", l.runtime],
          ["environment", l.environment],
          ["then", l.then],
        ]),
    ),
  );
  // Packages are given per overlay: each overlay's own go in with its facts.
  const shared = factsOf(facts);
  const roots = obj(facts.get("roots"));
  const packages = objectOrEmpty(facts.get("packages"));
  const per = active.map((identity) => {
    const own = shared.with({
      identity,
      root: str(roots.get(identity)),
      tree: trees.get(identity) ?? OverlayTree.empty(),
      packages: stringMap(packages.get(identity)),
    });
    return [overlays.get(identity)!, own] as const;
  });
  const base = new Environment(stringMap(facts.get("base_env")), os === "windows");
  const preEnv = new Map<string, HookRun>(
    [...objectOrEmpty(facts.get("pre_env"))].map(([identity, r]) => [identity, hookRunOf(obj(r))]),
  );
  const composed = composedEnvironment(per, base, preEnv, []);
  got.set(
    "env",
    composed.env !== undefined
      ? envData(composed.env)
      : new Map<string, Json>([["error", composed.error!.class], ["subject", composed.error!.subject]]),
  );
  if (facts.has("pre_env")) {
    got.set(
      "hook_reports",
      composed.hookReports.map((report) => [report.id, ...report.about]),
    );
    got.set("hook_non_defaults", pairsOf(composed.hookNonDefaults));
  }
  check(got);
}

runFile("compose.json", run);
