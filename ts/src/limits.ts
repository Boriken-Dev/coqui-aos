/** A bound: a whole number, 0 or more, or `null` for no bound. */
export type Limit = number | null;

/** No bound. */
export const UNBOUNDED: Limit = null;

/** Whether `n` is within `limit`. A number that is not a non-negative safe integer never is. */
export function allows(limit: Limit, n: number | bigint): boolean {
  if (typeof n === "number" ? !(n >= 0) : n < 0n) return false;
  return limit === null || n <= limit;
}

/** A limit as text: the number, or `none`. */
export function limitText(limit: Limit): string {
  return limit === null ? "none" : String(limit);
}

const MIB = 1024 * 1024;

/** Every setting's key (as a configuration file writes it), field and default. */
const DEFINITIONS = [
  ["manifest_bytes", "manifestBytes", MIB],
  ["manifest_depth", "manifestDepth", 64],
  ["tree_files", "treeFiles", 4096],
  ["tree_depth", "treeDepth", 64],
  ["tree_bytes", "treeBytes", 64 * MIB],
  ["file_bytes", "fileBytes", 16 * MIB],
  ["context_bytes", "contextBytes", MIB],
  ["catalog_bytes", "catalogBytes", 4 * MIB],
  ["icon_bytes", "iconBytes", 512 * 1024],
  ["icon_width", "iconWidth", 1024],
  ["icon_height", "iconHeight", 1024],
  ["hook_timeout", "hookTimeout", 60],
  ["hook_event_timeout", "hookEventTimeout", 120],
  ["hook_output_bytes", "hookOutputBytes", 64 * 1024],
  ["hook_payload_bytes", "hookPayloadBytes", MIB],
  ["hook_reason_chars", "hookReasonChars", 1024],
  ["substitution_bytes", "substitutionBytes", MIB],
  ["substitution_depth", "substitutionDepth", 32],
  ["substitution_steps", "substitutionSteps", 10_000_000],
] as const;

type Field = (typeof DEFINITIONS)[number][1];

/** A setting that differs from its default, as data: never a document's text. */
export interface NonDefault {
  /** The setting's key as a configuration file writes it, such as `manifest_bytes`. */
  readonly setting: string;
  readonly value: string;
  readonly default: string;
}

/** The fields' type: every bound, each a {@link Limit}. */
export type SettingsValues = { readonly [K in Field]: Limit };

/**
 * Every bound the library applies, each with a default and no floor. Immutable: `with` returns a
 * changed copy. `nonDefaults()` lists the ones that differ, so a caller can report them.
 */
export class Settings implements SettingsValues {
  readonly manifestBytes!: Limit;
  readonly manifestDepth!: Limit;
  readonly treeFiles!: Limit;
  readonly treeDepth!: Limit;
  readonly treeBytes!: Limit;
  readonly fileBytes!: Limit;
  readonly contextBytes!: Limit;
  readonly catalogBytes!: Limit;
  readonly iconBytes!: Limit;
  readonly iconWidth!: Limit;
  readonly iconHeight!: Limit;
  readonly hookTimeout!: Limit;
  readonly hookEventTimeout!: Limit;
  readonly hookOutputBytes!: Limit;
  readonly hookPayloadBytes!: Limit;
  readonly hookReasonChars!: Limit;
  readonly substitutionBytes!: Limit;
  readonly substitutionDepth!: Limit;
  readonly substitutionSteps!: Limit;

  constructor(changes: Partial<SettingsValues> = {}) {
    for (const [, field, byDefault] of DEFINITIONS) {
      const given = changes[field];
      const limit = given === undefined ? byDefault : given;
      if (limit !== null && !(Number.isSafeInteger(limit) && limit >= 0)) {
        throw new RangeError(`${field}: a whole number, 0 or more, or null for no bound`);
      }
      (this as { -readonly [K in Field]: Limit })[field] = limit;
    }
    Object.freeze(this);
  }

  /** A copy with these bounds changed. */
  with(changes: Partial<SettingsValues>): Settings {
    return new Settings({ ...this.values(), ...changes });
  }

  /** The bounds as a plain object. */
  values(): SettingsValues {
    const out: Partial<Record<Field, Limit>> = {};
    for (const [, field] of DEFINITIONS) out[field] = this[field];
    return out as SettingsValues;
  }

  /** Reads settings as a configuration writes them (a plain object or a `Map` such as `readDocument` returns): snake_case keys, a number or `bigint`, `null` or `"none"`. An unknown key is refused without naming it. */
  static fromData(data: Record<string, unknown> | ReadonlyMap<string, unknown>): Settings {
    const changes: Partial<Record<Field, Limit>> = {};
    const entries = data instanceof Map ? [...data.entries()] : Object.entries(data);
    for (const [key, value] of entries) {
      const definition = DEFINITIONS.find(([name]) => name === key);
      if (definition === undefined) throw new RangeError("unknown setting");
      let limit: unknown = value;
      if (value === "none") limit = null;
      else if (typeof value === "bigint") limit = value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.NaN : Number(value);
      changes[definition[1]] = limit as Limit;
    }
    return new Settings(changes);
  }

  /** Every setting that differs from its default. */
  nonDefaults(): NonDefault[] {
    const out: NonDefault[] = [];
    for (const [setting, field, byDefault] of DEFINITIONS) {
      if (this[field] !== byDefault) {
        out.push({ setting, value: limitText(this[field]), default: limitText(byDefault) });
      }
    }
    return out;
  }
}

/** The default settings. */
export const DEFAULT_SETTINGS: Settings = new Settings();
