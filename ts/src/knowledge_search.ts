/** The rules a `kb_search` answer follows: its shape and the order of its passages. How a mode ranks is the server's own and is not checked. */
import { type CallerFacts, chooseOverlays, knowledgeArguments, knowledgeSet, type KnowledgeOverlay, servedFileText } from "./knowledge.ts";
import { DEFAULT_KNOWLEDGE_SETTINGS, KnowledgeError, type KnowledgeSettings, inert, knowledgeLines } from "./knowledge_base.ts";
import { compareText } from "./text.ts";

const isMap = (value: unknown): value is Map<string, unknown> => value instanceof Map;
const isNumber = (value: unknown): value is number | bigint => (typeof value === "number" && value === value) || typeof value === "bigint";
const sameKeys = (map: Map<string, unknown>, keys: readonly string[]): boolean => map.size === keys.length && keys.every((key) => map.has(key));

const PASSAGE = ["path", "heading", "from_line", "to_line", "score", "text"];

/** Passages by score, highest first, then path as UTF-8 bytes, then first line, then last line; ones equal in all four keep the order given. Each passage is a mapping with `path`, `from_line`, `to_line` and `score`. */
export function searchOrder<T extends ReadonlyMap<string, unknown>>(passages: readonly T[]): T[] {
  const n = (passage: T, key: string): number => Number(passage.get(key));
  return [...passages].sort(
    (a, b) => n(b, "score") - n(a, "score") || compareText(String(a.get("path")), String(b.get("path"))) || n(a, "from_line") - n(b, "from_line") || n(a, "to_line") - n(b, "to_line"),
  );
}

/** The rules a `kb_search` answer breaks, as sorted ids (`overlays`, `mode`, `top`, `path-limit`, `not-knowledge`, `range`, `text`, `inert`, `shape`); empty when it conforms. `response` and `args` are mappings, integers `bigint`s (see `fromPlain`). A passage must lie within the served text of its file as `kb_read` serves it with no `context`, for `caller` and the `engines` this server renders with. */
export function searchCheck(
  overlays: readonly KnowledgeOverlay[],
  args: unknown,
  response: unknown,
  modes: Iterable<string>,
  settings: KnowledgeSettings = DEFAULT_KNOWLEDGE_SETTINGS,
  caller: CallerFacts = {},
  engines: Iterable<string> = ["envsubst", "mustache"],
): string[] {
  const declaredModes = [...modes];
  const declaredEngines = [...engines];
  const given = knowledgeArguments("kb_search", args, declaredModes, settings);
  const broken = new Set<string>();
  if (!isMap(response) || response.size !== 1 || !response.has("results")) return ["shape"];
  const chosen = chooseOverlays(overlays, given["overlay"] as string | undefined);
  const results = response.get("results");
  if (!Array.isArray(results)) return ["shape"];
  const names = results.map((entry) => (isMap(entry) ? entry.get("overlay") : undefined));
  if (names.length !== chosen.length || names.some((name, at) => name !== chosen[at]!.identity)) broken.add("overlays");
  const prefix = given["path"] as string | undefined;
  results.slice(0, chosen.length).forEach((entry, at) => {
    const overlay = chosen[at]!;
    if (!isMap(entry)) {
      broken.add("shape");
      return;
    }
    if (entry.has("error")) {
      const error = entry.get("error");
      if (!sameKeys(entry, ["overlay", "error"]) || !isMap(error) || !sameKeys(error, ["class", "message"]) || !["unavailable", "mode-unavailable"].includes(String(error.get("class")))) {
        broken.add("shape");
      } else if (error.get("class") === "mode-unavailable" && given["mode"] === "auto") broken.add("mode");
      return;
    }
    const allowed = ["overlay", "mode", "passages", "note"];
    if (!["overlay", "mode", "passages"].every((key) => entry.has(key)) || [...entry.keys()].some((key) => !allowed.includes(key))) {
      broken.add("shape");
      return;
    }
    const mode = entry.get("mode");
    if (typeof mode !== "string" || !declaredModes.includes(mode) || (given["mode"] !== "auto" && mode !== given["mode"])) broken.add("mode");
    if (entry.has("note")) {
      const note = entry.get("note");
      if (typeof note !== "string" || note !== inert(note)) broken.add("inert");
    }
    const passages = entry.get("passages");
    if (!Array.isArray(passages)) {
      broken.add("shape");
      return;
    }
    if (passages.length > (given["top"] as number)) broken.add("top");
    const held = knowledgeSet(overlay, settings);
    for (const passage of passages) {
      if (!isMap(passage) || !sameKeys(passage, PASSAGE)) {
        broken.add("shape");
        continue;
      }
      const score = passage.get("score");
      if (!isNumber(score)) {
        broken.add("shape");
        continue;
      }
      const path = passage.get("path");
      if (typeof path !== "string") {
        broken.add("not-knowledge");
        continue;
      }
      if (prefix !== undefined && !(path === prefix || path.startsWith(`${prefix}/`))) broken.add("path-limit");
      let lines: string[];
      try {
        if (!held.files.has(path)) throw new KnowledgeError("not-found");
        lines = knowledgeLines(servedFileText(overlay, held, path, { caller, settings, engines: declaredEngines }));
      } catch (error) {
        if (!(error instanceof KnowledgeError)) throw error;
        broken.add("not-knowledge");
        continue;
      }
      const first = passage.get("from_line");
      const last = passage.get("to_line");
      if (typeof first !== "bigint" || typeof last !== "bigint" || !(first >= 1n && first <= last && last <= BigInt(lines.length))) {
        broken.add("range");
        continue;
      }
      const span = inert(lines.slice(Number(first) - 1, Number(last)).join("\n"));
      const text = passage.get("text");
      if (typeof text !== "string" || text === "" || !span.includes(text)) broken.add("text");
      for (const field of ["heading", "text"]) {
        const value = passage.get(field);
        if (typeof value !== "string" || value !== inert(value)) broken.add("inert");
      }
    }
    const keyed = passages.every(
      (p) => isMap(p) && isNumber(p.get("score")) && typeof p.get("path") === "string" && typeof p.get("from_line") === "bigint" && typeof p.get("to_line") === "bigint",
    );
    if (keyed) {
      const sorted = searchOrder(passages as Array<Map<string, unknown>>);
      if (sorted.some((p, index) => p !== passages[index])) broken.add("order");
    }
  });
  return [...broken].sort();
}
