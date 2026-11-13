/** What preparing an overlay does when it is added, synced, activated or removed. */
import type { SetupRun } from "./apply.ts";
import type { Dependency } from "./defaults.ts";
import type { FailStep, Step } from "./kinds.ts";
import { words } from "./kinds.ts";

/** What the user is doing to an overlay. */
export const CHANGES = ["add", "sync", "activate", "remove"] as const;
export type Change = (typeof CHANGES)[number];

/** A setup script's phase: its first argument. */
export const PHASES = ["install", "sync", "remove"] as const;
export type Phase = (typeof PHASES)[number];
export const phase = words(PHASES);

/** What was last prepared: the overlay's digest, and the phase that did it. */
export interface SetupRecord {
  readonly digest: string;
  readonly phase: Phase;
}

/** A record as a consumer keeps it: `{"digest": ..., "phase": ...}`. */
export function setupRecordToJson(record: SetupRecord): { digest: string; phase: Phase } {
  return { digest: record.digest, phase: record.phase };
}

/** What `setupRecordToJson` wrote; a `TypeError` for anything else, including a `phase` that is not exactly a phase. */
export function setupRecordFromJson(value: unknown): SetupRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("a setup record is an object");
  const { digest, phase: name } = value as { digest?: unknown; phase?: unknown };
  if (typeof digest !== "string" || typeof name !== "string") throw new TypeError("a setup record has a digest and a phase, both text");
  const found = phase.named(name);
  if (found === undefined) throw new TypeError("not a setup phase");
  return { digest, phase: found };
}

const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Which phase, if any, a change calls for, given the digest last recorded and the current one. */
export function setupPhase(change: Change, recorded: string | undefined, digest: string | undefined): Phase | undefined {
  if (change === "remove") return recorded === undefined ? undefined : "remove";
  if (recorded === undefined) return "install";
  if (change === "activate" && digest !== undefined && asciiLower(digest) === asciiLower(recorded)) return undefined;
  return "sync";
}

/** The steps a change runs and what is recorded after them. */
export interface Preparation {
  readonly phase: Phase | undefined;
  /** The setup script's arguments: the phase, then its own. */
  readonly arguments: readonly string[] | undefined;
  readonly steps: readonly Step[];
  readonly record: SetupRecord | undefined;
  /** Whether the overlay may be activated afterwards. */
  readonly activates: boolean;
}

/** Plans a change; `fails` names the step that fails, ending the run there. */
export function preparation(
  change: Change,
  record: SetupRecord | undefined,
  digest: string | undefined,
  setup: SetupRun | undefined,
  dependencies: readonly Dependency[],
  fails: FailStep | undefined,
): Preparation {
  const recorded = record?.digest;
  const phase = setup !== undefined || dependencies.length > 0 ? setupPhase(change, recorded, digest) : undefined;
  let steps: Step[] = [];
  if (phase === "install") steps.push("empty-state");
  if (phase === "install" || phase === "sync") {
    for (const dependency of dependencies) steps.push(`deps:${dependency.runtime}`);
  }
  if (phase !== undefined && setup !== undefined) steps.push("setup");
  let failed = false;
  if (fails !== undefined) {
    const index = steps.findIndex((step) => (fails === "deps" ? step.startsWith("deps:") : step === "setup"));
    if (index !== -1) {
      steps = steps.slice(0, index + 1);
      failed = true;
    }
  }
  let after: SetupRecord | undefined;
  let activates: boolean;
  if (change === "remove") {
    steps.push("delete");
    after = undefined;
    activates = false;
  } else if (phase === undefined) {
    after = record;
    activates = true;
  } else if (failed) {
    // The record still names the last digest prepared; only that one stays usable.
    after = record;
    activates = recorded !== undefined && recorded === digest;
  } else {
    steps.push("record");
    after = { digest: digest ?? "", phase };
    activates = true;
  }
  return {
    phase,
    arguments: phase !== undefined && setup !== undefined ? [phase, ...setup.args] : undefined,
    steps,
    record: after,
    activates,
  };
}
