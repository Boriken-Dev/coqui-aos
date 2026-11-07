import { AosError } from "./error.ts";

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** Bytes as text, or `invalid-utf8`. A byte-order mark is kept. */
export function decodeUtf8(bytes: Uint8Array, subject = "not UTF-8"): string {
  try {
    return strict.decode(bytes);
  } catch {
    throw new AosError("invalid-utf8", subject);
  }
}

/** Text as UTF-8 bytes. */
export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** The one-based line and column of a UTF-16 offset in `text`; a column counts Unicode scalar values. */
export function locateText(text: string, offset: number): [number, number] {
  const end = Math.min(Math.max(offset, 0), text.length);
  let line = 1;
  let start = 0;
  for (let at = text.indexOf("\n"); at !== -1 && at < end; at = text.indexOf("\n", at + 1)) {
    line += 1;
    start = at + 1;
  }
  let column = 1;
  for (const _ of text.slice(start, end)) column += 1;
  return [line, column];
}

/** Whether `bytes` start with `prefix`. */
export function startsWithBytes(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length - at < prefix.length) return false;
  return prefix.every((byte, index) => bytes[at + index] === byte);
}

/** Concatenates byte arrays. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function isWhiteSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Trims the characters `strip` accepts from both ends, in one pass over each end. */
export function trimBy(text: string, strip: (code: number) => boolean): string {
  let start = 0;
  let end = text.length;
  while (start < end && strip(text.charCodeAt(start))) start += 1;
  while (end > start && strip(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** Trims Unicode white space from both ends, as Rust's `str::trim` does (a byte-order mark is not white space). */
export function trimWhitespace(text: string): string {
  return trimBy(text, isWhiteSpace);
}

/** Trims spaces and tabs from both ends. */
export function trimBlank(text: string): string {
  return trimBy(text, (code) => code === 0x20 || code === 0x09);
}

/** Trims spaces, tabs, carriage returns and line feeds from both ends. */
export function trimAscii(text: string): string {
  return trimBy(text, (code) => code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a);
}

/** Orders text by Unicode scalar value, which is UTF-8 byte order; the order a sorted map of names keeps. */
export function compareText(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const difference = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

/** Text that holds a code unit not part of a well-formed pair. */
export function hasLoneSurrogate(text: string): boolean {
  return !text.isWellFormed();
}

const SUBJECT_CAP = 256;

function unsafeInSubject(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** Text for an error's subject: control, escape and bidirectional characters written as `\u{..}`, and a long text cut after 256 characters with an ellipsis. */
export function safeSubject(text: string): string {
  let out = "";
  let count = 0;
  for (const c of text) {
    if (count === SUBJECT_CAP) return `${out}…`;
    const code = c.codePointAt(0)!;
    out += unsafeInSubject(code) ? `\\u{${code.toString(16)}}` : c;
    count += 1;
  }
  return out;
}
