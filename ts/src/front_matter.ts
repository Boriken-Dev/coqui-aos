/** `OVERLAY.md`: the front matter's split, its reading, and a context file's text. */
import { AosError } from "./error.ts";
import type { Format } from "./kinds.ts";
import type { Settings } from "./limits.ts";
import { chooseFormat, parsePayload } from "./read.ts";
import { startsWithBytes } from "./text.ts";
import type { Document } from "./value.ts";

const BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf] as const;
const SPACE = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;

/** How a file divides into front matter and body. */
export type SplitCase = "none" | "unterminated" | "too-large" | "empty" | "present";

/** The division of a file, by bytes and unchanged: offsets count bytes from the first byte, lines from 1. */
export interface Split {
  readonly case: SplitCase;
  readonly metadata: Uint8Array | undefined;
  readonly metadataOffset: number | undefined;
  readonly metadataLine: number | undefined;
  readonly bodyOffset: number | undefined;
  readonly bodyLine: number | undefined;
  /** The body of `data`, the same bytes this was split from; empty when there is none. */
  body(data: Uint8Array): Uint8Array;
}

function makeSplit(fields: Omit<Split, "body">): Split {
  return {
    ...fields,
    body(data: Uint8Array): Uint8Array {
      return fields.bodyOffset === undefined ? new Uint8Array(0) : data.subarray(Math.min(fields.bodyOffset, data.length));
    },
  };
}

/** The fence a line is: `---` or `...`, trailing blanks allowed, and a `\r` when the line ended. */
function fence(line: Uint8Array, ended: boolean): "---" | "..." | undefined {
  let end = line.length;
  if (ended && end > 0 && line[end - 1] === CR) end -= 1;
  while (end > 0 && (line[end - 1] === SPACE || line[end - 1] === TAB)) end -= 1;
  if (end !== 3) return undefined;
  const text = String.fromCharCode(line[0]!, line[1]!, line[2]!);
  return text === "---" || text === "..." ? text : undefined;
}

function find(data: Uint8Array, from: number, to: number): number | undefined {
  const end = Math.min(to, data.length);
  for (let at = from; at < end; at += 1) if (data[at] === LF) return at;
  return undefined;
}

/** Whether `head` could be the beginning of an opening fence. */
function mayOpen(head: Uint8Array): boolean {
  let tail = head.subarray(Math.min(3, head.length));
  if (tail.length > 0 && tail[tail.length - 1] === CR) tail = tail.subarray(0, tail.length - 1);
  const prefix = head.subarray(0, Math.min(head.length, 3));
  return prefix.every((byte) => byte === 0x2d) && tail.every((byte) => byte === SPACE || byte === TAB);
}

function trimBlank(bytes: Uint8Array): Uint8Array {
  const white = (byte: number): boolean => byte === SPACE || byte === TAB || byte === CR || byte === LF;
  let start = 0;
  while (start < bytes.length && white(bytes[start]!)) start += 1;
  let end = bytes.length;
  while (end > start && white(bytes[end - 1]!)) end -= 1;
  return bytes.subarray(start, end);
}

function blank(kind: SplitCase, start: number): Split {
  return makeSplit({
    case: kind,
    metadata: undefined,
    metadataOffset: undefined,
    metadataLine: undefined,
    bodyOffset: start,
    bodyLine: 1,
  });
}

/**
 * Splits a file into front matter and body: after one optional byte-order mark, a first line that
 * is `---`, then everything to the next `---` or `...` line. The head, through the closing fence's
 * line end, is bounded by `manifestBytes`, and nothing past it is read.
 */
export function splitFrontMatter(data: Uint8Array, settings: Settings): Split {
  const start = startsWithBytes(data, BYTE_ORDER_MARK) ? 3 : 0;
  const limit = (settings.manifestBytes ?? Number.POSITIVE_INFINITY) + start;
  const tooLarge = makeSplit({
    case: "too-large",
    metadata: undefined,
    metadataOffset: undefined,
    metadataLine: undefined,
    bodyOffset: undefined,
    bodyLine: undefined,
  });
  const end = find(data, start, limit);
  if (end === undefined && data.length > limit) {
    return mayOpen(data.subarray(start, limit)) ? tooLarge : blank("none", start);
  }
  const first = end === undefined ? data.subarray(start) : data.subarray(start, end);
  if (fence(first, end !== undefined) !== "---") return blank("none", start);
  if (end === undefined) return blank("unterminated", start);
  const metadataOffset = end + 1;
  let at = metadataOffset;
  for (;;) {
    let bodyOffset: number;
    const lf = find(data, at, limit);
    if (lf === undefined) {
      if (data.length > limit) return tooLarge;
      if (fence(data.subarray(at), false) === undefined) return blank("unterminated", start);
      bodyOffset = data.length;
    } else if (fence(data.subarray(at, lf), true) === undefined) {
      at = lf + 1;
      continue;
    } else {
      bodyOffset = lf + 1;
    }
    const metadata = data.subarray(metadataOffset, at);
    let lines = 0;
    for (let index = start; index < bodyOffset; index += 1) if (data[index] === LF) lines += 1;
    return makeSplit({
      case: trimBlank(metadata).length === 0 ? "empty" : "present",
      metadata,
      metadataOffset,
      metadataLine: 2,
      bodyOffset,
      bodyLine: 1 + lines,
    });
  }
}

/** What a viewer shows of a file's front matter. */
export type FrontMatterCase =
  | "none"
  | "malformed"
  | "unterminated"
  | "too-large"
  | "empty"
  | "unknown-format"
  | "does-not-parse"
  | "not-a-mapping"
  | "mapping";

/** A file's front matter read. `error` is what a gate refuses with; `case` is what a viewer shows. */
export interface FrontMatter {
  readonly case: FrontMatterCase;
  readonly data: Document | undefined;
  readonly error: AosError | undefined;
  readonly format: Format | undefined;
  readonly bodyOffset: number | undefined;
  readonly bodyLine: number | undefined;
}

/** Whether a file that has no front matter was meant to: a fence a character off, or one under a format line. */
function almostAFence(data: Uint8Array): boolean {
  let lead = 0;
  for (;;) {
    if (startsWithBytes(data, BYTE_ORDER_MARK, lead)) lead += 3;
    else if (lead < data.length && [SPACE, TAB, CR, LF].includes(data[lead]!)) lead += 1;
    else break;
  }
  const rest = data.subarray(lead);
  if (startsWithBytes(rest, [0x2d, 0x2d, 0x2d]) || startsWithBytes(rest, [0x2e, 0x2e, 0x2e])) return true;
  const start = startsWithBytes(data, BYTE_ORDER_MARK) ? 3 : 0;
  if (startsWithBytes(data, [0x23, 0x21], start)) {
    const end = data.indexOf(LF, start);
    if (end !== -1) {
      const after = end + 1;
      const second = data.indexOf(LF, after);
      const line = second === -1 ? data.subarray(after) : data.subarray(after, second);
      return fence(line, second !== -1) !== undefined;
    }
  }
  return false;
}

/** Splits, then reads the metadata: YAML unless a format line says otherwise. */
export function readFrontMatter(data: Uint8Array, settings: Settings): FrontMatter {
  const split = splitFrontMatter(data, settings);
  const found = (kind: FrontMatterCase, document: Document | undefined, error: AosError | undefined, format?: Format): FrontMatter => ({
    case: kind,
    data: document,
    error,
    format,
    bodyOffset: split.bodyOffset,
    bodyLine: split.bodyLine,
  });
  switch (split.case) {
    case "none":
      return almostAFence(data)
        ? found("malformed", undefined, new AosError("malformed-fence", "").onLine(1))
        : found("none", new Map(), undefined);
    case "empty":
      return found("empty", new Map(), undefined);
    case "unterminated":
      return found("unterminated", undefined, new AosError("unterminated-front-matter", "").onLine(1));
    case "too-large":
      return {
        case: "too-large",
        data: undefined,
        error: new AosError("too-large", "front matter").onLine(1),
        format: undefined,
        bodyOffset: undefined,
        bodyLine: undefined,
      };
    default:
      break;
  }
  const metadata = split.metadata ?? new Uint8Array(0);
  const firstLine = split.metadataLine ?? 2;
  let chosen: ReturnType<typeof chooseFormat>;
  try {
    chosen = chooseFormat(metadata, "yaml");
  } catch (error) {
    if (!(error instanceof AosError)) throw error;
    const kind = error.class === "unsupported-format" || error.class === "no-format-named" ? "unknown-format" : "does-not-parse";
    return found(kind, undefined, error.onLine(firstLine));
  }
  try {
    const document = parsePayload(chosen.payload, chosen.format, settings, chosen.lined);
    return found(trimBlank(chosen.payload).length === 0 ? "empty" : "mapping", document, undefined, chosen.format);
  } catch (error) {
    if (!(error instanceof AosError)) throw error;
    const kind = error.class === "not-a-mapping" ? "not-a-mapping" : "does-not-parse";
    const line = error.line === undefined ? firstLine : firstLine + error.line - 1;
    return found(kind, undefined, error.onLine(line), chosen.format);
  }
}

/** A context file's text: the body when the file has front matter, the whole file when it has none. `too-large` when the front matter is. */
export function contextFileText(data: Uint8Array, settings: Settings): Uint8Array {
  const split = splitFrontMatter(data, settings);
  if (split.case === "too-large") throw new AosError("too-large", "front matter").onLine(1);
  return split.body(data);
}
