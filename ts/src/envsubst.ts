/**
 * The `envsubst` renderer of the knowledge section, behind one function so another implementation can replace it.
 *
 * It is a small one of this package's own, limited to what the section defines: GNU gettext's `envsubst` at its defaults
 * (`$NAME` and `${NAME}`, no operators, no `$$`), the `escape` and `default` features of the a8m and drone dialects, the
 * three patterns and the three modes for a name with no value. No stock npm package follows GNU's rules (the ones that
 * exist replace `${NAME:-x}` and `$$` their own way, or read a file or the process environment), so none was adopted.
 */
import { KnowledgeError } from "./knowledge_base.ts";

/** What a name with no value is by default: the reference as it was written. One place, so the default can change in step with the specification. */
export const DEFAULT_UNDEFINED: Undefined = "debug";

/** Which references are read. */
export type Pattern = "braced" | "unbraced" | "all";
/** What a name with no value is: nothing, an error, or the reference as it was written. */
export type Undefined = "lenient" | "strict" | "debug";

/** The behaviour of one dialect: the pattern it reads and the features it has. */
export const DIALECTS: Readonly<Record<string, { readonly pattern: Pattern; readonly features: ReadonlySet<string> }>> = {
  gnu: { pattern: "all", features: new Set() },
  a8m: { pattern: "all", features: new Set(["escape", "default"]) },
  drone: { pattern: "braced", features: new Set(["escape", "default"]) },
};

/** Every feature a line may name. */
export const SHELL_FEATURES: readonly string[] = ["escape", "default", "assign", "alternate", "nested", "unquote", "slice", "replace", "trim", "case", "length"];

/** The features this renderer implements; a file asking for others is served as a file for an engine the server lacks. */
export const IMPLEMENTED_FEATURES: ReadonlySet<string> = new Set(["escape", "default"]);

/** What the options of an `envsubst` line ask for. */
export interface EnvsubstOptions {
  readonly pattern: Pattern;
  readonly features: ReadonlySet<string>;
  readonly undefined: Undefined;
}

/** The pattern, features and undefined mode a line's options ask for. Throws `template-error` for a value an option does not have; an option no edition defines is ignored. */
export function envsubstOptions(options: Readonly<Record<string, string>>): EnvsubstOptions {
  const dialect = options["dialect"] ?? "gnu";
  const known = Object.hasOwn(DIALECTS, dialect) ? DIALECTS[dialect] : undefined;
  if (known === undefined) throw new KnowledgeError("template-error", "dialect is gnu, a8m or drone");
  let pattern: Pattern = known.pattern;
  let features: ReadonlySet<string> = known.features;
  const asked = options["pattern"];
  if (asked !== undefined) {
    if (asked !== "braced" && asked !== "unbraced" && asked !== "all") throw new KnowledgeError("template-error", "pattern is braced, unbraced or all");
    pattern = asked;
  }
  if (options["features"] !== undefined) {
    const list = options["features"].split(",");
    if (!list.every((name) => SHELL_FEATURES.includes(name))) throw new KnowledgeError("template-error", "a feature that is not defined");
    features = new Set(list);
  }
  const mode = options["undefined"] ?? DEFAULT_UNDEFINED;
  if (mode !== "strict" && mode !== "lenient" && mode !== "debug") throw new KnowledgeError("template-error", "undefined is strict, lenient or debug");
  return { pattern, features, undefined: mode };
}

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;

function nameAt(text: string, at: number): string | undefined {
  NAME.lastIndex = at;
  return NAME.exec(text)?.[0];
}

/**
 * `text` with each reference replaced by the value of its name in `values`. A name with no value follows `undefined`
 * (`strict` throws `template-error`, `debug` keeps the reference as written, `lenient` makes it nothing); with the
 * `escape` feature `$$` is `$`, with `default` `${NAME:-word}` and `${NAME-word}` give the word where the name has no
 * value (`:-` also where it is empty). Anything else is text.
 */
export function envsubst(
  text: string,
  values: ReadonlyMap<string, string>,
  pattern: Pattern = "all",
  features: ReadonlySet<string> = new Set(),
  undefinedMode: Undefined = DEFAULT_UNDEFINED,
): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "$") {
      out += text[i]!;
      i += 1;
      continue;
    }
    if (features.has("escape") && text.startsWith("$$", i)) {
      out += "$";
      i += 2;
      continue;
    }
    let found: { name: string; word: { colon: boolean; text: string } | null; end: number } | undefined;
    if ((pattern === "braced" || pattern === "all") && text.startsWith("${", i)) {
      const name = nameAt(text, i + 2);
      if (name !== undefined) {
        const j = i + 2 + name.length;
        if (text.startsWith("}", j)) found = { name, word: null, end: j + 1 };
        else if (features.has("default") && (text.startsWith(":-", j) || text.startsWith("-", j))) {
          const colon = text.startsWith(":-", j);
          const close = text.indexOf("}", j);
          if (close >= 0) found = { name, word: { colon, text: text.slice(j + (colon ? 2 : 1), close) }, end: close + 1 };
        }
      }
    }
    if (found === undefined && (pattern === "unbraced" || pattern === "all")) {
      const name = nameAt(text, i + 1);
      if (name !== undefined) found = { name, word: null, end: i + 1 + name.length };
    }
    if (found === undefined) {
      out += "$";
      i += 1;
      continue;
    }
    const value = values.get(found.name);
    if (found.word !== null && (value === undefined || (found.word.colon && value === ""))) out += found.word.text;
    else if (value !== undefined) out += value;
    else if (undefinedMode === "strict") throw new KnowledgeError("template-error", `a name has no value: ${found.name}`);
    else if (undefinedMode === "debug") out += text.slice(i, found.end);
    i = found.end;
  }
  return out;
}
