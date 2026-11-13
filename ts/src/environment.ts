/** The environment an overlay builds, and the consumer's facts it is built from. */
import { AosError } from "./error.ts";
import { type Settings, DEFAULT_SETTINGS } from "./limits.ts";
import { asciiLower, validRelativePath } from "./names.ts";
import { substituteWith } from "./subst.ts";
import { OverlayTree } from "./tree.ts";
import type { Document } from "./value.ts";

/**
 * Variables in the order they were set, with the ones that came from a secret marked. On Windows
 * names compare without regard to ASCII case. A placeholder never reads a secret variable.
 */
/** A path addition made to a variable: what it put first and last, and every component it covers. */
export interface PathJoin {
  readonly separator: string;
  readonly prepend: readonly string[];
  readonly seen: ReadonlySet<string>;
  readonly append: readonly string[];
}

/** One set of an environment: the name, the value, whether it is a secret and the path addition it made. */
export type EnvWrite = readonly [string, string, boolean, PathJoin | undefined];

export class Environment {
  readonly windows: boolean;
  /** While not undefined, every set is appended to it, so one overlay's writes can be made onto another environment with `replay`. */
  log: EnvWrite[] | undefined = undefined;
  private entries = new Map<string, [string, string]>();
  private secret = new Set<string>();
  private settingsValue: Settings = DEFAULT_SETTINGS;
  /** Variables only a placeholder sees (the overlay's own root, name and state); empty outside an application. */
  extra: Array<[string, string]> = [];

  constructor(base: Iterable<[string, string]> = [], windows = false) {
    this.windows = windows;
    for (const [name, value] of base) this.set(name, value, false);
  }

  /** The settings that bound a substitution. */
  settings(settings: Settings): this {
    this.settingsValue = settings;
    return this;
  }

  clone(): Environment {
    const copy = new Environment([], this.windows);
    for (const [key, [name, value]] of this.entries) copy.entries.set(key, [name, value]);
    copy.secret = new Set(this.secret);
    copy.settingsValue = this.settingsValue;
    copy.extra = this.extra.map(([name, value]) => [name, value]);
    return copy;
  }

  /** The key a name is held under: itself, or its ASCII-lowercase form on Windows. */
  private key(name: string): string {
    return this.windows ? asciiLower(name) : name;
  }

  /** The value of a variable, secret or not. */
  get(name: string): string | undefined {
    return this.entries.get(this.key(name))?.[1];
  }

  private lookup(name: string): string | undefined {
    const extra = this.extra.find(([key]) => key === name || (this.windows && asciiLower(key) === asciiLower(name)));
    if (extra !== undefined) return extra[1];
    const key = this.key(name);
    const found = this.entries.get(key);
    if (found === undefined) return undefined;
    if (this.secret.has(key)) throw new AosError("secret-placeholder", name);
    return found[1];
  }

  /** Sets a variable, keeping the name's first spelling; `secret` marks its value as one. */
  set(name: string, value: string, secret: boolean): void {
    this.setJoined(name, value, secret, undefined);
  }

  /** `set` for a path addition, which `log` keeps with its `join`. */
  setJoined(name: string, value: string, secret: boolean, join: PathJoin | undefined): void {
    this.log?.push([name, value, secret, join]);
    const key = this.key(name);
    const held = this.entries.get(key);
    if (held === undefined) this.entries.set(key, [name, value]);
    else held[1] = value;
    if (secret) this.secret.add(key);
    else this.secret.delete(key);
  }

  /** Makes what another environment's `log` kept: a plain set as it was, a path addition onto this environment's own value. */
  replay(writes: readonly EnvWrite[]): void {
    for (const [name, value, secret, join] of writes) {
      if (join === undefined) {
        this.set(name, value, secret);
        continue;
      }
      const kept = (this.get(name) ?? "").split(join.separator).filter((part) => part !== "" && !join.seen.has(part));
      this.set(name, [...join.prepend, ...kept, ...join.append].join(join.separator), false);
    }
  }

  unset(name: string): void {
    const key = this.key(name);
    this.entries.delete(key);
    this.secret.delete(key);
  }

  /** Every variable, in the order set. */
  values(): ReadonlyArray<readonly [string, string]> {
    return [...this.entries.values()].map(([name, value]) => [name, value] as const);
  }

  isSecret(name: string): boolean {
    return this.secret.has(this.key(name));
  }

  /** Substitutes placeholders in `text`; a refusal names `variable`, never the text. */
  substitute(text: string, variable: string): string {
    try {
      return substituteWith(text, (name) => this.lookup(name), this.settingsValue);
    } catch (error) {
      if (error instanceof AosError) throw new AosError(error.class, variable);
      throw error;
    }
  }
}

/** What a consumer knows, and an overlay's environment is built from. */
export interface FactsFields {
  os: string;
  root: string;
  identity: string;
  state: string | undefined;
  pinned: boolean;
  baseEnv: Map<string, string>;
  hostEnv: Map<string, string>;
  grants: Map<string, string[]>;
  secrets: Map<string, string>;
  secretFiles: Map<string, string> | undefined;
  providers: string[] | undefined;
  providerValues: Map<string, Map<string, string>>;
  enforcesNetwork: boolean | undefined;
  envScriptsEnabled: boolean | undefined;
  gateEnvScripts: boolean;
  digest: string | undefined;
  allowed: string | undefined;
  interpreters: string[] | undefined;
  packages: Map<string, string>;
  tree: OverlayTree;
  settings: Settings;
}

/** The consumer's facts: its operating system, where the overlay is, what the user granted, and what it can run. */
export class Facts implements FactsFields {
  os: string;
  root = "";
  identity = "";
  state: string | undefined = undefined;
  pinned = false;
  baseEnv = new Map<string, string>();
  hostEnv = new Map<string, string>();
  grants = new Map<string, string[]>();
  secrets = new Map<string, string>();
  secretFiles: Map<string, string> | undefined = undefined;
  providers: string[] | undefined = undefined;
  providerValues = new Map<string, Map<string, string>>();
  enforcesNetwork: boolean | undefined = undefined;
  envScriptsEnabled: boolean | undefined = undefined;
  /** Whether env scripts run only while `digest` is the `allowed` one, the allowance of the overlay's hooks; off, none is held back. */
  gateEnvScripts = false;
  /** The overlay's tree digest, when the consumer has computed it. */
  digest: string | undefined = undefined;
  /** The one digest at which the user allowed this overlay's hooks and env scripts. */
  allowed: string | undefined = undefined;
  interpreters: string[] | undefined = undefined;
  packages = new Map<string, string>();
  tree: OverlayTree = OverlayTree.empty();
  settings: Settings = DEFAULT_SETTINGS;

  constructor(os: string, changes: Partial<FactsFields> = {}) {
    this.os = os;
    Object.assign(this, changes);
  }

  /** A copy with fields changed. */
  with(changes: Partial<FactsFields>): Facts {
    return new Facts(this.os, { ...this, ...changes });
  }

  get windows(): boolean {
    return this.os === "windows";
  }

  /** Whether the user granted the reference `entry` (a `secret` name, or a provider's key). */
  granted(entry: Document): boolean {
    const secret = entry.get("secret");
    if (typeof secret === "string") return (this.grants.get("secret") ?? []).includes(secret);
    const provider = textOf(entry, "provider");
    return (this.grants.get(provider) ?? []).includes(textOf(entry, "key"));
  }

  /** The value a reference resolves to, `undefined` when not granted or not held. */
  secret(entry: Document): string | undefined {
    const provider = entry.get("provider");
    const key = textOf(entry, "key");
    if (provider === "file" && !validRelativePath(key)) {
      throw new AosError("invalid-reference", key);
    }
    if (!this.granted(entry)) return undefined;
    const name = entry.get("secret");
    if (typeof name === "string") return this.secrets.get(name);
    const kind = typeof provider === "string" ? provider : "";
    const has =
      this.providers === undefined ? kind === "env" || kind === "file" : this.providers.includes(kind);
    if (!has) return undefined;
    if (kind === "env") return new Environment(this.hostEnv, this.windows).get(key);
    if (kind === "file") {
      const value = this.secretFiles?.get(key);
      if (value === undefined) return undefined;
      return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
    }
    return this.providerValues.get(kind)?.get(key);
  }
}

/** A mapping's text field, or the empty text. */
export function textOf(entry: unknown, key: string): string {
  const value = entry instanceof Map ? entry.get(key) : undefined;
  return typeof value === "string" ? value : "";
}
