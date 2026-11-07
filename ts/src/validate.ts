/**
 * Validating a manifest's data model: the rules `schemas/overlay.schema.json` states, then those it
 * cannot (an integer refusing a float, cross references, reserved names, files that must exist),
 * each reported with a JSON pointer to the offending value.
 */
import { validateFiles } from "./validate_files.ts";
import { Check, semantic } from "./validate_check.ts";
import type { OverlayTree } from "./tree.ts";
import type { Document } from "./value.ts";
import type { Issue } from "./validate_types.ts";
import { compareText } from "./text.ts";

export { ISSUE_CODES, issueCode } from "./validate_types.ts";
export type { Issue, IssueCode } from "./validate_types.ts";
export { namedFiles, skillFlags } from "./validate_files.ts";
export {
  aboutFieldValid,
  catalogFieldValid,
  envValueOk,
  isDigest,
  isGitRef,
  validLicense,
} from "./validate_check.ts";

/** Whether a manifest with these problems is still applied: a problem under `/about`, which is informational only, never stops it. */
export function applies(issues: readonly Issue[]): boolean {
  return issues.every((issue) => issue.at === "/about" || issue.at.startsWith("/about/"));
}

/**
 * Every problem with `manifest`, sorted and without repeats; empty when it is valid. With `tree`,
 * every file a field names must be one of the overlay's files, and `env` may set no variable a
 * default path addition adds to.
 */
export function validate(manifest: Document, tree?: OverlayTree): Issue[] {
  const check = new Check();
  check.document(manifest);
  semantic(manifest, check);
  if (tree !== undefined) validateFiles(manifest, tree, check);
  const unique = new Map<string, Issue>();
  for (const issue of check.issues) unique.set(`${issue.at}\u0000${issue.code}`, issue);
  return [...unique.values()].sort((a, b) => compareText(a.at, b.at) || compareText(a.code, b.code));
}
