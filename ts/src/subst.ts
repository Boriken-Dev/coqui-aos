/** `${NAME}` substitution: the Bourne-shell parameter expansions an overlay's `dotenv` files and environment use. */
import { AosError } from "./error.ts";
import { type Settings, DEFAULT_SETTINGS, allows } from "./limits.ts";

/**
 * Looks a variable up: its value, or `undefined` when it is not set. It may throw an `AosError`
 * to refuse the read, as `secret-placeholder` does for a variable that holds a secret.
 */
export type Lookup = (name: string) => string | undefined;

type Cps = readonly number[];

const DOLLAR = 0x24;
const OPEN = 0x7b;
const CLOSE = 0x7d;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const HASH = 0x23;
const PERCENT = 0x25;
const COLON = 0x3a;

function toCps(text: string): number[] {
  const out: number[] = [];
  for (const c of text) out.push(c.codePointAt(0)!);
  return out;
}

function fromCps(cps: Cps, start = 0, end = cps.length): string {
  let out = "";
  for (let at = start; at < end; at += 8192) out += String.fromCodePoint(...cps.slice(at, Math.min(end, at + 8192)));
  return out;
}

function utf8Length(text: string): number {
  let size = 0;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code < 0x80) size += 1;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      size += 4;
      at += 1;
    } else size += 3;
  }
  return size;
}

const isAsciiAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

class Run {
  readonly lookup: Lookup;
  readonly limits: Settings;
  depth = 0;
  steps = 0;

  constructor(lookup: Lookup, limits: Settings) {
    this.lookup = lookup;
    this.limits = limits;
  }

  step(cost: number): void {
    this.steps += cost;
    if (!allows(this.limits.substitutionSteps, this.steps)) throw new AosError("too-complex", "a pattern").over("substitution_steps");
  }

  /** Refuses an output of `size` UTF-8 bytes past `substitutionBytes`. */
  fits(size: number): void {
    if (!allows(this.limits.substitutionBytes, size)) throw new AosError("too-large", "a substituted value").over("substitution_bytes");
  }
}

/** Substitutes `${...}` expressions in `text`, with the default bounds. */
export function substitute(text: string, lookup: Lookup): string {
  return substituteWith(text, lookup, DEFAULT_SETTINGS);
}

/** Substitutes `${...}` expressions in `text` within `settings`' `substitution*` bounds. A placeholder's variable or pattern is never quoted in an error. */
export function substituteWith(text: string, lookup: Lookup, settings: Settings): string {
  return substituteCps(toCps(text), new Run(lookup, settings));
}

function substituteCps(text: Cps, run: Run): string {
  if (!allows(run.limits.substitutionDepth, run.depth)) throw new AosError("too-deep", "an expression").over("substitution_depth");
  run.depth += 1;
  try {
    return substituteInner(text, run);
  } finally {
    run.depth -= 1;
  }
}

function substituteInner(text: Cps, run: Run): string {
  let out = "";
  let size = 0;
  const append = (piece: string): void => {
    out += piece;
    size += utf8Length(piece);
    run.fits(size);
  };
  let index = 0;
  while (index < text.length) {
    if (text[index] !== DOLLAR) {
      // A run of ordinary text is copied at once.
      let end = index + 1;
      while (end < text.length && text[end] !== DOLLAR) end += 1;
      append(fromCps(text, index, end));
      index = end;
      continue;
    }
    const next = text[index + 1];
    if (next === DOLLAR) {
      append("$");
      index += 2;
      continue;
    }
    if (next === OPEN) {
      const close = closingBrace(text, index + 2);
      if (close !== undefined) {
        const found = expression(text.slice(index + 2, close), run);
        if (found !== undefined) {
          append(found);
          index = close + 1;
          continue;
        }
      }
      // A `${` that is no expression is rescanned from the next character, so its scan is charged; one that is an expression is bounded by the depth limit.
      run.step(Math.max(0, (close ?? text.length) - index));
    }
    append("$");
    index += 1;
  }
  return out;
}

function closingBrace(text: Cps, from: number): number | undefined {
  let depth = 0;
  let index = from;
  while (index < text.length) {
    if (text[index] === DOLLAR && text[index + 1] === OPEN) {
      depth += 1;
      index += 2;
      continue;
    }
    if (text[index] === CLOSE) {
      if (depth === 0) return index;
      depth -= 1;
    }
    index += 1;
  }
  return undefined;
}

function nameAt(text: Cps): number {
  const first = text[0];
  if (first === undefined || !(isAsciiAlpha(first) || first === 0x5f)) return 0;
  let length = 1;
  while (length < text.length && (isAsciiAlpha(text[length]!) || isAsciiDigit(text[length]!) || text[length] === 0x5f)) length += 1;
  return length;
}

function required(name: string, run: Run): string {
  const value = run.lookup(name);
  if (value === undefined) throw new AosError("undefined-variable", name);
  return value;
}

function startsWith(text: Cps, prefix: string): boolean {
  return [...prefix].every((c, at) => text[at] === c.codePointAt(0));
}

function expression(body: Cps, run: Run): string | undefined {
  if (body[0] === HASH) {
    const length = nameAt(body.slice(1));
    if (length > 0 && length + 1 === body.length) {
      return String([...required(fromCps(body, 1), run)].length);
    }
  }
  const length = nameAt(body);
  if (length === 0) return undefined;
  const key = fromCps(body, 0, length);
  const rest = body.slice(length);
  if (rest.length === 0) return required(key, run);
  for (const operator of [":-", ":=", ":+", "-", "=", "+"]) {
    if (!startsWith(rest, operator)) continue;
    const word = rest.slice(operator.length);
    const value = run.lookup(key);
    const present = value !== undefined && !(operator.startsWith(":") && value === "");
    if (operator.endsWith("+")) return present ? substituteCps(word, run) : "";
    return present ? value : substituteCps(word, run);
  }
  const lead = rest[0]!;
  if (lead === COLON) {
    const spec = sliceSpec(rest.slice(1));
    if (spec === undefined) return undefined;
    return slice(required(key, run), spec.offset, spec.length);
  }
  if (lead === SLASH) {
    const spec = rest.slice(1);
    const first = spec[0];
    const kind = first === SLASH || first === HASH || first === PERCENT ? String.fromCodePoint(first) : undefined;
    const [pattern, replacement] = splitPattern(spec.slice(kind === undefined ? 0 : 1));
    const value = required(key, run);
    return replace(value, kind, pattern, replacement, run);
  }
  if (lead === HASH || lead === PERCENT) {
    const doubled = rest[1] === lead;
    const pattern = rest.slice(doubled ? 2 : 1);
    return trim(required(key, run), lead === HASH ? "#" : "%", doubled, pattern, run);
  }
  const operator = fromCps(rest);
  if (!["^", "^^", ",", ",,"].includes(operator)) return undefined;
  const value = required(key, run);
  if (operator === "^^") return value.toUpperCase();
  if (operator === ",,") return value.toLowerCase();
  const chars = [...value];
  const [first, ...others] = chars;
  if (first === undefined) return "";
  return (operator === "^" ? first.toUpperCase() : first.toLowerCase()) + others.join("");
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;

function number(digits: Cps, negative: boolean): number {
  let value = 0;
  for (const digit of digits) value = Math.min(Number.MAX_SAFE_INTEGER, value * 10 + (digit - 0x30));
  return negative ? -value : value;
}

function sliceSpec(text: Cps): { offset: number; length: number | undefined } | undefined {
  let at = 0;
  const skip = (): number => {
    const start = at;
    while (at < text.length && isSpace(text[at]!)) at += 1;
    return at - start;
  };
  const digits = (): Cps => {
    const start = at;
    while (at < text.length && isAsciiDigit(text[at]!)) at += 1;
    return text.slice(start, at);
  };
  const spaces = skip();
  let offset: number;
  const lead = text[at];
  if (lead === 0x28) {
    at += 1;
    skip();
    const negative = text[at] === 0x2d;
    if (negative) at += 1;
    const found = digits();
    if (found.length === 0) return undefined;
    offset = number(found, negative);
    skip();
    if (text[at] !== 0x29) return undefined;
    at += 1;
  } else if (lead !== undefined && isAsciiDigit(lead)) {
    offset = number(digits(), false);
  } else if (lead === 0x2d && spaces > 0) {
    at += 1;
    const found = digits();
    if (found.length === 0) return undefined;
    offset = number(found, true);
  } else return undefined;
  let length: number | undefined;
  if (text[at] === COLON) {
    at += 1;
    skip();
    const negative = text[at] === 0x2d;
    if (negative) at += 1;
    const found = digits();
    if (found.length === 0) return undefined;
    length = number(found, negative);
  }
  skip();
  return at === text.length ? { offset, length } : undefined;
}

function slice(value: string, givenOffset: number, length: number | undefined): string {
  const chars = toCps(value);
  const size = chars.length;
  let offset = givenOffset;
  if (offset < 0) {
    offset += size;
    if (offset < 0) return "";
  }
  const end = length === undefined ? size : length >= 0 ? offset + length : size + length;
  if (end <= offset) return "";
  const from = Math.min(offset, size);
  const to = Math.min(end, size);
  return fromCps(chars, from, Math.max(to, from));
}

function splitPattern(spec: Cps): [Cps, Cps] {
  let index = 0;
  while (index < spec.length) {
    if (spec[index] === BACKSLASH) {
      index += 2;
      continue;
    }
    if (spec[index] === SLASH) return [spec.slice(0, index), spec.slice(index + 1)];
    index += 1;
  }
  return [spec, []];
}

type Token =
  | { kind: "star" }
  | { kind: "any" }
  | { kind: "char"; code: number }
  | { kind: "class"; negate: boolean; members: ReadonlyArray<readonly [number, number]> };

function matches(token: Token, c: number): boolean {
  switch (token.kind) {
    case "star":
    case "any":
      return true;
    case "char":
      return token.code === c;
    case "class":
      return token.members.some(([low, high]) => c >= low && c <= high) !== token.negate;
  }
}

function compile(pattern: Cps): Token[] {
  const invalid = (): AosError => new AosError("invalid-pattern", "a bracket expression");
  const out: Token[] = [];
  // nextClose[i] is the first `]` at or after i, or -1.
  const nextClose = new Int32Array(pattern.length + 1).fill(-1);
  for (let at = pattern.length - 1; at >= 0; at -= 1) nextClose[at] = pattern[at] === 0x5d ? at : nextClose[at + 1]!;
  let index = 0;
  while (index < pattern.length) {
    const c = pattern[index]!;
    if (c === BACKSLASH && index + 1 < pattern.length) {
      out.push({ kind: "char", code: pattern[index + 1]! });
      index += 2;
      continue;
    }
    const found = nextClose[Math.min(index + 2, pattern.length)]!;
    const close = found === -1 ? undefined : found;
    if (c === 0x2a) out.push({ kind: "star" });
    else if (c === 0x3f) out.push({ kind: "any" });
    else if (c === 0x5b && close !== undefined) {
      const body = pattern.slice(index + 1, close);
      const negate = body[0] === 0x21 || body[0] === 0x5e;
      const items = body.slice(negate ? 1 : 0);
      if (items.length === 0) throw invalid();
      const members: Array<[number, number]> = [];
      let at = 0;
      while (at < items.length) {
        if (at + 2 < items.length && items[at + 1] === 0x2d) {
          const low = items[at]!;
          const high = items[at + 2]!;
          if (high < low) throw invalid();
          members.push([low, high]);
          at += 3;
        } else {
          members.push([items[at]!, items[at]!]);
          at += 1;
        }
      }
      out.push({ kind: "class", negate, members });
      index = close + 1;
      continue;
    } else out.push({ kind: "char", code: c });
    index += 1;
  }
  return out;
}

/** Whether `tokens` match all of `text[from, to)`; the work is charged to the run. */
function whole(tokens: readonly Token[], text: Cps, from: number, to: number, run: Run): boolean {
  let t = 0;
  let s = from;
  let star: [number, number] | undefined;
  let steps = 0;
  while (s < to) {
    steps += 1;
    const token = tokens[t];
    if (token !== undefined && token.kind === "class") steps += token.members.length;
    if (token !== undefined && token.kind !== "star" && matches(token, text[s]!)) {
      t += 1;
      s += 1;
    } else if (token !== undefined && token.kind === "star") {
      star = [t, s];
      t += 1;
    } else if (star !== undefined) {
      t = star[0] + 1;
      s = star[1] + 1;
      star = [star[0], star[1] + 1];
    } else {
      run.step(steps);
      return false;
    }
  }
  run.step(steps + 1);
  return tokens.slice(t).every((token) => token.kind === "star");
}

function ends(tokens: readonly Token[], text: Cps, start: number, run: Run): number[] {
  const found: number[] = [];
  for (let end = start; end <= text.length; end += 1) if (whole(tokens, text, start, end, run)) found.push(end);
  return found;
}

function suffixStart(tokens: readonly Token[], text: Cps, last: boolean, run: Run): number | undefined {
  let found: number | undefined;
  for (let start = 0; start <= text.length; start += 1) {
    if (whole(tokens, text, start, text.length, run)) {
      found = start;
      if (!last) break;
    }
  }
  return found;
}

function replace(value: string, kind: string | undefined, pattern: Cps, replacementCps: Cps, run: Run): string {
  if (pattern.length === 0) return value;
  const tokens = compile(pattern);
  const text = toCps(value);
  const replacement = fromCps(replacementCps);
  let out: string;
  if (kind === "#") {
    const end = ends(tokens, text, 0, run).at(-1);
    out = end === undefined ? value : replacement + fromCps(text, end);
  } else if (kind === "%") {
    const start = suffixStart(tokens, text, false, run);
    out = start === undefined ? value : fromCps(text, 0, start) + replacement;
  } else {
    out = "";
    let size = 0;
    let position = 0;
    for (;;) {
      let found: [number, number] | undefined;
      for (let start = position; start < text.length; start += 1) {
        const end = ends(tokens, text, start, run).at(-1);
        if (end !== undefined && end > start) {
          found = [start, end];
          break;
        }
      }
      if (found === undefined) break;
      const piece = fromCps(text, position, found[0]) + replacement;
      out += piece;
      size += utf8Length(piece);
      run.fits(size);
      position = found[1];
      if (kind !== "/") break;
    }
    out += fromCps(text, position);
  }
  run.fits(utf8Length(out));
  return out;
}

function trim(value: string, operator: string, longest: boolean, pattern: Cps, run: Run): string {
  const tokens = compile(pattern);
  const text = toCps(value);
  if (operator === "#") {
    const found = ends(tokens, text, 0, run);
    const end = longest ? found.at(-1) : found[0];
    return end === undefined ? value : fromCps(text, end);
  }
  // The shortest suffix starts last, the longest first.
  const start = suffixStart(tokens, text, !longest, run);
  return start === undefined ? value : fromCps(text, 0, start);
}
