/** Shapes the compose, effective and dotenv vectors read and write. */
import type { Environment } from "../src/environment.ts";
import { Facts } from "../src/environment.ts";
import { OverlayTree } from "../src/tree.ts";
import { type Json, str, strings } from "./support.ts";

export function stringMap(value: Json | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (value instanceof Map) for (const [key, item] of value) if (typeof item === "string") out.set(key, item);
  return out;
}

/** The consumer's facts a case writes. */
export function factsOf(raw: Map<string, Json>): Facts {
  const text = (key: string): string | undefined => {
    const value = raw.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const facts = new Facts(text("os") ?? "");
  facts.root = text("root") ?? "";
  facts.identity = text("identity") ?? "";
  facts.state = text("state");
  facts.pinned = raw.get("pinned") === true;
  facts.baseEnv = stringMap(raw.get("base_env"));
  facts.hostEnv = stringMap(raw.get("host_env"));
  const grants = raw.get("grants");
  if (grants instanceof Map) for (const [provider, keys] of grants) facts.grants.set(provider, strings(keys));
  facts.secrets = stringMap(raw.get("secrets"));
  const files = raw.get("secret_files");
  facts.secretFiles = files instanceof Map ? stringMap(files) : undefined;
  const providers = raw.get("providers");
  facts.providers = Array.isArray(providers) ? strings(providers) : undefined;
  const values = raw.get("provider_values");
  if (values instanceof Map) for (const [provider, map] of values) facts.providerValues.set(provider, stringMap(map));
  const network = raw.get("enforces_network");
  facts.enforcesNetwork = typeof network === "boolean" ? network : undefined;
  const scripts = raw.get("env_scripts_enabled");
  facts.envScriptsEnabled = typeof scripts === "boolean" ? scripts : undefined;
  const interpreters = raw.get("interpreters");
  facts.interpreters = Array.isArray(interpreters) ? strings(interpreters) : undefined;
  facts.packages = stringMap(raw.get("packages"));
  return facts;
}

/** A tree from a case's `files`: a list of paths, or a mapping of path to text. */
export function treeOf(files: Json | undefined): OverlayTree {
  if (Array.isArray(files)) return OverlayTree.fromPaths(files.map(str));
  if (files instanceof Map) return OverlayTree.fromTexts([...files].map(([path, text]) => [path, str(text)] as const));
  return OverlayTree.empty();
}

export function envData(env: Environment): Map<string, string> {
  return new Map(env.values());
}
