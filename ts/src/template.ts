/** Templating (`spec/v0/harness.md#templating`): `${NAME}` in the context a consumer assembles and in the body of a bundled skill it serves. Only the names listed, the overlay's non-sensitive options among them, are replaced; every other text is itself. Nothing runs, no file is read, and an installed file is never changed. */
import { AosError } from "./error.ts";
import { contextFileText, splitFrontMatter } from "./front_matter.ts";
import type { Settings } from "./limits.ts";
import { isVariableName } from "./names.ts";
import { decodeUtf8 } from "./text.ts";
import type { Document, Value } from "./value.ts";

/** What a consumer knows about the overlay a text is read for. A name with no value is left as written in the text. */
export interface TemplateFacts {
  /** `AOS_OVERLAY_ROOT`: the absolute root the consumer exposes, as it holds it. */
  readonly root?: string | undefined;
  /** `AOS_OVERLAY_STATE`: the overlay's state directory, when it has one. */
  readonly state?: string | undefined;
  /** `AOS_OVERLAY_NAME`: the overlay's normalized identity. */
  readonly name?: string | undefined;
  /** `AOS_OVERLAY_SCOPE`: the label the consumer gives the scope the overlay is active in. */
  readonly scope?: string | undefined;
  /** `AOS_PROJECT_ROOT`: the absolute root of the project the session works in. */
  readonly project?: string | undefined;
  /** The values the user configured for the overlay's options, by name: a string, a `bigint` or a boolean. A name the overlay does not declare is ignored. */
  readonly options?: ReadonlyMap<string, Value> | undefined;
}

function optionText(kind: Value | undefined, name: string, value: Value): string {
  if (kind === "string" && typeof value === "string") return value;
  if (kind === "integer" && typeof value === "bigint") return value.toString();
  if (kind === "boolean" && typeof value === "boolean") return value ? "true" : "false";
  throw new AosError("invalid-option", name);
}

/**
 * The names that are replaced and their text, to give to `template`, `contextText` and `skillText`. A name with no value is not in it, and a sensitive option never is. An option's value is the configured one, else its default, else none.
 * Throws `invalid-option`, the option's name its subject, when a configured value or a default is not of the declared type: it is never converted.
 */
export function templateValues(manifest: Document, facts: TemplateFacts): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const known: Array<readonly [string, string | undefined]> = [
    ["AOS_OVERLAY_ROOT", facts.root],
    ["AOS_OVERLAY_STATE", facts.state],
    ["AOS_OVERLAY_NAME", facts.name],
    ["AOS_OVERLAY_SCOPE", facts.scope],
    ["AOS_PROJECT_ROOT", facts.project],
  ];
  for (const [name, value] of known) if (value !== undefined) values.set(name, value);
  const options = manifest.get("options");
  if (options instanceof Map) {
    for (const [name, declared] of options) {
      if (!(declared instanceof Map) || declared.get("sensitive") === true || !isVariableName(name)) continue;
      const value = facts.options?.get(name) ?? declared.get("default");
      if (value !== undefined) values.set(name, optionText(declared.get("type"), name, value));
    }
  }
  return values;
}

/** `text` with each `${NAME}` whose name `values` holds replaced, read from left to right: `$${` is `${`, and every other text is itself (an unknown name, an operator, `$NAME`, `$(...)`, a lone `$$`). A value is inserted as it is and never read again. */
export function template(text: string, values: ReadonlyMap<string, string>): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    if (text.startsWith("$${", at)) {
      out += "${";
      at += 3;
      continue;
    }
    if (text.startsWith("${", at)) {
      const end = text.indexOf("}", at + 2);
      const value = end === -1 ? undefined : values.get(text.slice(at + 2, end));
      if (value !== undefined) {
        out += value;
        at = end + 1;
        continue;
      }
    }
    const dollar = text.indexOf("$", at + 1);
    const stop = dollar === -1 ? text.length : dollar;
    out += text.slice(at, stop);
    at = stop;
  }
  return out;
}

/** A context file as the agent receives it: a closed front matter block dropped, the rest templated. Throws `too-large` for a head past `manifest_bytes` and `invalid-utf8`. */
export function contextText(data: Uint8Array, values: ReadonlyMap<string, string>, settings: Settings): string {
  return template(decodeUtf8(contextFileText(data, settings)), values);
}

/** A bundled skill's `SKILL.md` as served: the front matter exactly as written, the body templated. Throws as `contextText` does. */
export function skillText(data: Uint8Array, values: ReadonlyMap<string, string>, settings: Settings): string {
  const split = splitFrontMatter(data, settings);
  if (split.case === "too-large") throw new AosError("too-large", "front matter").over("manifest_bytes").onLine(1);
  const offset = split.bodyOffset ?? 0;
  return decodeUtf8(data.subarray(0, offset)) + template(decodeUtf8(data.subarray(offset)), values);
}
