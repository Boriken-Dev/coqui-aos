import { safeSubject } from "./text.ts";

/** The classes of refusal the specification's conformance vectors name, plus this package's own. */
export const CLASSES = [
  "ambiguous",
  "case-collision",
  "cycle",
  "datetime-value",
  "dotenv-syntax",
  "duplicate-key",
  "duplicate-member",
  "env-path-conflict",
  "env-script-output",
  "hook-refused",
  "icon-dimensions",
  "icon-format",
  "icon-mismatch",
  "icon-too-large",
  "icon-unreadable",
  "integer-range",
  "invalid-digest",
  "invalid-env-file",
  "invalid-label",
  "invalid-name",
  "invalid-pattern",
  "invalid-reference",
  "invalid-requirements",
  "invalid-source",
  "invalid-unicode",
  "invalid-utf8",
  "io",
  "malformed-fence",
  "missing-file",
  "no-format-named",
  "non-finite-float",
  "non-string-key",
  "non-utf8-name",
  "not-a-catalog",
  "not-a-mapping",
  "not-a-skill",
  "not-found",
  "null-value",
  "parse-error",
  "partial-lock",
  "pin-mismatch",
  "reserved-variable",
  "secret-placeholder",
  "skill-name-mismatch",
  "skill-unreadable",
  "special-file",
  "symlink",
  "too-complex",
  "too-deep",
  "too-large",
  "two-manifests",
  "undefined-variable",
  "unresolved-reference",
  "unsupported-format",
  "unterminated-front-matter",
  "yaml-anchor",
  "yaml-directive",
  "yaml-merge-key",
  "yaml-tag",
] as const;

/** A refusal's class: the contract. Match on it, never on `subject`. */
export type ErrorClass = (typeof CLASSES)[number];

/** The class a word names, or undefined. */
export function classNamed(word: string): ErrorClass | undefined {
  return (CLASSES as readonly string[]).includes(word) ? (word as ErrorClass) : undefined;
}

/**
 * The one error: a refusal by class. `subject` names what it is about (a variable, a path, a
 * pointer) for a person, never text from a document. `line` and `column` are one-based; `column`
 * counts Unicode scalar values.
 */
export class AosError extends Error {
  readonly class: ErrorClass;
  readonly subject: string;
  #line: number | undefined;
  #column: number | undefined;
  #setting: string | undefined;

  constructor(cls: ErrorClass, subject = "") {
    const safe = safeSubject(subject);
    super(AosError.describe(cls, safe));
    this.name = "AosError";
    this.class = cls;
    this.subject = safe;
  }

  private static describe(cls: string, subject: string, line?: number, column?: number): string {
    let text = cls;
    if (subject !== "") text += `: ${subject}`;
    if (line !== undefined) {
      text += ` at line ${line}`;
      if (column !== undefined) text += ` column ${column}`;
    }
    return text;
  }

  /** The one-based line, if the error has a position. */
  get line(): number | undefined {
    return this.#line;
  }

  /** The one-based column, if the error has one. */
  get column(): number | undefined {
    return this.#column;
  }

  /**
   * For a refusal of a limit (`too-large`, `too-deep`, `too-complex`, `icon-too-large`,
   * `icon-dimensions`): the key of the setting that was passed, as a configuration writes it, such as
   * `tree_files`. Stable, unlike `subject`'s wording; undefined for any other refusal.
   */
  get setting(): string | undefined {
    return this.#setting;
  }

  /** This error naming the `setting` whose limit was passed; returns itself. */
  over(setting: string): this {
    this.#setting = setting;
    return this;
  }

  /** This error with a position; returns itself. */
  at(line: number, column: number): this {
    this.#line = line;
    this.#column = column;
    this.message = AosError.describe(this.class, this.subject, line, column);
    return this;
  }

  /** This error with a line, keeping any column; returns itself. */
  onLine(line: number): this {
    this.#line = line;
    this.message = AosError.describe(this.class, this.subject, line, this.#column);
    return this;
  }
}
