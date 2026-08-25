/**
 * Freeze helpers for the purity tests (gatekeeper.md §16.2): every spec
 * deep-freezes inputs; any mutation attempt throws in strict mode.
 */

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Structured clone without structuredClone's prototype loss concerns —
 *  JSON-based is fine here because every fixture is plain JSON data. */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
