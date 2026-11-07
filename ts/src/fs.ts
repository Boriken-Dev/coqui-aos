/** The filesystem a caller supplies: the core reads files only through it. */

/** What a path is, without following a link. */
export type FileKind = "file" | "directory" | "symlink" | "other";

/** A path's kind and, for a file, its size in bytes. */
export interface Metadata {
  readonly kind: FileKind;
  readonly len: number;
}

/** Either the value or a promise of it: a synchronous implementation need not wrap. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Three operations, never following a link in `metadata`. Paths are joined by the core with `/`.
 * An implementation throws what its platform throws; the core reports it as `io`.
 */
export interface FileSystem {
  /** What `path` is, WITHOUT following a link: a link is `symlink`. */
  metadata(path: string): MaybePromise<Metadata>;
  /** The first `max` bytes of the file at `path`. */
  read(path: string, max: number): MaybePromise<Uint8Array>;
  /** The names in a directory, single path components in any order; a name that is not Unicode is its bytes. */
  list(path: string): MaybePromise<Array<string | Uint8Array>>;
}

/** `root` and a child `name` as one path. */
export function joinPath(root: string, name: string): string {
  return root.endsWith("/") || root.endsWith("\\") ? root + name : `${root}/${name}`;
}
