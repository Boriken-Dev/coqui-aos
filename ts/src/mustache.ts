/** The Mustache subset of the knowledge section: variables, sections, inverted sections and comments. No partial, no change of delimiters, no lambda, no escaping. */
import { DEFAULT_KNOWLEDGE_SETTINGS, KnowledgeError, type KnowledgeSettings, byteLength, within } from "./knowledge_base.ts";
import type { Document, Value } from "./value.ts";

const NAME = /^(?:\.|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
const STANDALONE = /^[ \t]*\r?\n?$/;
const MISSING = Symbol("missing");

type Item = readonly [kind: "text" | "var" | "sec" | "inv" | "end" | "comment", text: string];
type Node = readonly ["text" | "var", string] | { kind: "sec" | "inv"; name: string; children: Node[] };

const strip = (text: string): string => text.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");

function lineItems(line: string): Item[] {
  const items: Item[] = [];
  let index = 0;
  while (index < line.length) {
    const found = line.indexOf("{{", index);
    if (found < 0) {
      items.push(["text", line.slice(index)]);
      break;
    }
    if (found > index) items.push(["text", line.slice(index, found)]);
    if (line.startsWith("{{{", found)) {
      const end = line.indexOf("}}}", found + 3);
      if (end < 0) throw new KnowledgeError("template-error", "a tag is not closed");
      items.push(["var", strip(line.slice(found + 3, end))]);
      index = end + 3;
    } else {
      const end = line.indexOf("}}", found + 2);
      if (end < 0) throw new KnowledgeError("template-error", "a tag is not closed");
      const inner = strip(line.slice(found + 2, end));
      index = end + 2;
      const sigil = inner.slice(0, 1);
      if (sigil === "#" || sigil === "^" || sigil === "/" || sigil === "&") {
        const kind = { "#": "sec", "^": "inv", "/": "end", "&": "var" }[sigil] as "sec" | "inv" | "end" | "var";
        items.push([kind, strip(inner.slice(1))]);
      } else if (sigil === "!") items.push(["comment", ""]);
      else if (">{<={}$%*".includes(sigil) && sigil !== "") throw new KnowledgeError("template-error", "a tag of this kind is not defined");
      else items.push(["var", inner]);
    }
    const last = items[items.length - 1]!;
    if (last[0] !== "text" && last[0] !== "comment") {
      if (!NAME.test(last[1]) || ((last[0] === "sec" || last[0] === "inv" || last[0] === "end") && last[1] === ".")) {
        throw new KnowledgeError("template-error", "a name is not usable");
      }
    }
  }
  const tags = items.filter((item) => item[0] !== "text");
  if (tags.length === 1 && ["sec", "inv", "end", "comment"].includes(tags[0]![0])) {
    const texts = items.filter((item) => item[0] === "text");
    if (texts.every((item) => STANDALONE.test(item[1])) && STANDALONE.test(texts.map((item) => item[1]).join(""))) return tags;
  }
  return items;
}

function parse(text: string, settings: KnowledgeSettings): Node[] {
  const root: Node[] = [];
  const stack: Array<{ name: string | null; children: Node[] }> = [{ name: null, children: root }];
  for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    for (const item of lineItems(line)) {
      const top = stack[stack.length - 1]!;
      if (item[0] === "text" || item[0] === "var") top.children.push([item[0], item[1]]);
      else if (item[0] === "sec" || item[0] === "inv") {
        const node = { kind: item[0], name: item[1], children: [] as Node[] };
        top.children.push(node);
        stack.push({ name: item[1], children: node.children });
        if (settings.maxTemplateDepth !== null && stack.length > settings.maxTemplateDepth) {
          throw new KnowledgeError("template-error", "sections nest too deep");
        }
      } else if (item[0] === "end") {
        if (stack.length === 1 || top.name !== item[1]) throw new KnowledgeError("template-error", "a section is closed wrongly");
        stack.pop();
      }
    }
  }
  if (stack.length !== 1) throw new KnowledgeError("template-error", "a section is not closed");
  return root;
}

function lookup(name: string, stack: readonly unknown[]): unknown {
  if (name === ".") return stack[stack.length - 1];
  const [first, ...rest] = name.split(".") as [string, ...string[]];
  let value: unknown = MISSING;
  for (let at = stack.length - 1; at >= 0; at -= 1) {
    const context = stack[at];
    if (context instanceof Map && context.has(first)) {
      value = context.get(first);
      break;
    }
  }
  for (const key of rest) {
    if (value === MISSING) break;
    value = value instanceof Map && value.has(key) ? value.get(key) : MISSING;
  }
  return value;
}

const truthy = (value: unknown): boolean =>
  !(value === MISSING || value === null || value === undefined || value === false || (Array.isArray(value) && value.length === 0));

/**
 * `text` rendered over `data`, a mapping of the roots `overlay`, `project`, `caller`, `env`, `options` and `context` (values are text, integers as `bigint`, booleans, lists and mappings). Throws `KnowledgeError` `template-error` for what the subset refuses and `too-large` past `maxRenderedBytes`.
 */
export function mustache(text: string, data: Document, settings: KnowledgeSettings = DEFAULT_KNOWLEDGE_SETTINGS): string {
  const tree = parse(text, settings);
  const out: string[] = [];
  let size = 0;
  const emit = (piece: string): void => {
    size += byteLength(piece);
    if (!within(settings.maxRenderedBytes, size)) throw new KnowledgeError("too-large", "the rendered text");
    out.push(piece);
  };
  const walk = (nodes: readonly Node[], stack: readonly unknown[]): void => {
    for (const node of nodes) {
      if (Array.isArray(node)) {
        const [kind, body] = node as readonly ["text" | "var", string];
        if (kind === "text") emit(body);
        else {
          const value = lookup(body, stack);
          if (typeof value === "boolean") emit(value ? "true" : "false");
          else if (typeof value === "bigint" || typeof value === "string") emit(String(value));
        }
      } else {
        const section = node as { kind: "sec" | "inv"; name: string; children: Node[] };
        const value = lookup(section.name, stack);
        if (section.kind === "inv") {
          if (!truthy(value)) walk(section.children, stack);
        } else if (truthy(value)) {
          for (const item of Array.isArray(value) ? (value as Value[]) : [value]) walk(section.children, [...stack, item]);
        }
      }
    }
  };
  walk(tree, [data]);
  return out.join("");
}
