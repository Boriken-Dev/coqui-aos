/** Names: overlay identities, variables, relative paths and operating systems. */

/** Path components an overlay never carries: version-control and tool caches. */
export const EXCLUDED_COMPONENTS: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "node_modules",
];

const RESERVED_NAMES = ["default", "overlay", "system", "user", "project", "project-root"];

/** ASCII-only lowercase: no other letter changes. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** ASCII-only uppercase. */
export function asciiUpper(text: string): string {
  return text.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** Whether `name` is a valid overlay identity. */
export function validOverlayName(name: string): boolean {
  if (!overlayNameShaped(name)) return false;
  const lower = asciiLower(name);
  const stem = lower.split(".")[0] ?? "";
  return !RESERVED_NAMES.includes(lower) && !isDeviceStem(stem, false);
}

/** An identity's shape alone: a letter first, then letters, digits, `_`, `.` and `-`, ending in a letter or digit. */
export function overlayNameShaped(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) && /[A-Za-z0-9]$/.test(name);
}

/** The identity compared: ASCII lowercase, `_` and `.` made `-`. */
export function normalizeName(name: string): string {
  return asciiLower(name.replace(/[_.]/g, "-"));
}

/** `NAME_OVERLAY_ROOT`. */
export function rootVariable(identity: string): string {
  return `${asciiUpper(normalizeName(identity)).replace(/[^A-Z0-9]/g, "_")}_OVERLAY_ROOT`;
}

/** `NAME_OVERLAY_STATE`. */
export function stateVariable(identity: string): string {
  const root = rootVariable(identity);
  return `${root.slice(0, root.length - "ROOT".length)}STATE`;
}

/** Whether `name` is an environment variable's name: `[A-Za-z_][A-Za-z0-9_]*`. */
export function isVariableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Whether a variable is the specification's own: `AOS_*`, `*_OVERLAY_ROOT`, `*_OVERLAY_STATE`. */
export function isReservedVariable(name: string): boolean {
  const upper = asciiUpper(name);
  return upper.startsWith("AOS_") || upper.endsWith("_OVERLAY_ROOT") || upper.endsWith("_OVERLAY_STATE");
}

const SENSITIVE_NAMES = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "SHELL",
  "COMSPEC",
  "SYSTEMROOT",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "PROMPT_COMMAND",
  "IFS",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "LESSOPEN",
  "LESSCLOSE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PSMODULEPATH",
  "CLASSPATH",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "RUSTFLAGS",
  "GOPROXY",
  "GONOSUMDB",
  "GONOSUMCHECK",
  "GOPRIVATE",
  "GOFLAGS",
  "SSH_ASKPASS",
  "SSLKEYLOGFILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
]);

const SENSITIVE_PREFIXES = [
  "LD_",
  "DYLD_",
  "GIT_",
  "PYTHON",
  "NODE_",
  "NPM_CONFIG_",
  "PIP_",
  "UV_",
  "CARGO_",
  "RUSTC_",
  "DOTNET_",
  "COR_",
  "CORECLR_",
  "SSL_",
];

/** Whether a variable changes how a program loads code or where it talks: needs the user's say-so. */
export function isSensitiveVariable(name: string): boolean {
  const upper = asciiUpper(name);
  return (
    SENSITIVE_NAMES.has(upper) ||
    SENSITIVE_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    upper.endsWith("_PROXY") ||
    upper.endsWith("_BASE_URL")
  );
}

/** Whether a variable is a list of directories joined by the platform's separator. */
export function isPathVariable(name: string): boolean {
  const upper = asciiUpper(name);
  return upper === "PATH" || upper === "PYTHONPATH" || upper === "NODE_PATH";
}

function refusedInComponent(c: string): boolean {
  return /[\\:*?"<>|\u0000-\u001f\u007f-\u009f‌-‏‪-‮⁦-⁯﻿]/u.test(c);
}

function isDeviceStem(stem: string, console: boolean): boolean {
  if (["con", "prn", "aux", "nul"].includes(stem)) return true;
  if (console && (stem === "conin$" || stem === "conout$")) return true;
  const digits = console ? "0123456789¹²³" : "123456789";
  for (const prefix of ["com", "lpt"]) {
    if (stem.startsWith(prefix)) {
      const rest = [...stem.slice(prefix.length)];
      if (rest.length === 1 && digits.includes(rest[0]!)) return true;
    }
  }
  return false;
}

function validComponent(component: string): boolean {
  if (component === "" || component.endsWith(".") || component.endsWith(" ") || refusedInComponent(component)) {
    return false;
  }
  const lower = asciiLower(component);
  if (EXCLUDED_COMPONENTS.includes(lower) || lower.endsWith(".pyc")) return false;
  return !isDeviceStem(lower.split(".")[0] ?? "", true);
}

/** Whether `path` is a relative path an overlay may name: `/`-separated, no component that a platform or a tool reserves. */
export function validRelativePath(path: string): boolean {
  return path !== "" && !/~[0-9]/.test(path) && path.split("/").every(validComponent);
}

/** An operating system's name shape: lowercase letters, digits and `-`, a letter first. */
export function validOsName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

const UNIX_NAMES = ["macos", "linux", "freebsd", "openbsd", "netbsd"];

/** Whether the current operating system is one of `names` (`undefined` means every one; `unix` is every Unix). */
export function osMatches(names: readonly string[] | undefined, current: string): boolean {
  if (names === undefined) return true;
  return names.some((name) => name === current || (name === "unix" && current !== "windows" && UNIX_NAMES.includes(current)));
}

/** The running operating system's name as the specification writes it; `""` where there is no `process`. */
export function currentOs(): string {
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform ?? "";
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "android":
      return "linux";
    default:
      return platform;
  }
}

/** A tool's name shape: letters and digits first, then `_`, `.` and `-`. */
export function validToolName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}
