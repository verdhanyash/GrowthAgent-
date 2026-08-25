/**
 * ImpossibleStateError (gatekeeper.md §4) — thrown ONLY when an internal
 * invariant that the type system cannot express is violated (programmer bug).
 * Hostile/malformed INPUT never reaches this path — it becomes a FAIL rule
 * entry instead (fail closed, not crash). safelyEvaluate re-throws it loudly.
 */
export class ImpossibleStateError extends Error {}
