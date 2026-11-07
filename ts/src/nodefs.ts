/** `node:fs` as a {@link FileSystem}. The one module of the package that needs Node. */
import { lstat, open, readdir } from "node:fs/promises";
import type { FileSystem, Metadata } from "./fs.ts";

const REPARSE_POINT = 0x400;

/**
 * The operating system's files. A reparse point is a symlink on Windows. `read` and `list` follow
 * links, as `node:fs` does: read only trees no one else can write.
 */
export class NodeFs implements FileSystem {
  async metadata(path: string): Promise<Metadata> {
    const stats = await lstat(path);
    const attributes = (stats as { attributes?: number }).attributes;
    if (stats.isSymbolicLink() || (attributes !== undefined && (attributes & REPARSE_POINT) !== 0)) {
      return { kind: "symlink", len: 0 };
    }
    if (stats.isDirectory()) return { kind: "directory", len: 0 };
    if (stats.isFile()) return { kind: "file", len: stats.size };
    return { kind: "other", len: 0 };
  }

  async read(path: string, max: number): Promise<Uint8Array> {
    const handle = await open(path, "r");
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      while (total < max) {
        const buffer = Buffer.allocUnsafe(Math.min(1 << 20, max - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        total += bytesRead;
      }
      return new Uint8Array(Buffer.concat(chunks));
    } finally {
      await handle.close();
    }
  }

  async list(path: string): Promise<Array<string | Uint8Array>> {
    const names = await readdir(path, { encoding: "buffer" });
    const strict = new TextDecoder("utf-8", { fatal: true });
    return names.map((name) => {
      try {
        return strict.decode(name);
      } catch {
        return new Uint8Array(name);
      }
    });
  }
}
