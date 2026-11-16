import assert from "node:assert/strict";
import { test } from "node:test";
import { type CallerFacts, inert, knowledgeLines, type KnowledgeEntry, type KnowledgeOverlay, KnowledgeSettings, kbList, kbRead, knowledgeArguments, knowledgeCall, knowledgePlan, knowledgeResult, knowledgeTools, readKnowledgeTree, searchCheck, searchOrder } from "../src/index.ts";
import { KnowledgeError } from "../src/knowledge_base.ts";
import type { FileSystem } from "../src/fs.ts";
import type { Document } from "../src/value.ts";
import { arr, decode64, obj, runFile, str, strings, utf8 } from "./support.ts";
import type { Json } from "./support.ts";

/** A vector's JSON as plain JavaScript: mappings as objects, integers as numbers. */
function plain(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]));
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return typeof value === "bigint" ? Number(value) : value;
}

function settingsOf(item: Map<string, Json>): KnowledgeSettings {
  const limits = item.get("limits");
  return limits instanceof Map ? KnowledgeSettings.fromData(limits) : new KnowledgeSettings();
}

const KINDS: Record<string, KnowledgeEntry["kind"]> = { file: "file", dir: "directory", symlink: "symlink", special: "other" };

function overlaysOf(item: Map<string, Json>): KnowledgeOverlay[] {
  return arr(item.get("overlays")).map((entry) => {
    const overlay = obj(entry);
    const facts = obj(overlay.get("facts"));
    const text = (key: string): string | undefined => (typeof facts.get(key) === "string" ? (facts.get(key) as string) : undefined);
    return {
      identity: str(overlay.get("identity")),
      manifest: overlay.get("manifest") as unknown as Document,
      served: overlay.get("served") === true,
      facts: { root: text("root"), state: text("state"), scope: text("scope"), project: text("project"), options: facts.get("options") as never },
      tree: arr(overlay.get("tree")).map((node) => {
        const fields = obj(node);
        const kind = KINDS[typeof fields.get("type") === "string" ? str(fields.get("type")) : "file"]!;
        const bytes = fields.has("base64") ? decode64(str(fields.get("base64"))) : fields.has("text") ? utf8(str(fields.get("text"))) : undefined;
        return { path: str(fields.get("path")), kind, bytes: kind === "file" ? bytes : undefined };
      }),
    };
  });
}

function callerOf(item: Map<string, Json>): CallerFacts {
  const facts = item.get("facts");
  if (!(facts instanceof Map)) return {};
  const caller = facts.get("caller");
  const role = caller instanceof Map ? caller.get("role") : undefined;
  const profile = caller instanceof Map ? caller.get("profile") : undefined;
  return {
    caller: { role: typeof role === "string" ? role : undefined, profile: typeof profile === "string" ? profile : undefined },
    env: facts.get("env") instanceof Map ? (facts.get("env") as Map<string, string>) : undefined,
    envAllow: strings(facts.get("env_allow")),
  };
}

runFile("knowledge.json", (item) => {
  const id = str(item.get("id"));
  const settings = settingsOf(item);
  const modes = strings(item.get("modes"));
  let got: unknown;
  if (id.startsWith("tools-")) got = { tools: knowledgeTools(modes, settings) };
  else if (item.get("kind") === "arguments") {
    try {
      got = { arguments: knowledgeArguments(str(item.get("tool")), item.get("arguments"), modes, settings) };
    } catch (error) {
      if (!(error instanceof KnowledgeError)) throw error;
      got = { error: error.class };
    }
  } else if (item.has("outcome")) {
    const sent = knowledgeResult(plain(item.get("outcome")) as never);
    assert.deepEqual(JSON.parse(sent.content[0]!.text), sent.structuredContent);
    got = { structuredContent: sent.structuredContent, isError: sent.isError };
  } else if (item.has("manifest") && item.has("files")) {
    const user = item.get("user");
    const plan = knowledgePlan(item.get("manifest") as unknown as Document, item.get("files") as Map<string, string>, typeof user === "boolean" ? user : undefined);
    got = { served: plan.served, left_out: plan.leftOut };
  } else {
    const out = knowledgeCall(str(item.get("tool")), overlaysOf(item), item.get("arguments"), modes, settings, callerOf(item));
    got = "error" in out ? { error: out.error.class } : { result: out.result };
  }
  assert.deepEqual(plain(got), plain(item.get("expect")));
});

runFile("knowledge_search.json", (item) => {
  const id = str(item.get("id"));
  let got: unknown;
  if (id.startsWith("order-")) {
    got = { order: searchOrder(arr(item.get("passages")) as Array<Map<string, unknown>>) };
  } else {
    got = { violations: searchCheck(overlaysOf(item), item.get("arguments"), item.get("response"), strings(item.get("modes")), settingsOf(item)) };
  }
  assert.deepEqual(plain(got), plain(item.get("expect")));
});

const overlay = (tree: Array<[string, string]>, manifest: Document = new Map()): KnowledgeOverlay => ({
  identity: "team",
  manifest,
  served: false,
  facts: { root: "/o/team" },
  tree: tree.map(([path, text]) => ({ path, kind: "file", bytes: utf8(text) })),
});

test("kbRead renders a template per call from the caller facts and the context", () => {
  const one = overlay([["kb/t.md", "---\ntemplate: mustache\n---\n{{caller.role}} {{context.topic}} {{env.USER}} {{#context.deep}}deep{{/context.deep}}\n"]]);
  const sent = kbRead([one], { path: "kb/t.md", context: { topic: "cache", deep: true } }, { caller: { caller: { role: "reviewer" }, env: { USER: "ana", HOME: "x" }, envAllow: ["USER", "HOME"] } });
  assert.equal(sent.isError, false);
  assert.equal(sent.structuredContent["text"], "reviewer cache ana deep");
  assert.equal(sent.structuredContent["template"], "mustache");
  assert.deepEqual(JSON.parse(sent.content[0]!.text), sent.structuredContent);
});

test("kbRead takes a line range and refuses what the tool refuses", () => {
  const one = overlay([["kb/a.md", "1\n2\n3\n"]]);
  assert.equal(kbRead([one], { path: "kb/a.md", from: 2, to: 3 }).structuredContent["text"], "2\n3");
  const bad = kbRead([one], { path: "../x" });
  assert.equal(bad.isError, true);
  assert.deepEqual(Object.keys(bad.structuredContent), ["error"]);
  assert.equal(kbRead([one], { path: "kb/a.md", from: 1.5 }).isError, true);
  assert.equal(kbRead([one], { path: "kb/a.md", context: { n: null } }).isError, true);
});

test("kbList lists the files and declares the modes it is given", () => {
  const sent = kbList([overlay([["kb/a.md", "x\n"]])], { modes: ["meaning", "words"] });
  assert.deepEqual(sent.structuredContent["search"], { modes: ["words", "meaning"] });
});

test("a tree is read through the filesystem without following a link", async () => {
  const files = new Map<string, { kind: "file" | "directory" | "symlink"; data?: string }>([
    ["/o", { kind: "directory" }],
    ["/o/kb", { kind: "directory" }],
    ["/o/kb/a.md", { kind: "file", data: "hello\n" }],
    ["/o/kb/link", { kind: "symlink" }],
    ["/o/.git", { kind: "directory" }],
  ]);
  const fs: FileSystem = {
    metadata: (path) => ({ kind: files.get(path)!.kind, len: files.get(path)!.data?.length ?? 0 }),
    read: (path) => utf8(files.get(path)!.data ?? ""),
    list: (path) => [...files.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")).map((key) => key.slice(path.length + 1)),
  };
  const tree = await readKnowledgeTree(fs, "/o");
  assert.deepEqual(tree.map((entry) => [entry.path, entry.kind]), [["kb", "directory"], ["kb/a.md", "file"], ["kb/link", "symlink"]]);
  const one: KnowledgeOverlay = { identity: "o", manifest: new Map(), served: false, facts: {}, tree };
  assert.equal(kbRead([one], { path: "kb/link" }).structuredContent["error"] !== undefined, true);
  assert.equal(kbRead([one], { path: "kb/a.md" }).structuredContent["text"], "hello");
});

test("settings carry a default, no floor and a report", () => {
  assert.equal(new KnowledgeSettings().maxReadBytes, 65536);
  assert.deepEqual(new KnowledgeSettings({ maxTop: null }).nonDefaults(), [{ setting: "max_top", value: "none", default: "100" }]);
  assert.throws(() => new KnowledgeSettings({ maxTop: -1 }), RangeError);
});

test("text is written out per the specification's set, U+2061 to U+2064 included", () => {
  assert.equal(inert("a\u2061b\u2064c\u2060d\r"), "a<U+2061>b<U+2064>c<U+2060>d<U+000D>");
  assert.equal(inert("tab\there\nline"), "tab\there\nline");
});

test("a carriage return is dropped only before a line feed, and an empty file has no line", () => {
  assert.deepEqual(knowledgeLines("a\r\nb\rc\r\nlast\r"), ["a", "b\rc", "last\r"]);
  assert.deepEqual(knowledgeLines(""), []);
  assert.deepEqual(knowledgeLines("x\n"), ["x"]);
});

test("a search entry's path limit and order follow the specification", () => {
  const passages = [new Map<string, unknown>([["path", "b"], ["from_line", 1n], ["to_line", 1n], ["score", 2]]), new Map<string, unknown>([["path", "\u{10000}"], ["from_line", 1n], ["to_line", 1n], ["score", 2]]), new Map<string, unknown>([["path", "\uffff"], ["from_line", 1n], ["to_line", 1n], ["score", 2]])];
  assert.deepEqual(searchOrder(passages).map((p) => p.get("path")), ["b", "\uffff", "\u{10000}"]);
});
