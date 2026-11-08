/** The tree digest: which files an overlay is, hashed in a form no platform changes. */
import { sha256 } from "@noble/hashes/sha2.js";
import { AosError, type ErrorClass } from "./error.ts";
import { type FileSystem, joinPath } from "./fs.ts";
import { type Settings, allows, limitText } from "./limits.ts";
import { EXCLUDED_COMPONENTS, asciiLower, validRelativePath } from "./names.ts";
import { compareText, encodeUtf8 } from "./text.ts";
import { OverlayTree } from "./tree.ts";

const HEX = /^[0-9a-f]{64}$/i;

/** A SHA-256 digest. Written `sha256:` and 64 hexadecimal digits. */
export class Digest {
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /** The digest of `bytes`. */
  static of(bytes: Uint8Array): Digest {
    return new Digest(sha256(bytes));
  }

  /** Reads `sha256:<64 hex digits>`, or `invalid-digest`. */
  static parse(text: string): Digest {
    const hex = text.startsWith("sha256:") ? text.slice("sha256:".length) : "";
    if (!HEX.test(hex)) throw new AosError("invalid-digest", "a digest is sha256: and 64 hexadecimal digits");
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return new Digest(bytes);
  }

  /** The 32 bytes. */
  bytes(): Uint8Array {
    return this.#bytes.slice();
  }

  equals(other: Digest): boolean {
    return this.toString() === other.toString();
  }

  toString(): string {
    return `sha256:${Array.from(this.#bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/** A member of a tree as the digest sees it. */
export type TreeEntry =
  | { readonly kind: "file"; readonly bytes: Uint8Array }
  | { readonly kind: "directory" }
  | { readonly kind: "symlink" }
  | { readonly kind: "special" };

/** An overlay's digest and each member's. */
export interface TreeDigest {
  readonly digest: Digest;
  /** Member path to digest, in byte order of the path. */
  readonly files: Map<string, Digest>;
  /** The bytes that were hashed: per member `path NUL digest LF`. */
  lines(): Uint8Array[];
}

const lossy = new TextDecoder("utf-8");

function refused(cls: ErrorClass, subject: string): AosError {
  return new AosError(cls, subject);
}

function shown(components: ReadonlyArray<Uint8Array>): string {
  return components.map((component) => lossy.decode(component)).join("/");
}

function lineOf(path: string, digest: Digest): Uint8Array {
  const text = encodeUtf8(path);
  const hash = encodeUtf8(digest.toString());
  const line = new Uint8Array(text.length + 1 + hash.length + 1);
  line.set(text, 0);
  line.set(hash, text.length + 1);
  line[line.length - 1] = 0x0a;
  return line;
}

function finish(found: Map<string, Digest>): TreeDigest {
  const files = new Map([...found.entries()].sort(([a], [b]) => compareText(a, b)));
  const lines = (): Uint8Array[] => [...files].map(([path, digest]) => lineOf(path, digest));
  const all = lines();
  const text = new Uint8Array(all.reduce((sum, line) => sum + line.length, 0));
  let at = 0;
  for (const line of all) {
    text.set(line, at);
    at += line.length;
  }
  return { digest: Digest.of(text), files, lines };
}

const excludedBytes = EXCLUDED_COMPONENTS.map(encodeUtf8);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, at) => byte === b[at]);

function excluded(components: ReadonlyArray<Uint8Array>, directory: boolean): boolean {
  if (components.some((component) => excludedBytes.some((name) => sameBytes(name, component)))) return true;
  const last = components[components.length - 1];
  return !directory && last !== undefined && last.length >= 4 && lossy.decode(last.subarray(last.length - 4)) === ".pyc";
}

function memberPath(components: ReadonlyArray<Uint8Array>): string {
  const strict = new TextDecoder("utf-8", { fatal: true });
  let names: string[];
  try {
    names = components.map((component) => strict.decode(component));
  } catch {
    throw refused("non-utf8-name", shown(components));
  }
  const path = names.join("/");
  if (!validRelativePath(path)) throw refused("invalid-name", shown(components));
  return path;
}

function checkCase(files: ReadonlyMap<string, Digest>): void {
  const folded = new Map<string, string>();
  for (const path of files.keys()) {
    const key = asciiLower(path);
    const other = folded.get(key);
    folded.set(key, path);
    if (other !== undefined && other !== path) throw refused("case-collision", path);
  }
}

/**
 * The digest of entries given as path components and what each is, in any order. A directory and
 * an excluded name are skipped; a symlink is `symlink`, anything else but a file `special-file`; a
 * path twice is `duplicate-member`.
 */
export function digestEntries(entries: Iterable<readonly [ReadonlyArray<Uint8Array | string>, TreeEntry]>): TreeDigest {
  const files = new Map<string, Digest>();
  for (const [given, entry] of entries) {
    const components = given.map((part) => (typeof part === "string" ? encodeUtf8(part) : part));
    const directory = entry.kind === "directory";
    if (directory || excluded(components, directory)) continue;
    if (entry.kind === "symlink") throw refused("symlink", shown(components));
    if (entry.kind !== "file") throw refused("special-file", shown(components));
    const path = memberPath(components);
    if (files.has(path)) throw refused("duplicate-member", path);
    files.set(path, Digest.of(entry.bytes));
  }
  checkCase(files);
  return finish(files);
}

/** Refuses entries past the tree limits before any is hashed: for trees a caller hands over rather than the library walks. */
export function checkEntries(entries: ReadonlyArray<readonly [unknown, TreeEntry]>, settings: Settings): void {
  if (!allows(settings.treeFiles, entries.length)) {
    throw new AosError("too-large", `more than ${limitText(settings.treeFiles)} files and directories`);
  }
  let total = 0;
  for (const [, entry] of entries) {
    if (entry.kind === "file") {
      if (!allows(settings.fileBytes, entry.bytes.length)) {
        throw new AosError("too-large", `a file larger than ${limitText(settings.fileBytes)} bytes`);
      }
      total += entry.bytes.length;
    }
  }
  if (!allows(settings.treeBytes, total)) {
    throw new AosError("too-large", `more than ${limitText(settings.treeBytes)} bytes`);
  }
}

/** The digest of a directory read through `files`. Nothing is followed: a link is refused. */
export async function treeDigest(files: FileSystem, root: string, settings: Settings): Promise<TreeDigest> {
  return (await walkTree(files, root, settings, false)).digest;
}

/** Every member's bytes and the digest of one walk. */
export async function readTree(
  files: FileSystem,
  root: string,
  settings: Settings,
): Promise<{ tree: OverlayTree; digest: TreeDigest }> {
  const { digest, contents } = await walkTree(files, root, settings, true);
  return { tree: OverlayTree.fromBytes(contents), digest };
}

function ioError(error: unknown, prefix = ""): AosError {
  const message = error instanceof Error ? error.message : String(error);
  return refused("io", `${prefix}${message}`);
}

async function walkTree(
  files: FileSystem,
  root: string,
  settings: Settings,
  keep: boolean,
): Promise<{ digest: TreeDigest; contents: Map<string, Uint8Array> }> {
  let metadata;
  try {
    metadata = await files.metadata(root);
  } catch (error) {
    throw ioError(error);
  }
  if (metadata.kind !== "directory") throw refused("io", "the root is not a directory (a link is never followed)");
  const walk = new Walk(files, settings, keep);
  await walk.directory(root, [], 1);
  checkCase(walk.found);
  return { digest: finish(walk.found), contents: walk.contents };
}

class Walk {
  readonly found = new Map<string, Digest>();
  readonly contents = new Map<string, Uint8Array>();
  private bytes = 0;
  private entries = 0;
  private readonly files: FileSystem;
  private readonly settings: Settings;
  private readonly keep: boolean;

  constructor(files: FileSystem, settings: Settings, keep: boolean) {
    this.files = files;
    this.settings = settings;
    this.keep = keep;
  }

  async directory(path: string, components: Uint8Array[], depth: number): Promise<void> {
    if (!allows(this.settings.treeDepth, depth)) {
      throw refused("too-large", `directories nested deeper than ${limitText(this.settings.treeDepth)}`);
    }
    let listed;
    try {
      listed = await this.files.list(path);
    } catch (error) {
      throw ioError(error);
    }
    const names = listed.map((name) => ({ name, bytes: typeof name === "string" ? encodeUtf8(name) : new Uint8Array([0xff]) }));
    names.sort((a, b) => compareBytes(a.bytes, b.bytes));
    for (const { name, bytes } of names) {
      if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 0x2e) || (bytes.length === 2 && bytes[0] === 0x2e && bytes[1] === 0x2e) || bytes.some((byte) => byte === 0x2f || byte === 0x5c || byte === 0)) {
        throw refused("invalid-name", shown([bytes]));
      }
      if (typeof name !== "string") throw refused("non-utf8-name", shown([...components, bytes]));
      components.push(bytes);
      try {
        await this.entry(joinPath(path, name), components, depth);
      } finally {
        components.pop();
      }
    }
  }

  private count(): void {
    this.entries += 1;
    if (!allows(this.settings.treeFiles, this.entries)) {
      throw refused("too-large", `more than ${limitText(this.settings.treeFiles)} files and directories`);
    }
  }

  private async entry(path: string, components: Uint8Array[], depth: number): Promise<void> {
    let metadata;
    try {
      metadata = await this.files.metadata(path);
    } catch (error) {
      throw ioError(error);
    }
    const directory = metadata.kind === "directory";
    if (excluded(components, directory)) return;
    if (metadata.kind === "symlink") throw refused("symlink", shown(components));
    if (directory) {
      this.count();
      await this.directory(path, components, depth + 1);
      return;
    }
    if (metadata.kind !== "file") throw refused("special-file", shown(components));
    const member = memberPath(components);
    this.count();
    const most = this.settings.fileBytes === null ? Number.MAX_SAFE_INTEGER : this.settings.fileBytes + 1;
    let bytes: Uint8Array;
    try {
      bytes = await this.files.read(path, most);
    } catch (error) {
      throw ioError(error, `${member}: `);
    }
    if (!allows(this.settings.fileBytes, bytes.length)) {
      throw refused("too-large", `${member} is larger than ${limitText(this.settings.fileBytes)} bytes`);
    }
    this.bytes += bytes.length;
    if (!allows(this.settings.treeBytes, this.bytes)) {
      throw refused("too-large", `more than ${limitText(this.settings.treeBytes)} bytes`);
    }
    this.found.set(member, Digest.of(bytes));
    if (this.keep) this.contents.set(member, bytes);
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const common = Math.min(a.length, b.length);
  for (let at = 0; at < common; at += 1) {
    const difference = a[at]! - b[at]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
