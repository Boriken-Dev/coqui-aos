import assert from "node:assert/strict";
import { test } from "node:test";
import { type KnowledgeOverlay, formatName, kbList, kbRead } from "../src/index.ts";
import { utf8 } from "./support.ts";

const overlay = (tree: Array<[string, string]>): KnowledgeOverlay => ({
  identity: "team",
  manifest: new Map(),
  served: false,
  facts: { root: "/o/team" },
  tree: tree.map(([path, text]) => ({ path, kind: "file", bytes: utf8(text) })),
});

const read = (one: KnowledgeOverlay, path: string, caller = {}): Record<string, unknown> => kbRead([one], { path }, { caller }).structuredContent;

test("a markdown file is expanded by default: ${NAME} outside code and @path includes", () => {
  const one = overlay([
    ["kb/a.md", "name ${AOS_OVERLAY_NAME} ${HOME} $${x}\n@part.md\n`${AOS_OVERLAY_NAME}`\n```\n@part.md ${AOS_OVERLAY_NAME}\n```\nend\n"],
    ["kb/part.md", "---\ntitle: p\n---\nPART\n"],
  ]);
  assert.equal(read(one, "kb/a.md")["text"], "name team ${HOME} ${x}\nPART\n`${AOS_OVERLAY_NAME}`\n```\n@part.md ${AOS_OVERLAY_NAME}\n```\nend");
});

test("raw is as written, and a file that is not markdown reads no first line", () => {
  const one = overlay([
    ["kb/r.md", "#!raw\n${AOS_OVERLAY_NAME} @part.md\n"],
    ["kb/part.md", "PART\n"],
    ["kb/s.sh", "#!/bin/sh\necho ${AOS_OVERLAY_NAME}\n"],
  ]);
  assert.equal(read(one, "kb/r.md")["text"], "${AOS_OVERLAY_NAME} @part.md");
  assert.equal(read(one, "kb/s.sh")["text"], "#!/bin/sh\necho ${AOS_OVERLAY_NAME}");
});

test("an engine this server lacks keeps its first line and gets the context front matter", () => {
  const one = overlay([["kb/j.md", "#!jinja\nHello {{ name }}\n"]]);
  const got = read(one, "kb/j.md", { caller: { role: "r" } });
  assert.equal(got["template"], "jinja");
  assert.equal(got["rendered"], false);
  assert.equal(got["text"], '#!jinja\n---\naos_template_context: {"engine": "jinja", "overlay": {"name": "team", "root": "/o/team"}, "caller": {"role": "r"}}\n---\nHello {{ name }}');
});

test("a cycle of includes is include-error and the file is skipped in the list", () => {
  const one = overlay([["kb/cycle.md", "@cycle.md\n"], ["kb/ok.md", "ok\n"]]);
  assert.equal((read(one, "kb/cycle.md")["error"] as { class: string }).class, "include-error");
  const listed = kbList([one]).structuredContent as { overlays: Array<{ skipped: unknown[] }>; engines: string[] };
  assert.deepEqual(listed.engines, ["envsubst", "mustache"]);
  assert.deepEqual(listed.overlays[0]!.skipped, [{ path: "kb/cycle.md", reason: "render" }]);
});

test("the format name is the last word, lower-cased, after any separator, leading dots dropped", () => {
  assert.equal(formatName(utf8("#!/usr/bin/env -S MUSTACHE\nx")), "mustache");
  assert.equal(formatName(utf8("#!.\\.Raw\n")), "raw");
  assert.equal(formatName(utf8(" #!raw\n")), null);
  assert.equal(formatName(utf8("#!dir/\n")), null);
  assert.equal(formatName(utf8("#!\n")), null);
});
