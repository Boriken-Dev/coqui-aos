import { words } from "./kinds.ts";
import type { Value } from "./value.ts";

/** What is wrong with a manifest, by the class the specification's vectors name it. */
export const ISSUE_CODES = [
  "env-name-case-duplicate",
  "env-path-conflict",
  "integer-required",
  "invalid-source",
  "license-expression",
  "local-source",
  "manifest-file",
  "mcp-command",
  "mcp-duplicate-server",
  "mcp-duplicate-skill",
  "mcp-unknown-server",
  "mcp-url",
  "missing-file",
  "missing-skill",
  "ref-not-allowed",
  "reserved-name",
  "reserved-variable",
  "schema",
  "skill-ambiguous",
  "skill-case",
  "skill-duplicate",
  "skill-name",
  "source-credentials",
  "two-manifests",
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

/** The words of {@link IssueCode}: `issueCode.named("schema")`. */
export const issueCode = words(ISSUE_CODES);

/** One problem with a manifest: where, as a JSON pointer such as `/env/PATH`, and what. */
export interface Issue {
  readonly at: string;
  readonly code: IssueCode;
}

/** One reference token of a JSON Pointer: `~` is `~0` and `/` is `~1`. */
export function token(text: string): string {
  return text.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function join(at: string, key: string | number): string {
  return `${at}/${token(String(key))}`;
}

/** A value as text that tells an integer from a float and keeps a mapping's order. */
export function canon(value: Value | undefined): string {
  if (value === undefined) return "none";
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  if (typeof value === "bigint") return `i${value}`;
  if (typeof value === "number") return `f${value}`;
  if (typeof value === "boolean") return `b${value}`;
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  return `{${[...value].map(([key, item]) => `${JSON.stringify(key)}:${canon(item)}`).join(",")}}`;
}

/** An entry of a mapping, or undefined when `value` is no mapping. */
export function member(value: Value | undefined, key: string): Value | undefined {
  return value instanceof Map ? value.get(key) : undefined;
}

/** A mapping's entry that is text. */
export function memberText(value: Value | undefined, key: string): string | undefined {
  const found = member(value, key);
  return typeof found === "string" ? found : undefined;
}

/** The array a manifest field holds, or none. */
export function declared(manifest: Value | undefined, field: string): Value[] {
  const found = member(manifest, field);
  return Array.isArray(found) ? found : [];
}
