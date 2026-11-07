/** Sources: where a skill or an overlay comes from, `[git+]<location>[@<ref>][#<path>]`. */
import { AosError } from "./error.ts";
import { asciiLower, validRelativePath } from "./names.ts";
import { trimWhitespace } from "./text.ts";

/** What a source's location is. */
export type SourceKind = "directory" | "git" | "url";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** A parsed source. Its text form hides user information and query, so `toString()` and inspection are safe to log. */
export class Source {
  readonly kind: SourceKind;
  readonly location: string;
  readonly reference: string | undefined;
  readonly path: string | undefined;

  constructor(kind: SourceKind, location: string, reference: string | undefined, path: string | undefined) {
    this.kind = kind;
    this.location = location;
    this.reference = reference;
    this.path = path;
    Object.freeze(this);
  }

  /** Parses `[git+]<location>[@<ref>][#<path>]`, or `invalid-source`. */
  static parse(text: string): Source {
    return parseSource(text);
  }

  /** The same source with another ref. */
  withReference(reference: string | undefined): Source {
    return new Source(this.kind, this.location, reference, this.path);
  }

  /** The source as text for a person: no user information and no query. */
  shown(): string {
    return this.shownWith(this.reference);
  }

  /** {@link shown}, with `reference` in place of the source's own. */
  shownWith(reference: string | undefined): string {
    let location = this.location;
    const parts = authorityOf(this.location);
    if (parts !== undefined) {
      const at = parts.authority.lastIndexOf("@");
      const host = at === -1 ? parts.authority : parts.authority.slice(at + 1);
      const rest = parts.rest.split("?")[0] ?? "";
      location = `${parts.scheme}://${host}${rest}`;
    }
    let shown = location;
    if (reference !== undefined && reference !== "") shown += `@${reference}`;
    if (this.path !== undefined) shown += `#${this.path}`;
    return shown;
  }

  /** What identifies the source, credentials and all: `location[@ref][#path]`. Never show it. */
  keyWith(reference: string | undefined): string {
    let key = this.location;
    const chosen = reference ?? this.reference;
    if (chosen !== undefined && chosen !== "") key += `@${chosen}`;
    if (this.path !== undefined) key += `#${this.path}`;
    return key;
  }

  /** Whether the source is on this machine or its network edge: a directory, `file:`, loopback or link-local. */
  isLocal(): boolean {
    const location = this.location;
    if (asciiLower(location).startsWith("file:") || this.kind === "directory") return true;
    if (this.kind === "git" && localGit(location)) return true;
    return hostIsLocal(sourceHost(location));
  }

  /** Whether the location holds a password, a token, or a query. */
  holdsCredentials(): boolean {
    const parts = authorityOf(this.location);
    if (parts === undefined) return false;
    const at = parts.authority.lastIndexOf("@");
    const user = at === -1 ? "" : parts.authority.slice(0, at);
    const scheme = asciiLower(parts.scheme);
    return parts.rest.includes("?") || user.includes(":") || (user !== "" && (scheme === "http" || scheme === "https"));
  }

  /** Whether the location is an `http://` or `https://` URL. */
  isWebUrl(): boolean {
    const lower = asciiLower(this.location);
    return lower.startsWith("http://") || lower.startsWith("https://");
  }

  toString(): string {
    return this.shown();
  }

  toJSON(): { kind: SourceKind; shown: string } {
    return { kind: this.kind, shown: this.shown() };
  }

  [INSPECT](): string {
    return `Source { kind: ${this.kind}, shown: ${JSON.stringify(this.shown())} }`;
  }
}

function isGitLocation(location: string): boolean {
  return location.endsWith(".git") || ["git@", "ssh://", "git://"].some((prefix) => location.startsWith(prefix));
}

function isSourceControl(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function hasDrive(location: string): boolean {
  return /^[A-Za-z]:/.test(location);
}

function authorityOf(location: string): { scheme: string; authority: string; rest: string } | undefined {
  const at = location.indexOf("://");
  if (at === -1) return undefined;
  const scheme = location.slice(0, at);
  const rest = location.slice(at + 3);
  const cut = rest.search(/[/?]/);
  const end = cut === -1 ? rest.length : cut;
  return { scheme, authority: rest.slice(0, end), rest: rest.slice(end) };
}

function hostAndPath(location: string): { host: string; rest: string } | undefined {
  if (hasDrive(location)) return undefined;
  const at = location.indexOf(":");
  if (at === -1) return undefined;
  const host = location.slice(0, at);
  if (host === "" || /[/\\]/.test(host)) return undefined;
  return { host, rest: location.slice(at + 1) };
}

/** Whether `text`, with its `%XX` escapes decoded, starts with `-`. */
function decodedStartsWithDash(text: string): boolean {
  const first = text.slice(0, 3);
  if (/^%2[dD]/.test(first)) return true;
  return text.startsWith("-");
}

function splitLast(text: string, separator: string): [string, string] | undefined {
  const at = text.lastIndexOf(separator);
  return at === -1 ? undefined : [text.slice(0, at), text.slice(at + separator.length)];
}

function parseSource(text: string): Source {
  const refuse = (why: string): AosError => new AosError("invalid-source", why);
  let raw = trimWhitespace(text);
  if (raw === "") throw refuse("empty");
  for (const c of raw) if (isSourceControl(c.codePointAt(0)!)) throw refuse("control character");
  const explicitGit = raw.startsWith("git+");
  if (explicitGit) raw = raw.slice("git+".length);
  let body = raw;
  let path: string | undefined;
  const hash = raw.indexOf("#");
  if (hash !== -1) {
    body = raw.slice(0, hash);
    const trimmed = trimWhitespace(raw.slice(hash + 1)).replace(/^\/+|\/+$/g, "");
    path = trimmed === "" ? undefined : trimmed;
  }
  let location = trimWhitespace(body);
  let reference: string | undefined;
  const split = splitLast(location, "@");
  if (split !== undefined) {
    const [head, tail] = split;
    const authority = authorityOf(location);
    const afterAuthority = authority === undefined ? location.length : location.length - authority.rest.length;
    const inAuthority = location.includes("://") && head.length < afterAuthority;
    if (
      head !== "" &&
      tail !== "" &&
      !inAuthority &&
      !/[/:\\]/.test(tail) &&
      !head.endsWith("://") &&
      !head.endsWith(":") &&
      (explicitGit || isGitLocation(head))
    ) {
      location = head;
      reference = tail;
    }
  }
  if (path !== undefined && !validRelativePath(path)) throw refuse("the #path is not a relative path");
  let parts: string[] = [];
  const authority = authorityOf(location);
  if (authority !== undefined) {
    if (authority.authority.includes("\\")) throw refuse("backslash in the authority");
    const user = splitLast(authority.authority, "@");
    const hostport = user === undefined ? authority.authority : user[1];
    let host = hostport;
    let port = "";
    if (!hostport.endsWith("]")) {
      const pair = splitLast(hostport, ":");
      if (pair !== undefined) [host, port] = pair;
    }
    parts = [user === undefined ? "" : user[0], host, port];
  } else {
    const found = hostAndPath(location);
    if (found !== undefined) {
      const user = splitLast(found.host, "@");
      parts = [user === undefined ? "" : user[0], user === undefined ? found.host : user[1], found.rest];
    }
  }
  if (parts.some(decodedStartsWithDash)) throw refuse("a user, host or port that reads as an option");
  if (explicitGit || isGitLocation(location)) {
    if (location.startsWith("-") || (reference !== undefined && reference.startsWith("-"))) {
      throw refuse("a location or ref that reads as an option");
    }
    if (location.includes("::")) throw refuse("a Git remote helper");
    const scheme = location.indexOf("://");
    if (scheme !== -1 && !["https", "http", "ssh", "git", "file"].includes(asciiLower(location.slice(0, scheme)))) {
      throw refuse("a scheme Git is not given");
    }
    return new Source("git", location, reference, path);
  }
  return new Source(location.includes("://") ? "url" : "directory", location, undefined, path);
}

function localGit(location: string): boolean {
  const scheme = location.indexOf("://");
  if (scheme !== -1) return asciiLower(location.slice(0, scheme)) === "file";
  return hasDrive(location) || hostAndPath(location) === undefined;
}

/** The host of a source's location, lowercased: a URL's, or an scp-like `host:path`'s. */
export function sourceHost(location: string): string | undefined {
  const parts = authorityOf(location);
  let hostport: string;
  if (parts !== undefined) {
    const at = parts.authority.lastIndexOf("@");
    hostport = at === -1 ? parts.authority : parts.authority.slice(at + 1);
  } else {
    const found = hostAndPath(location);
    if (found === undefined) return undefined;
    const at = found.host.lastIndexOf("@");
    const host = at === -1 ? found.host : found.host.slice(at + 1);
    return host === "" ? undefined : asciiLower(host);
  }
  if (hostport.startsWith("[")) return asciiLower(hostport.slice(1).split("]")[0] ?? "");
  const pair = splitLast(hostport, ":");
  return asciiLower(pair === undefined ? hostport : pair[0]);
}

/** An IPv4 address as four octets: dotted decimal, no leading zeros. */
export function parseIpv4(text: string): [number, number, number, number] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  return octets as [number, number, number, number];
}

/** An IPv6 address as eight 16-bit groups, with `::` and a trailing IPv4 part allowed. */
export function parseIpv6(text: string): number[] | undefined {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(":")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (half: string): number[] | undefined => {
    if (half === "") return [];
    const out: number[] = [];
    const items = half.split(":");
    for (const [index, item] of items.entries()) {
      if (item.includes(".")) {
        const v4 = parseIpv4(item);
        if (v4 === undefined || index !== items.length - 1) return undefined;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(item)) return undefined;
        out.push(Number.parseInt(item, 16));
      }
    }
    return out;
  };
  const head = groups(halves[0] ?? "");
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = groups(halves[1] ?? "");
  if (tail === undefined || head.length + tail.length > 7) return undefined;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

type Address = { v4: [number, number, number, number] } | { v6: number[] };

/** One part of a shorthand IPv4 host: `0x` hexadecimal, a leading 0 octal, else decimal. */
function ipv4Part(part: string): number | undefined {
  let digits = part;
  let radix = 10;
  if (/^0[xX]/.test(part)) {
    digits = part.slice(2);
    radix = 16;
  } else if (part.length > 1 && part.startsWith("0")) {
    digits = part.slice(1);
    radix = 8;
  }
  const allowed = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!allowed.test(digits)) return undefined;
  return Number.parseInt(digits, radix);
}

/** An IPv4 host the way a URL parser reads it: one to four parts, the last filling the remaining bytes, so `127.1` and `2130706433` are loopback. */
function parseIpv4Shorthand(host: string): [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length > 4) return undefined;
  const numbers = parts.map(ipv4Part);
  if (numbers.some((number) => number === undefined)) return undefined;
  const values = numbers as number[];
  const last = values[values.length - 1]!;
  if (values.slice(0, -1).some((value) => value > 255) || last >= 256 ** (5 - values.length)) return undefined;
  let address = last;
  values.slice(0, -1).forEach((value, at) => {
    address += value * 256 ** (3 - at);
  });
  return [Math.floor(address / 2 ** 24) % 256, Math.floor(address / 2 ** 16) % 256, Math.floor(address / 256) % 256, address % 256];
}

function parseAddress(host: string): Address | undefined {
  const v4 = parseIpv4Shorthand(host);
  if (v4 !== undefined) return { v4 };
  const v6 = parseIpv6(host);
  return v6 === undefined ? undefined : { v6 };
}

function mappedV4(groups: number[]): [number, number, number, number] | undefined {
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff];
  }
  return undefined;
}

const localV4 = ([a, b, c, d]: [number, number, number, number]): boolean =>
  a === 127 || (a === 169 && b === 254) || (a === 0 && b === 0 && c === 0 && d === 0);

/** Whether a host is this machine: `localhost`, loopback, link-local or unspecified. */
export function hostIsLocal(host: string | undefined): boolean {
  if (host === undefined) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const address = parseAddress(host);
  if (address === undefined) return false;
  if ("v4" in address) return localV4(address.v4);
  const mapped = mappedV4(address.v6);
  if (mapped !== undefined) return localV4(mapped);
  const g = address.v6;
  const loopback = g.slice(0, 7).every((group) => group === 0) && g[7] === 1;
  const unspecified = g.every((group) => group === 0);
  return loopback || unspecified || (g[0]! & 0xffc0) === 0xfe80;
}

/** Whether a host is on a private or reserved network, which is not this machine. */
export function hostIsPrivate(host: string | undefined): boolean {
  if (host === undefined || hostIsLocal(host)) return false;
  const v4 = ([a, b, c]: [number, number, number, number]): boolean =>
    a === 0 ||
    a === 10 ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 240;
  const address = parseAddress(host);
  if (address === undefined) return false;
  if ("v4" in address) return v4(address.v4);
  const mapped = mappedV4(address.v6);
  if (mapped !== undefined) return v4(mapped);
  const s = address.v6;
  return (
    (s[0]! & 0xfe00) === 0xfc00 ||
    (s[0] === 0x2001 && s[1] === 0x0db8) ||
    (s[0] === 0x0100 && s[1] === 0 && s[2] === 0 && s[3] === 0) ||
    s[0] === 0x2002
  );
}
