import { DEFAULT_KEYS } from "./defaults.ts";
import {
  asciiLower,
  asciiUpper,
  isReservedVariable,
  isVariableName,
  overlayNameShaped,
  validOsName,
  validOverlayName,
  validRelativePath,
  validToolName,
} from "./names.ts";
import { Source } from "./source.ts";
import type { Document, Value } from "./value.ts";
import { type Issue, type IssueCode, canon, declared, join, memberText, token } from "./validate_types.ts";

const HOOK_EVENTS = [
  "pre-env",
  "session-start",
  "session-end",
  "prompt",
  "turn-end",
  "cd",
  "pre-compact",
  "pre-tool",
  "post-tool",
] as const;
type HookEventName = (typeof HOOK_EVENTS)[number];
const SCRIPT_EXTENSIONS = [".py", ".sh", ".bash", ".ps1", ".js", ".mjs", ".cjs"];

const noNul = (text: string): boolean => !text.includes("\0");
const WHITE_SPACE = new RegExp("[\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]", "u");

const LINE_BREAKS_AND_CONTROLS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]",
  "u",
);

function isLine(text: string): boolean {
  return text !== "" && !LINE_BREAKS_AND_CONTROLS.test(text);
}

const isControl = (c: string): boolean => /[\u0000- \u007f-\u009f]/u.test(c);

/** An `https://` URL with a host and no user information or control characters. */
export function isWebUrl(text: string): boolean {
  if (!text.startsWith("https://")) return false;
  const rest = text.slice(8);
  const end = rest.search(/[/?#]/);
  const host = end === -1 ? rest : rest.slice(0, end);
  const tail = end === -1 ? "" : rest.slice(end);
  return host !== "" && ![...host].some((c) => isControl(c) || c === "@" || c === "\\") && ![...tail].some(isControl);
}

function isMcpUrl(text: string): boolean {
  const lower = asciiLower([...text].slice(0, 8).join(""));
  let rest: string;
  if (lower.startsWith("https://")) rest = text.slice(8);
  else if (lower.startsWith("http://")) rest = text.slice(7);
  else return false;
  const end = rest.search(/[/?]/);
  const host = end === -1 ? rest : rest.slice(0, end);
  const tail = end === -1 ? "" : rest.slice(end);
  return (
    host !== "" &&
    ![...host].some((c) => c === "#" || c === "@" || WHITE_SPACE.test(c)) &&
    ![...tail].some((c) => c === "#" || WHITE_SPACE.test(c))
  );
}

const isVersion = (text: string): boolean => {
  const parts = text.split(".");
  return parts.length <= 3 && parts.every((part) => /^[0-9]{1,9}$/.test(part));
};

const isEnvironmentName = (text: string): boolean =>
  /^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(text);

/** `sha256:` and 64 hexadecimal digits. */
export function isDigest(text: string): boolean {
  return /^sha256:[0-9A-Fa-f]{64}$/.test(text);
}

function isLowercaseId(text: string, firstDigit: boolean): boolean {
  return (firstDigit ? /^[a-z0-9][a-z0-9-]*$/ : /^[a-z][a-z0-9-]*$/).test(text);
}

function isScriptPath(text: string): boolean {
  return validRelativePath(text) && text.split("/").every((component) => /^[A-Za-z0-9_+-][A-Za-z0-9_+.-]*$/.test(component));
}

/** A script a hook runs: a script path with an extension that names an interpreter. */
function isHookRun(text: string): boolean {
  return isScriptPath(text) && SCRIPT_EXTENSIONS.some((extension) => text.endsWith(extension));
}

const isCommandName = (text: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(text);
const isCommandNameStrict = (text: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text);
const isHeaderName = (text: string): boolean => /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(text);

/** A Git ref a skill table names: no `-` first, and none of `/ : \ @ #`, controls or spaces. */
export function isGitRef(text: string): boolean {
  const chars = [...text];
  const bad = (c: string): boolean => "/:\\@#".includes(c) || c <= " " || c === "\u007f";
  const first = chars[0];
  return first !== undefined && first !== "-" && chars.every((c) => !bad(c));
}

const osListOk = (value: Value | undefined): boolean =>
  Array.isArray(value) && value.every((name) => typeof name === "string" && validOsName(name));

/** One problem collector; each method checks one kind of value and reports at a pointer. */
export class Check {
  readonly issues: Issue[] = [];

  fail(code: IssueCode, at: string): void {
    this.issues.push({ at, code });
  }

  require(ok: boolean, at: string): void {
    if (!ok) this.fail("schema", at);
  }

  string(value: Value | undefined, at: string, ok: (text: string) => boolean): void {
    this.require(typeof value === "string" && ok(value), at);
  }

  boolean(value: Value | undefined, at: string): void {
    this.require(typeof value === "boolean", at);
  }

  /** An integer in `low..=high`; a float of any value is `integer-required`. */
  integer(value: Value | undefined, at: string, low: bigint, high: bigint): void {
    if (typeof value === "number") this.fail("integer-required", at);
    else this.require(typeof value === "bigint" && value >= low && value <= high, at);
  }

  array(value: Value | undefined, at: string): readonly Value[] {
    if (Array.isArray(value)) return value;
    this.fail("schema", at);
    return [];
  }

  each(value: Value | undefined, at: string, item: (entry: Value, at: string) => void): void {
    this.array(value, at).forEach((entry, index) => item(entry, join(at, index)));
  }

  unique(value: Value | undefined, at: string): void {
    if (!Array.isArray(value)) return;
    const seen = new Set<string>();
    for (const item of value) {
      const key = canon(item);
      if (seen.has(key)) {
        this.fail("schema", at);
        return;
      }
      seen.add(key);
    }
  }

  /** A mapping whose keys are only `known`; undefined for something that is not one. */
  object(value: Value | undefined, at: string, known: readonly string[]): Document | undefined {
    if (!(value instanceof Map)) {
      this.fail("schema", at);
      return undefined;
    }
    for (const key of value.keys()) if (!known.includes(key)) this.fail("schema", join(at, key));
    return value;
  }

  required(map: Document, at: string, keys: readonly string[]): void {
    for (const key of keys) if (!map.has(key)) this.fail("schema", at);
  }

  relPath(value: Value | undefined, at: string): void {
    this.string(value, at, validRelativePath);
  }

  osList(value: Value | undefined, at: string): void {
    this.each(value, at, (name, there) => this.string(name, there, validOsName));
  }

  variable(name: string, at: string): void {
    this.require(isVariableName(name) && !isReservedVariable(name), at);
  }

  document(doc: Document): void {
    for (const [key, value] of doc) {
      const at = `/${token(key)}`;
      switch (key) {
        case "name":
        case "description":
          this.string(value, at, () => true);
          break;
        case "requires":
          this.each(value, at, (name, there) => this.string(name, there, overlayNameShaped));
          break;
        case "routing":
          this.each(value, at, (line, there) => this.string(line, there, () => true));
          break;
        case "rules":
        case "context":
          this.each(value, at, (path, there) => this.relPath(path, there));
          break;
        case "priority":
          this.integer(value, at, -(2n ** 63n), 2n ** 63n - 1n);
          break;
        case "defaults": {
          const map = this.object(value, at, DEFAULT_KEYS);
          if (map) for (const [name, flag] of map) this.boolean(flag, join(at, name));
          break;
        }
        case "skills":
          this.each(value, at, (entry, there) => this.skillEntry(entry, there));
          this.unique(value, at);
          break;
        case "env":
          this.envMap(value, at);
          break;
        case "env_files":
          this.each(value, at, (entry, there) => this.envFile(entry, there));
          break;
        case "paths":
          this.each(value, at, (entry, there) => this.pathAddition(entry, there));
          break;
        case "env_scripts":
          this.each(value, at, (entry, there) => this.script(entry, there, false));
          break;
        case "setup":
          this.each(value, at, (entry, there) => this.script(entry, there, true));
          break;
        case "runtime":
          this.runtime(value, at);
          break;
        case "scripts":
          this.scripts(value, at);
          break;
        case "mcp":
          this.mcp(value, at);
          break;
        case "harness":
          this.harness(value, at);
          break;
        case "hooks":
          this.hooks(value, at);
          break;
        case "about":
          this.about(value, at);
          break;
        default:
      }
    }
  }

  /** A skill's name, or a table naming its source. */
  skillEntry(entry: Value, at: string): void {
    if (typeof entry === "string") {
      this.require(validToolName(entry), at);
    } else if (entry instanceof Map) {
      const map = this.object(entry, at, ["name", "source", "ref", "pin"]);
      if (!map) return;
      this.required(map, at, ["name", "source"]);
      for (const [key, value] of map) {
        const there = join(at, key);
        if (key === "name") this.string(value, there, validToolName);
        else if (key === "source") this.string(value, there, (text) => /[^ \t\r\n]/.test(text));
        else if (key === "ref") this.string(value, there, isGitRef);
        else if (key === "pin") this.string(value, there, isDigest);
      }
    } else this.fail("schema", at);
  }

  /** What runs at each event: a script, a table, or false for nothing. */
  hooks(value: Value, at: string): void {
    if (!(value instanceof Map)) {
      this.fail("schema", at);
      return;
    }
    for (const [name, entry] of value) {
      const event = (HOOK_EVENTS as readonly string[]).includes(name) ? (name as HookEventName) : undefined;
      if (event === undefined) {
        this.fail("schema", at);
        continue;
      }
      const here = join(at, name);
      if (entry === false) continue;
      if (typeof entry === "string") this.require(isHookRun(entry), here);
      else if (entry instanceof Map) this.hookTable(event, entry, here);
      else this.fail("schema", here);
    }
  }

  hookTable(event: HookEventName, entry: Document, at: string): void {
    let selects = false;
    let sets = event === "cd";
    let refuses = false;
    if (event === "pre-env" || event === "pre-compact") refuses = true;
    else if (event === "session-start" || event === "pre-tool") [selects, sets, refuses] = [true, true, true];
    else if (event === "prompt") [sets, refuses] = [true, true];
    else if (event === "post-tool") [selects, sets] = [true, false];
    const known = ["run", "timeout", "on_failure"];
    if (selects) known.push("match");
    if (sets) known.push("sets");
    const map = this.object(entry, at, known);
    if (!map) return;
    for (const [key, value] of map) {
      const here = join(at, key);
      if (key === "run") this.string(value, here, isHookRun);
      else if (key === "timeout") this.integer(value, here, 1n, 3600n);
      else if (key === "on_failure") this.string(value, here, (text) => text === "report" || (refuses && text === "refuse"));
      else if (key === "match") {
        const choices =
          event === "session-start"
            ? ["new", "resume", "clear", "compact", "fork"]
            : ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"];
        this.hookList(value, here, (text) => choices.includes(text));
      } else if (key === "sets") this.hookList(value, here, (text) => isVariableName(text) && !isReservedVariable(text));
    }
  }

  /** A list of one or more distinct strings that pass `ok`. */
  hookList(value: Value, at: string, ok: (text: string) => boolean): void {
    if (!Array.isArray(value)) {
      this.fail("schema", at);
      return;
    }
    this.require(value.length > 0, at);
    value.forEach((item, index) => this.string(item, join(at, index), ok));
    this.unique(value, at);
  }

  envMap(value: Value, at: string): void {
    if (!(value instanceof Map)) {
      this.fail("schema", at);
      return;
    }
    for (const [name, entry] of value) {
      const here = join(at, name);
      this.variable(name, here);
      this.require(envValueOk(entry), here);
    }
  }

  envFile(entry: Value, at: string): void {
    if (typeof entry === "string") {
      this.relPath(entry, at);
      return;
    }
    const map = this.object(entry, at, ["path", "format", "os"]);
    if (!map) return;
    this.required(map, at, ["path"]);
    for (const [key, value] of map) {
      const here = join(at, key);
      if (key === "path") this.relPath(value, here);
      else if (key === "format") this.string(value, here, (format) => format === "aos" || format === "dotenv");
      else if (key === "os") this.osList(value, here);
    }
  }

  pathAddition(entry: Value, at: string): void {
    const map = this.object(entry, at, ["variable", "path", "position", "os"]);
    if (!map) return;
    this.required(map, at, ["variable", "path"]);
    for (const [key, value] of map) {
      const here = join(at, key);
      if (key === "variable") this.require(typeof value === "string" && isVariableName(value) && !isReservedVariable(value), here);
      else if (key === "path") this.relPath(value, here);
      else if (key === "position") this.string(value, here, (position) => position === "prepend" || position === "append");
      else if (key === "os") this.osList(value, here);
    }
  }

  script(entry: Value, at: string, setup: boolean): void {
    const known = setup
      ? ["interpreter", "path", "args", "timeout", "network", "os"]
      : ["interpreter", "path", "args", "timeout", "os"];
    const map = this.object(entry, at, known);
    if (!map) return;
    this.required(map, at, ["interpreter", "path"]);
    for (const [key, value] of map) {
      const here = join(at, key);
      if (key === "interpreter") this.string(value, here, (name) => isLowercaseId(name, false));
      else if (key === "path") this.relPath(value, here);
      else if (key === "args") this.each(value, here, (arg, there) => this.string(arg, there, noNul));
      else if (key === "timeout") this.integer(value, here, 0n, 2147483647n);
      else if (key === "network") this.boolean(value, here);
      else if (key === "os") this.osList(value, here);
    }
  }

  runtime(value: Value, at: string): void {
    const map = this.object(value, at, ["os", "commands", "python", "node"]);
    if (!map) return;
    for (const [key, entry] of map) {
      const here = join(at, key);
      if (key === "os") this.osList(entry, here);
      else if (key === "commands") {
        this.each(entry, here, (command, there) => {
          if (typeof command === "string") this.string(command, there, isCommandName);
          else {
            const table = this.object(command, there, ["name", "os"]);
            if (!table) return;
            this.required(table, there, ["name"]);
            const name = table.get("name");
            if (name !== undefined) this.string(name, join(there, "name"), isCommandName);
            const os = table.get("os");
            if (os !== undefined) this.osList(os, join(there, "os"));
          }
        });
      } else if (key === "python") this.each(entry, here, (variant, there) => this.variant(variant, there, true));
      else if (key === "node") this.each(entry, here, (variant, there) => this.variant(variant, there, false));
    }
  }

  variant(value: Value, at: string, python: boolean): void {
    const known = python
      ? ["version", "requirements", "lock", "lock_digest", "environment", "os"]
      : ["version", "package", "environment", "os"];
    const map = this.object(value, at, known);
    if (!map) return;
    if (map.has("requirements") && map.has("lock")) this.fail("schema", at);
    if (map.has("lock_digest") && !map.has("lock")) this.fail("schema", at);
    for (const [key, entry] of map) {
      const here = join(at, key);
      if (key === "version") this.string(entry, here, isVersion);
      else if (key === "requirements" || key === "lock") this.relPath(entry, here);
      else if (key === "lock_digest") this.string(entry, here, isDigest);
      else if (key === "environment") this.string(entry, here, isEnvironmentName);
      else if (key === "package") {
        this.string(entry, here, (path) => validRelativePath(path) && (path === "package.json" || path.endsWith("/package.json")));
      } else if (key === "os") this.osList(entry, here);
    }
  }

  scripts(value: Value, at: string): void {
    if (!(value instanceof Map)) {
      this.fail("schema", at);
      return;
    }
    for (const [name, target] of value) {
      const here = join(at, name);
      this.require(isCommandNameStrict(name) && !asciiLower(name).endsWith(".exe"), here);
      let fine = false;
      if (target === false) fine = true;
      else if (typeof target === "string") fine = isScriptPath(target) && SCRIPT_EXTENSIONS.some((e) => target.endsWith(e));
      else if (target instanceof Map) {
        const path = target.get("path");
        const interpreter = target.get("interpreter");
        const os = target.get("os");
        fine =
          [...target.keys()].every((key) => key === "path" || key === "interpreter" || key === "os") &&
          typeof path === "string" &&
          isScriptPath(path) &&
          typeof interpreter === "string" &&
          isLowercaseId(interpreter, false) &&
          (os === undefined || osListOk(os));
      }
      this.require(fine, here);
    }
  }

  mcp(value: Value, at: string): void {
    const map = this.object(value, at, ["servers", "skills"]);
    if (!map) return;
    const servers = map.get("servers");
    if (servers !== undefined) this.each(servers, join(at, "servers"), (server, there) => this.server(server, there));
    const skills = map.get("skills");
    if (skills !== undefined) {
      this.each(skills, join(at, "skills"), (link, there) => {
        const table = this.object(link, there, ["name", "server"]);
        if (!table) return;
        this.required(table, there, ["name", "server"]);
        for (const [key, entry] of table) this.string(entry, join(there, key), validToolName);
      });
    }
  }

  server(value: Value, at: string): void {
    const known = ["name", "transport", "timeout", "command", "args", "env", "env_passthrough", "url", "headers_env"];
    const map = this.object(value, at, known);
    if (!map) return;
    this.required(map, at, ["name", "transport"]);
    const transport = map.get("transport");
    let misshapen = false;
    if (transport === "stdio") misshapen = !map.has("command") || map.has("url") || map.has("headers_env");
    else if (transport === "streamable-http") {
      misshapen = !map.has("url") || ["command", "args", "env", "env_passthrough"].some((key) => map.has(key));
    }
    if (misshapen) this.fail("schema", at);
    for (const [key, entry] of map) {
      const here = join(at, key);
      if (key === "name") this.string(entry, here, validToolName);
      else if (key === "transport") this.string(entry, here, (text) => text === "stdio" || text === "streamable-http");
      else if (key === "timeout") {
        const seconds = typeof entry === "bigint" || typeof entry === "number" ? Number(entry) : undefined;
        this.require(seconds !== undefined && seconds >= 0.001 && seconds <= 2147483647, here);
      } else if (key === "command") this.string(entry, here, (command) => command !== "" && noNul(command));
      else if (key === "args") this.each(entry, here, (arg, there) => this.string(arg, there, noNul));
      else if (key === "env") this.envMap(entry, here);
      else if (key === "env_passthrough") {
        this.each(entry, here, (name, there) => this.string(name, there, isVariableName));
        this.unique(entry, here);
      } else if (key === "url") this.string(entry, here, isMcpUrl);
      else if (key === "headers_env") {
        if (entry instanceof Map) {
          for (const [header, variable] of entry) {
            this.require(isHeaderName(header) && typeof variable === "string" && isVariableName(variable), join(here, header));
          }
        } else this.fail("schema", here);
      }
    }
  }

  harness(value: Value, at: string): void {
    if (!(value instanceof Map)) {
      this.fail("schema", at);
      return;
    }
    for (const [id, hints] of value) {
      const here = join(at, id);
      this.require(isLowercaseId(id, true), here);
      if (!(hints instanceof Map)) {
        this.fail("schema", here);
        continue;
      }
      for (const [key, entry] of hints) {
        const there = join(here, key);
        if (key === "context") this.each(entry, there, (path, deeper) => this.relPath(path, deeper));
        else if (key === "skills") this.boolean(entry, there);
        else if (key === "model" || key === "effort") this.string(entry, there, (text) => text !== "");
      }
    }
  }

  about(value: Value, at: string): void {
    const known = ["summary", "icon", "homepage", "repository", "license", "authors", "tags"];
    const map = this.object(value, at, known);
    if (!map) return;
    for (const [key, entry] of map) {
      const here = join(at, key);
      if (key === "summary") this.string(entry, here, isLine);
      else if (key === "icon") {
        this.string(entry, here, (path) => {
          const lower = asciiLower(path);
          return validRelativePath(path) && (lower.endsWith(".png") || lower.endsWith(".webp"));
        });
      } else if (key === "homepage" || key === "repository") this.string(entry, here, isWebUrl);
      else if (key === "license") {
        this.string(entry, here, (license) => /^[A-Za-z0-9.+:() -]+$/.test(license));
        if (typeof entry === "string" && !validLicense(entry)) this.fail("license-expression", here);
      } else if (key === "authors") this.each(entry, here, (author, there) => this.string(author, there, isLine));
      else if (key === "tags") {
        this.each(entry, here, (tag, there) =>
          this.string(
            tag,
            there,
            (text) => [...text].length <= 32 && text !== "" && text.split("-").every((run) => /^[a-z0-9]+$/.test(run)),
          ),
        );
        this.unique(entry, here);
      }
    }
  }
}

/** Whether `entry` is exactly one form of env value. */
export function envValueOk(entry: Value): boolean {
  const forms = [
    typeof entry === "string" && noNul(entry),
    objectForm(entry, "value", ["if_unset"], (text) => typeof text === "string" && noNul(text)),
    objectForm(entry, "path", ["if_unset"], (path) => typeof path === "string" && validRelativePath(path)),
    objectForm(entry, "secret", ["if_unset", "optional"], (name) => typeof name === "string" && name !== ""),
    providerForm(entry),
  ];
  return forms.filter(Boolean).length === 1;
}

function objectForm(entry: Value, source: string, flags: readonly string[], ok: (value: Value) => boolean): boolean {
  if (!(entry instanceof Map)) return false;
  const found = entry.get(source);
  if (found === undefined || !ok(found)) return false;
  for (const [key, value] of entry) {
    if (key !== source && !(flags.includes(key) && typeof value === "boolean")) return false;
  }
  return true;
}

function providerForm(entry: Value): boolean {
  if (!(entry instanceof Map)) return false;
  const provider = entry.get("provider");
  const key = entry.get("key");
  if (typeof provider !== "string" || typeof key !== "string") return false;
  const providerOk = /^[a-z][a-z0-9_-]*$/.test(provider);
  const keyOk =
    key !== "" && noNul(key) && (provider === "file" ? validRelativePath(key) : provider === "env" ? isVariableName(key) : true);
  if (!providerOk || !keyOk) return false;
  for (const [field, value] of entry) {
    if (field === "provider" || field === "key") continue;
    if (field === "if_unset" || field === "optional") {
      if (typeof value !== "boolean") return false;
    } else if (field === "value" || field === "path" || field === "secret") return false;
    else if (!(typeof value === "string" || typeof value === "bigint" || typeof value === "boolean")) return false;
  }
  return true;
}

/** The rules JSON Schema cannot state. */
export function semantic(doc: Document, check: Check): void {
  declared(doc, "requires").forEach((name, index) => {
    if (typeof name === "string" && overlayNameShaped(name) && !validOverlayName(name)) {
      check.fail("reserved-name", `/requires/${index}`);
    }
  });
  const envNames = new Set<string>();
  const env = doc.get("env");
  if (env instanceof Map) {
    for (const name of env.keys()) {
      if (envNames.has(asciiUpper(name))) check.fail("env-name-case-duplicate", `/env/${token(name)}`);
      envNames.add(asciiUpper(name));
      if (isReservedVariable(name)) check.fail("reserved-variable", `/env/${token(name)}`);
    }
  }
  declared(doc, "paths").forEach((entry, index) => {
    const variable = memberText(entry, "variable");
    if (variable === undefined) return;
    if (envNames.has(asciiUpper(variable))) check.fail("env-path-conflict", `/paths/${index}/variable`);
    if (isReservedVariable(variable)) check.fail("reserved-variable", `/paths/${index}/variable`);
  });
  skills(doc, check);
  manifestNamed(doc, check);
  const mcp = doc.get("mcp");
  if (!(mcp instanceof Map)) return;
  const servers = declared(mcp, "servers");
  const names = new Set<string>();
  servers.forEach((server, index) => {
    if (!(server instanceof Map)) return;
    const name = canon(server.get("name"));
    if (names.has(name)) check.fail("mcp-duplicate-server", `/mcp/servers/${index}/name`);
    names.add(name);
    const command = server.get("command");
    if (typeof command === "string" && /[/\\]/.test(command) && !validRelativePath(command)) {
      check.fail("mcp-command", `/mcp/servers/${index}/command`);
    }
    const url = server.get("url");
    if (typeof url === "string") {
      const split = url.indexOf("://");
      const after = split === -1 ? url : url.slice(split + 3);
      const authority = after.split("/")[0] ?? "";
      if (url.includes("#") || authority.includes("@")) check.fail("mcp-url", `/mcp/servers/${index}/url`);
    }
    const serverEnv = server.get("env");
    if (serverEnv instanceof Map) {
      const seen = new Set<string>();
      for (const variable of serverEnv.keys()) {
        if (isReservedVariable(variable)) check.fail("reserved-variable", `/mcp/servers/${index}/env/${token(variable)}`);
        if (seen.has(asciiUpper(variable))) check.fail("env-name-case-duplicate", `/mcp/servers/${index}/env/${token(variable)}`);
        seen.add(asciiUpper(variable));
      }
    }
  });
  const linked = new Set<string>();
  declared(mcp, "skills").forEach((link, index) => {
    if (!(link instanceof Map)) return;
    const name = canon(link.get("name"));
    if (linked.has(name)) check.fail("mcp-duplicate-skill", `/mcp/skills/${index}/name`);
    linked.add(name);
    if (!names.has(canon(link.get("server")))) check.fail("mcp-unknown-server", `/mcp/skills/${index}/server`);
  });
}

/** The name of an entry of `skills`: the string, or a table's `name`. */
export function skillName(entry: Value): string | undefined {
  return entry instanceof Map ? memberText(entry, "name") : typeof entry === "string" ? entry : undefined;
}

/** The pointer of an entry's name: the entry, or the `name` of a table. */
export function skillAt(entry: Value, index: number): string {
  return entry instanceof Map ? `/skills/${index}/name` : `/skills/${index}`;
}

/** The rules of `skills` that need no files: names, and what a table's source may be. */
function skills(doc: Document, check: Check): void {
  const seen = new Set<string>();
  declared(doc, "skills").forEach((entry, index) => {
    const name = skillName(entry);
    if (name === undefined) return;
    const at = skillAt(entry, index);
    if (validToolName(name) && !validRelativePath(name)) check.fail("skill-name", at);
    if (seen.has(name.toLowerCase())) check.fail("skill-duplicate", at);
    seen.add(name.toLowerCase());
    const source = entry instanceof Map ? entry.get("source") : undefined;
    if (!(entry instanceof Map) || typeof source !== "string") return;
    const there = `/skills/${index}`;
    let parsed: Source;
    try {
      parsed = Source.parse(source);
    } catch {
      check.fail("invalid-source", `${there}/source`);
      return;
    }
    if (parsed.isLocal()) check.fail("local-source", `${there}/source`);
    else if (parsed.kind === "url" && !parsed.isWebUrl()) check.fail("invalid-source", `${there}/source`);
    else if (parsed.holdsCredentials()) check.fail("source-credentials", `${there}/source`);
    if (entry.has("ref") && (parsed.kind !== "git" || parsed.reference !== undefined)) {
      check.fail("ref-not-allowed", `${there}/ref`);
    }
  });
}

/** A manifest is never another field's file: only `context` names `OVERLAY.md`, for its body, and nothing names `overlay.cfg`. */
function manifestNamed(doc: Document, check: Check): void {
  for (const [at, path] of namedFilesOf(doc)) {
    const isContext = at.startsWith("/context/") || (at.startsWith("/harness/") && at.includes("/context/"));
    if (path === "overlay.cfg" || (path === "OVERLAY.md" && !isContext)) check.fail("manifest-file", at);
  }
}

/** Every `[pointer, relative path]` of a file a field requires to exist. */
export function namedFilesOf(doc: Document): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const each = (key: string, field: string | undefined): void => {
    declared(doc, key).forEach((item, index) => {
      if (field === undefined && typeof item === "string") out.push([`/${key}/${index}`, item]);
      else if (item instanceof Map) {
        const name = field ?? "path";
        const path = item.get(name);
        if (typeof path === "string") out.push([`/${key}/${index}/${name}`, path]);
      }
    });
  };
  each("rules", undefined);
  each("context", undefined);
  each("env_files", undefined);
  each("env_scripts", "path");
  each("setup", "path");
  const runtime = doc.get("runtime");
  if (runtime instanceof Map) {
    for (const [runtimeName, fields] of [
      ["python", ["requirements", "lock"]],
      ["node", ["package"]],
    ] as const) {
      declared(runtime, runtimeName).forEach((variant, index) => {
        for (const field of fields) {
          const path = memberText(variant, field);
          if (path !== undefined) out.push([`/runtime/${runtimeName}/${index}/${field}`, path]);
        }
      });
    }
  }
  const hooks = doc.get("hooks");
  if (hooks instanceof Map) {
    for (const [event, entry] of hooks) {
      if (typeof entry === "string") out.push([`/hooks/${token(event)}`, entry]);
      else {
        const run = memberText(entry, "run");
        if (run !== undefined) out.push([`/hooks/${token(event)}/run`, run]);
      }
    }
  }
  const scripts = doc.get("scripts");
  if (scripts instanceof Map) {
    for (const [name, target] of scripts) {
      if (typeof target === "string") out.push([`/scripts/${token(name)}`, target]);
      else {
        const path = memberText(target, "path");
        if (path !== undefined) out.push([`/scripts/${token(name)}/path`, path]);
      }
    }
  }
  const harness = doc.get("harness");
  if (harness instanceof Map) {
    for (const [id, hints] of harness) {
      declared(hints, "context").forEach((path, index) => {
        if (typeof path === "string") out.push([`/harness/${token(id)}/context/${index}`, path]);
      });
    }
  }
  const icon = memberText(doc.get("about"), "icon");
  if (icon !== undefined) out.push(["/about/icon", icon]);
  return out;
}

/** Whether one informational field of `about` is valid; an unknown field is not. */
export function aboutFieldValid(field: string, value: Value): boolean {
  const check = new Check();
  check.about(new Map([[field, value]]), "/about");
  return check.issues.length === 0;
}

/** Whether one field of a catalog's own (`name`, `description`, `homepage`) is valid. */
export function catalogFieldValid(field: string, value: Value): boolean {
  if (typeof value !== "string") return false;
  if (field === "name") return isLine(value);
  if (field === "description") return true;
  if (field === "homepage") return isWebUrl(value);
  return false;
}

/** How deep parentheses may nest in a license expression: past it the text is no expression. */
const LICENSE_DEPTH = 128;

const idChars = (text: string): boolean => /^[A-Za-z0-9.-]+$/.test(text);

function reference(text: string, kind: string): boolean {
  let rest = text;
  if (text.startsWith("DocumentRef-")) {
    const body = text.slice("DocumentRef-".length);
    const colon = body.indexOf(":");
    if (colon !== -1) {
      if (!idChars(body.slice(0, colon))) return false;
      rest = body.slice(colon + 1);
    }
  }
  return rest.startsWith(kind) && idChars(rest.slice(kind.length));
}

/** Whether `expression` is an SPDX license expression: identifiers and `LicenseRef-` references, `+`, `WITH`, `AND` and `OR` in upper case, and parentheses. */
export function validLicense(expression: string): boolean {
  if (!/^[A-Za-z0-9.+:() -]+$/.test(expression)) return false;
  const tokens: string[] = [];
  let word = "";
  for (const c of expression) {
    if (c === "(" || c === ")" || c === " ") {
      if (word !== "") tokens.push(word);
      word = "";
      if (c !== " ") tokens.push(c);
    } else word += c;
  }
  if (word !== "") tokens.push(word);
  const parser = new License(tokens);
  return parser.compound() && parser.at === tokens.length;
}

class License {
  at = 0;
  depth = 0;
  private readonly tokens: readonly string[];
  constructor(tokens: readonly string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.at];
  }

  private take(): string | undefined {
    const token = this.tokens[this.at];
    this.at += 1;
    return token;
  }

  private licenseOrGroup(): boolean {
    const token = this.take();
    if (token === "(") {
      this.depth += 1;
      const closed = this.depth <= LICENSE_DEPTH && this.compound() && this.take() === ")";
      this.depth -= 1;
      return closed;
    }
    if (token === undefined || token === "AND" || token === "OR" || token === "WITH" || token === ")") return false;
    const license = reference(token, "LicenseRef-") || idChars(token.endsWith("+") ? token.slice(0, -1) : token);
    if (!license) return false;
    if (this.peek() === "WITH") {
      this.take();
      const exception = this.take();
      return exception !== undefined && (idChars(exception) || reference(exception, "AdditionRef-"));
    }
    return true;
  }

  private term(): boolean {
    if (!this.licenseOrGroup()) return false;
    while (this.peek() === "AND") {
      this.take();
      if (!this.licenseOrGroup()) return false;
    }
    return true;
  }

  compound(): boolean {
    if (!this.term()) return false;
    while (this.peek() === "OR") {
      this.take();
      if (!this.term()) return false;
    }
    return true;
  }
}
