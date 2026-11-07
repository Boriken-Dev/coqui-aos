/** The closed sets of words the specification and its vectors use. */

export function words<const T extends readonly string[]>(list: T) {
  return {
    all: list,
    is: (word: unknown): word is T[number] => typeof word === "string" && list.includes(word),
    named: (word: string): T[number] | undefined => (list.includes(word) ? (word as T[number]) : undefined),
  };
}

export const RUNTIMES = ["python", "node"] as const;
export type Runtime = (typeof RUNTIMES)[number];
export const runtime = words(RUNTIMES);

export const LEFT_STATES = ["rebuilt", "deleted"] as const;
export type LeftState = (typeof LEFT_STATES)[number];
export const leftState = words(LEFT_STATES);

export const MANIFEST_FILES = ["OVERLAY.md", "overlay.cfg"] as const;
export type ManifestFile = (typeof MANIFEST_FILES)[number];
export const manifestFile = words(MANIFEST_FILES);

export const FORMATS = ["toml", "json", "yaml"] as const;
export type Format = (typeof FORMATS)[number];
export const format = words(FORMATS);

export const FAIL_STEPS = ["deps", "setup"] as const;
export type FailStep = (typeof FAIL_STEPS)[number];
export const failStep = words(FAIL_STEPS);

export const NON_DEFAULT_IDS = [
  "deps-network",
  "env-passthrough",
  "env-script",
  "env-sensitive",
  "network-not-enforced",
  "no-timeout",
  "script-not-run",
  "setup-network",
  "unpinned",
  "secret-read",
  "insecure-transport",
  "private-source",
  "hook",
  "unlocked-dependencies",
] as const;
export type NonDefaultId = (typeof NON_DEFAULT_IDS)[number];
export const nonDefaultId = words(NON_DEFAULT_IDS);

/** A step of an overlay's preparation, as the vectors write it: `empty-state`, `deps:python`, `setup`, ... */
export type Step = "empty-state" | `deps:${Runtime}` | "setup" | "record" | "delete";
