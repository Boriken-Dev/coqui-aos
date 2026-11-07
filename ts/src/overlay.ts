/** Reading an overlay: its one manifest, its context and its problems. */
import { contextIgnored, contextOf, harnessContextOf } from "./defaults.ts";
import { AosError } from "./error.ts";
import { readFrontMatter } from "./front_matter.ts";
import type { ManifestFile } from "./kinds.ts";
import type { Settings } from "./limits.ts";
import { allows } from "./limits.ts";
import { readDocument } from "./read.ts";
import { compareText, decodeUtf8 } from "./text.ts";
import type { OverlayTree } from "./tree.ts";
import { validate } from "./validate.ts";
import type { Document } from "./value.ts";

/** What an overlay's files say: the manifest, the context it names, and the JSON pointers of its problems. */
export interface OverlayRead {
  readonly manifestFile: ManifestFile | undefined;
  readonly manifest: Document;
  readonly context: string[];
  readonly contextIgnored: string[];
  /** RFC 6901 pointers, sorted. */
  readonly issues: string[];
  /** Per harness that lists context, the files it names; `undefined` when the manifest has no `harness` table. */
  readonly harnessContext: Map<string, string[]> | undefined;
}

const isBlank = (byte: number): boolean => byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;

/**
 * Reads an overlay from a tree holding the bytes of `OVERLAY.md` or `overlay.cfg`. Refuses two
 * manifests (`two-manifests`), a manifest that does not read, and a context body past
 * `contextBytes` or not UTF-8.
 */
export function readOverlay(tree: OverlayTree, settings: Settings): OverlayRead {
  if (tree.contains("OVERLAY.md") && tree.contains("overlay.cfg")) {
    throw new AosError("two-manifests", "OVERLAY.md and overlay.cfg");
  }
  const manifestFile: ManifestFile | undefined = tree.contains("OVERLAY.md")
    ? "OVERLAY.md"
    : tree.contains("overlay.cfg")
      ? "overlay.cfg"
      : undefined;
  const bytesOf = (name: string): Uint8Array => tree.bytes(name) ?? new Uint8Array(0);
  let manifest: Document = new Map();
  let body: Uint8Array = new Uint8Array(0);
  let bodyLine = 1;
  if (manifestFile === "overlay.cfg") {
    manifest = readDocument(bytesOf("overlay.cfg"), settings);
  } else if (manifestFile !== undefined) {
    const data = bytesOf("OVERLAY.md");
    const read = readFrontMatter(data, settings);
    if (read.error !== undefined) throw read.error;
    manifest = read.data ?? new Map();
    body = data.subarray(Math.min(read.bodyOffset ?? 0, data.length));
    bodyLine = read.bodyLine ?? 1;
  }
  const context = contextOf(manifest, tree);
  const hints = manifest.get("harness");
  const harnesses = hints instanceof Map ? hints : undefined;
  const lists = (entry: unknown): boolean => entry instanceof Map && entry.has("context");
  const named = [...context];
  for (const [harness, entry] of harnesses ?? []) if (lists(entry)) named.push(...harnessContextOf(manifest, harness, tree));
  if (named.includes("OVERLAY.md") && body.some((byte) => !isBlank(byte))) {
    if (!allows(settings.contextBytes, body.length)) {
      throw new AosError("too-large", "the body of OVERLAY.md").onLine(bodyLine);
    }
    try {
      decodeUtf8(body);
    } catch {
      throw new AosError("invalid-utf8", "the body of OVERLAY.md").onLine(bodyLine);
    }
  }
  const issues = validate(manifest, tree).map((issue) => issue.at);
  let harnessContext: Map<string, string[]> | undefined;
  if (harnesses !== undefined) {
    harnessContext = new Map();
    const keys = [...harnesses.keys()].sort(compareText);
    for (const harness of keys) {
      if (lists(harnesses.get(harness))) harnessContext.set(harness, harnessContextOf(manifest, harness, tree));
    }
  }
  return { manifestFile, manifest, context, contextIgnored: contextIgnored(manifest, tree), issues, harnessContext };
}
