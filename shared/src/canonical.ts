/**
 * Canonical JSON — sorted object keys, array order preserved, numbers via
 * Number.prototype.toString() (negotiation.md §1.4). The input to every
 * content hash in the system (pack hashes, gatekeeper input_digest), so the
 * serialization itself must be total and deterministic: non-finite numbers
 * serialize as `null` (JSON.stringify parity) and `undefined` object values
 * are skipped, matching standard JSON semantics.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value === true ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    // NaN/Infinity/-Infinity -> null (JSON.stringify parity); safe ints and
    // pre-rounded decimals alike render via toString (no float drift for the
    // exact-binary / pre-rounded numerics this codebase stores).
    return Number.isFinite(n) ? String(n) : "null";
  }
  if (t === "string") return JSON.stringify(value as string);
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const body = keys
      .map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`)
      .join(",");
    return `{${body}}`;
  }
  // bigint / function / symbol: outside the JSON domain — deterministic error.
  throw new TypeError(`canonicalJson cannot serialize ${t}`);
}
