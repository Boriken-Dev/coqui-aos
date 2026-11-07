import { bundledSkills, defaultPaths } from "./defaults.ts";
import { asciiUpper, validRelativePath } from "./names.ts";
import type { OverlayTree } from "./tree.ts";
import type { Document } from "./value.ts";
import { type Check, namedFilesOf, skillAt, skillName } from "./validate_check.ts";
import { declared, memberText, token } from "./validate_types.ts";

/** Extensions of the scripts a default `hook.<ext>` may have. */
const HOOK_EXTENSIONS = [".py", ".js", ".mjs", ".cjs", ".ps1", ".bash", ".sh"];

/** Every `[pointer, relative path]` of a file a field requires to exist. */
export function namedFiles(doc: Document): Array<[string, string]> {
  return namedFilesOf(doc);
}

/** What a validator flags without refusing: each skill name neither bundled nor given a source, as pointers. */
export function skillFlags(doc: Document, tree: OverlayTree): string[] {
  const folded = new Set([...bundledSkills(tree)].map((name) => name.toLowerCase()));
  const out: string[] = [];
  declared(doc, "skills").forEach((entry, index) => {
    if (typeof entry === "string" && !folded.has(entry.toLowerCase())) out.push(`/skills/${index}`);
  });
  return out;
}

/** The problems that need the overlay's files. */
export function validateFiles(doc: Document, tree: OverlayTree, check: Check): void {
  for (const [at, path] of namedFilesOf(doc)) {
    if (!tree.contains(path)) check.fail("missing-file", at);
  }
  const env = doc.get("env");
  if (env instanceof Map) {
    const added = new Set<string>();
    for (const entry of defaultPaths(doc, tree)) {
      const variable = memberText(entry, "variable");
      if (variable !== undefined) added.add(asciiUpper(variable));
    }
    for (const name of env.keys()) {
      if (added.has(asciiUpper(name))) check.fail("env-path-conflict", `/env/${token(name)}`);
    }
  }
  const hooks = doc.get("hooks");
  if (hooks instanceof Map) {
    const members = new Set([...tree.paths()].filter(validRelativePath));
    if (!HOOK_EXTENSIONS.some((extension) => members.has(`hook${extension}`))) {
      // A table with no run runs hook.<ext>, which has to be there.
      for (const [event, entry] of hooks) {
        if (entry instanceof Map && !entry.has("run")) check.fail("missing-file", `/hooks/${token(event)}`);
      }
    }
  }
  const bundled = new Set(bundledSkills(tree));
  const folded = new Set([...bundled].map((name) => name.toLowerCase()));
  declared(doc, "skills").forEach((entry, index) => {
    const name = skillName(entry);
    if (name === undefined || !folded.has(name.toLowerCase())) return;
    if (entry instanceof Map) check.fail("skill-ambiguous", skillAt(entry, index));
    else if (!bundled.has(name)) check.fail("skill-case", skillAt(entry, index));
  });
  if (tree.contains("OVERLAY.md") && tree.contains("overlay.cfg")) check.fail("two-manifests", "");
  const mcp = doc.get("mcp");
  declared(mcp, "skills").forEach((link, index) => {
    const name = memberText(link, "name");
    if (name !== undefined && !tree.contains(`skills/${name}/SKILL.md`)) check.fail("missing-skill", `/mcp/skills/${index}/name`);
  });
}
