import { validRelativePath } from "./names.ts";
import { compareText } from "./text.ts";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/**
 * An overlay's files as the core sees them: the paths it holds, and the bytes of those it was
 * given. Immutable: `withText` and `withBytes` return a changed copy.
 */
export class OverlayTree {
  readonly #paths: ReadonlySet<string>;
  readonly #bytes: ReadonlyMap<string, Uint8Array>;

  private constructor(paths: ReadonlySet<string>, bytes: ReadonlyMap<string, Uint8Array>) {
    this.#paths = paths;
    this.#bytes = bytes;
  }

  /** A tree of these paths, none of whose bytes are held. */
  static fromPaths(paths: Iterable<string>): OverlayTree {
    return new OverlayTree(new Set(paths), new Map());
  }

  /** A tree of these files and their text. */
  static fromTexts(files: Iterable<readonly [string, string]>): OverlayTree {
    const bytes = new Map<string, Uint8Array>();
    for (const [path, text] of files) bytes.set(path, encoder.encode(text));
    return new OverlayTree(new Set(bytes.keys()), bytes);
  }

  /** A tree of these files and their bytes, which are copied. */
  static fromBytes(files: Iterable<readonly [string, Uint8Array]>): OverlayTree {
    const bytes = new Map<string, Uint8Array>();
    for (const [path, data] of files) bytes.set(path, data.slice());
    return new OverlayTree(new Set(bytes.keys()), bytes);
  }

  /** An empty tree. */
  static empty(): OverlayTree {
    return new OverlayTree(new Set(), new Map());
  }

  /** A copy with the text of a path the tree holds; a path it does not hold is ignored. */
  withText(path: string, text: string): OverlayTree {
    if (!this.#paths.has(path)) return this;
    return new OverlayTree(this.#paths, new Map(this.#bytes).set(path, encoder.encode(text)));
  }

  /** A copy that holds `path` and a copy of its bytes. */
  withBytes(path: string, bytes: Uint8Array): OverlayTree {
    return new OverlayTree(new Set(this.#paths).add(path), new Map(this.#bytes).set(path, bytes.slice()));
  }

  /** The paths, in byte order. */
  paths(): string[] {
    return [...this.#paths].sort(compareText);
  }

  /** Whether the tree holds `path`. */
  contains(path: string): boolean {
    return this.#paths.has(path);
  }

  /** The text of a path whose bytes were read, if they are UTF-8. */
  text(path: string): string | undefined {
    const bytes = this.#bytes.get(path);
    if (bytes === undefined) return undefined;
    try {
      return decoder.decode(bytes);
    } catch {
      return undefined;
    }
  }

  /** The bytes of a path that was read; they are the tree's own, so do not change them. */
  bytes(path: string): Uint8Array | undefined {
    return this.#bytes.get(path);
  }

  /** The paths an overlay may name, in byte order: valid relative paths. */
  members(): string[] {
    return this.paths().filter(validRelativePath);
  }

  /** Whether `path` is a path the tree holds and an overlay may name. */
  hasMember(path: string): boolean {
    return this.#paths.has(path) && validRelativePath(path);
  }
}
