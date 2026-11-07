/**
 * The data model every format reads into: a mapping (a `Map`, in the document's order), a list,
 * text, a boolean, an integer (a `bigint`, in the signed 64-bit range) or a float (a finite
 * `number`). A `bigint` and a `number` never mean the same thing: `30` is `30n` and `30.0` is `30`.
 * There is no null.
 */
export type Value = boolean | bigint | number | string | Value[] | Document;

/** A mapping: keys are text, order is the document's. */
export type Document = Map<string, Value>;

/** Whether `value` is a mapping. */
export function isDocument(value: unknown): value is Document {
  return value instanceof Map;
}

/** Whether `value` is a list. */
export function isList(value: unknown): value is Value[] {
  return Array.isArray(value);
}

/** Whether `value` is an integer. */
export function isInteger(value: unknown): value is bigint {
  return typeof value === "bigint";
}

/** The value in plain JavaScript: mappings as objects with a null prototype, integers as `bigint`. */
export function toPlain(value: Value): unknown {
  if (value instanceof Map) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of value) {
      Object.defineProperty(out, key, { value: toPlain(item), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(toPlain);
  return value;
}

/** Structural equality. A mapping's order does not matter; an integer never equals a float. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, item] of a) {
      if (!b.has(key) || !valuesEqual(item, b.get(key))) return false;
    }
    return true;
  }
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, at) => valuesEqual(item, b[at]));
  }
  if (typeof a !== typeof b) return false;
  return a === b;
}

/** A value from a `JSON.parse` result, for tests and callers that hold plain JSON: whole numbers become integers. */
export function fromPlain(plain: unknown): Value {
  if (Array.isArray(plain)) return plain.map(fromPlain);
  if (plain !== null && typeof plain === "object") {
    const out: Document = new Map();
    for (const key of Object.keys(plain)) out.set(key, fromPlain((plain as Record<string, unknown>)[key]));
    return out;
  }
  if (typeof plain === "number" && Number.isInteger(plain)) return BigInt(plain);
  if (plain === null || plain === undefined) throw new TypeError("a null is not a value");
  return plain as Value;
}
