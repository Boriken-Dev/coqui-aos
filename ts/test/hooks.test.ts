import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { compositionOrder, hookOrder, resolve } from "../src/compose.ts";
import { hookEnvironment } from "../src/apply.ts";
import { Environment } from "../src/environment.ts";
import {
  type Hook,
  type HookEvent,
  HookFailed,
  type HookScope,
  fireEvent,
  hookEvent,
  hookFacts,
  hookMatches,
  hookPayload,
  hookPlan,
  hookResult,
  hookRun,
} from "../src/hooks.ts";
import { Settings } from "../src/limits.ts";
import { OverlayTree } from "../src/tree.ts";
import { readOverlay } from "../src/overlay.ts";
import { validate } from "../src/validate.ts";
import type { Document, Value } from "../src/value.ts";
import { valuesEqual } from "../src/value.ts";
import { factsOf, stringMap } from "./env_support.ts";
import { hookRunOf, toJson, treeOf } from "./g2_support.ts";
import { type Json, num, obj, runFile, show, str, strings, utf8 } from "./support.ts";

function eventOf(item: Map<string, Json>): HookEvent {
  const name = str(item.get("event"));
  assert.ok(hookEvent.is(name), `an event: ${name}`);
  return name;
}

function settingsFrom(limits: Json | undefined): Settings {
  if (!(limits instanceof Map)) return new Settings();
  const changes: Record<string, number> = {};
  for (const [key, field] of [
    ["timeout", "hookTimeout"],
    ["event_timeout", "hookEventTimeout"],
    ["max_output", "hookOutputBytes"],
    ["max_payload", "hookPayloadBytes"],
    ["context_bytes", "contextBytes"],
  ] as const) {
    const value = num(limits.get(key));
    if (value !== undefined) changes[field] = value;
  }
  return new Settings(changes);
}

function hookJson(hook: Hook): Json {
  return toJson({
    event: hook.event,
    path: hook.path,
    interpreter: hook.interpreter,
    runs: hook.runs,
    match: hook.select,
    sets: hook.sets,
    timeout: hook.timeout,
    on_failure: hook.onFailure,
    payload: hook.payload,
  });
}

function same(got: Json, expect: Json | undefined): void {
  if (!valuesEqual(got, expect)) throw new Error(`got ${show(got)}`);
}

function eventList(facts: Map<string, Json>, key: string): HookEvent[] | undefined {
  const list = facts.get(key);
  if (list === undefined) return undefined;
  return strings(list).map((name) => {
    assert.ok(hookEvent.is(name));
    return name;
  });
}

function planCase(item: Map<string, Json>): void {
  const facts = obj(item.get("facts"));
  const tree = treeOf(facts.get("files"));
  const settings = settingsFrom(facts.get("limits"));
  const given = item.get("manifest");
  const manifest = (given instanceof Map ? given : readOverlay(tree, new Settings()).manifest) as unknown as Document;
  const scope = facts.get("scope");
  const files = facts.get("tree");
  const interpreters = facts.get("interpreters");
  const known = hookFacts(str(facts.get("os")), typeof facts.get("identity") === "string" ? str(facts.get("identity")) : "", {
    interpreters: interpreters === undefined ? undefined : strings(interpreters),
    scope: (scope === "user" || scope === "project" ? scope : "overlay") satisfies HookScope,
    digest: typeof facts.get("digest") === "string" ? str(facts.get("digest")) : undefined,
    allowed: typeof facts.get("allowed") === "string" ? str(facts.get("allowed")) : undefined,
    tree: files instanceof Map ? [...files].map(([path, text]) => [path, utf8(str(text))] as const) : undefined,
    fires: eventList(facts, "fires"),
    partial: eventList(facts, "partial") ?? [],
    timeout: num(obj(facts.get("limits") ?? new Map()).get("timeout")),
  });
  const plan = hookPlan(manifest, tree, known, settings);
  const got = new Map<string, Json>([
    ["hooks", plan.hooks.map(hookJson)],
    ["on", plan.on],
    ["activates", plan.activates],
    ["needs", plan.needs],
    ["reports", plan.reports.map((pair) => [...pair])],
    ["non_defaults", plan.nonDefaults.map((pair) => [...pair])],
  ]);
  const expect = obj(item.get("expect"));
  if (expect.has("issues")) got.set("issues", validate(manifest, tree).map((issue) => issue.at));
  same(got, expect);
}

function envJson(env: ReadonlyArray<readonly [string, string | undefined]>): Json {
  return new Map(env.map(([name, value]) => [name, value ?? null] as const));
}

function outputCase(item: Map<string, Json>): void {
  const expect = obj(item.get("expect"));
  let output;
  try {
    output = hookResult(eventOf(item), hookRunOf(item.get("run")), settingsFrom(item.get("limits")));
  } catch (error) {
    if (error instanceof HookFailed && expect.get("failed") === error.failure) return;
    throw error;
  }
  const got = new Map<string, Json>();
  if (output.decision !== undefined) got.set("decision", output.decision);
  if (output.reason !== undefined) got.set("reason", output.reason);
  if (output.context !== undefined) got.set("context", output.context);
  if (output.env !== undefined) got.set("env", envJson(output.env));
  same(new Map<string, Json>([["output", got]]), expect);
}

function eventCase(item: Map<string, Json>): void {
  const runs = (item.get("runs") as Json[]).map(hookRunOf);
  const applies = item.get("applies");
  const fired = fireEvent(
    eventOf(item),
    runs,
    applies === undefined ? undefined : strings(applies),
    settingsFrom(item.get("limits")),
    item.get("os") === "windows",
    num(item.get("context_used")) ?? 0,
  );
  same(
    new Map<string, Json>([
      ["ran", fired.ran],
      ["decision", fired.decision ?? null],
      ["by", fired.by ?? null],
      ["reason", fired.reason ?? null],
      ["context", fired.context.map((pair) => [...pair])],
      ["env", envJson(fired.env)],
      ["reports", fired.reports.map((report) => [report.id, ...report.about])],
      ["non_defaults", fired.nonDefaults.map((pair) => [...pair])],
    ]),
    item.get("expect"),
  );
}

function overlaysOf(item: Map<string, Json>): Map<string, Document> {
  return new Map([...obj(item.get("overlays"))].map(([name, manifest]) => [name, (obj(manifest) as unknown as Document)] as const));
}

function orderCase(item: Map<string, Json>): void {
  const order = hookOrder(overlaysOf(item), strings(item.get("requested")), strings(item.get("has")), strings(item.get("scopes")));
  same(new Map<string, Json>([["order", order]]), item.get("expect"));
}

function environmentCase(item: Map<string, Json>): void {
  const raw = obj(item.get("facts"));
  const overlays = overlaysOf(item);
  const names = compositionOrder(overlays, resolve(overlays, strings(item.get("requested"))).installOrder);
  const shared = factsOf(raw);
  const roots = obj(raw.get("roots"));
  const states = raw.get("states");
  const files = item.get("files");
  const active = names.map((name) => {
    const state = states instanceof Map ? states.get(name) : undefined;
    const own = files instanceof Map ? files.get(name) : undefined;
    return [
      overlays.get(name)!,
      shared.with({
        identity: name,
        root: str(roots.get(name)),
        state: typeof state === "string" ? state : undefined,
        tree: own === undefined ? OverlayTree.empty() : treeOf(own),
      }),
    ] as const;
  });
  const preEnv = new Map([...obj(raw.get("pre_env") ?? new Map())].map(([name, run]) => [name, hookRunOf(run)] as const));
  const base = new Environment([...stringMap(raw.get("base_env"))], raw.get("os") === "windows");
  const scope = item.get("scope");
  const env = hookEnvironment(
    eventOf(item),
    active,
    base,
    preEnv,
    scope === "user" || scope === "project" ? undefined : str(item.get("identity")),
  );
  same(new Map<string, Json>([["env", new Map(env.values())]]), item.get("expect"));
}

runFile("hooks.json", (item) => {
  const id = str(item.get("id"));
  if (id.startsWith("plan-")) return planCase(item);
  if (id.startsWith("payload-")) {
    return same(hookPayload(eventOf(item), obj(item.get("known")) as unknown as ReadonlyMap<string, Value>) as unknown as Json, item.get("expect"));
  }
  if (id.startsWith("output-")) return outputCase(item);
  if (id.startsWith("event-")) return eventCase(item);
  if (id.startsWith("order-")) return orderCase(item);
  if (id.startsWith("environment-")) return environmentCase(item);
  const select = item.get("match");
  const got = hookMatches(eventOf(item), Array.isArray(select) ? strings(select) : undefined, str(item.get("value")));
  same(toJson({ runs: got }), item.get("expect"));
});

const secretRun = new Map<string, Json>([["stdout", '{"context":"a secret context","env":{"TOKEN":"hunter2"}}'], ["sets", ["TOKEN"]], ["source", "h"]]);

test("a run's and an output's Debug-like forms hide the text they carry", () => {
  const run = hookRun("hook.py", utf8("a secret context"));
  assert.ok(!JSON.stringify(run).includes("secret"));
  assert.ok(!inspect(run).includes("secret"));
  run.sets = ["TOKEN"];
  const output = hookResult("session-start", hookRunOf(secretRun), new Settings());
  assert.ok(!JSON.stringify(output).includes("hunter2") && !inspect(output).includes("hunter2"));
  assert.ok(!JSON.stringify(output).includes("secret") && !inspect(output).includes("secret"));
  const fired = fireEvent("session-start", [hookRunOf(secretRun)], undefined, new Settings(), false);
  assert.equal(fired.context.length, 1);
  assert.ok(!inspect(fired).includes("hunter2") && !inspect(fired).includes("secret"));
  assert.ok(!JSON.stringify(fired).includes("hunter2"));
});

test("an output reason longer than hook_reason_chars is refused, counting characters", () => {
  const run = (reason: string) =>
    hookRunOf(new Map([["stdout", JSON.stringify({ decision: "block", reason })]]));
  assert.equal(hookResult("prompt", run("\u{1F600}\u{1F600}"), new Settings({ hookReasonChars: 2 })).reason, "\u{1F600}\u{1F600}");
  assert.throws(() => hookResult("prompt", run("abc"), new Settings({ hookReasonChars: 2 })), { failure: "output" });
});

test("a plan's hook timeout is held to the consumer's bound", () => {
  const tree = treeOf(["hook.py"]);
  const manifest = new Map([["hooks", new Map([["cd", new Map([["timeout", 500n]])]])]]) as unknown as Document;
  const plan = hookPlan(manifest, tree, hookFacts("linux", "a", { scope: "user" }), new Settings());
  assert.equal(plan.hooks.find((hook) => hook.event === "cd")?.timeout, 60);
  const lifted = hookPlan(manifest, tree, hookFacts("linux", "a", { scope: "user" }), new Settings({ hookTimeout: null }));
  assert.equal(lifted.hooks.find((hook) => hook.event === "cd")?.timeout, 500);
});
