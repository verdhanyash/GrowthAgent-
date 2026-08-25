/**
 * Pure ISO-8601 timestamp helpers for the gatekeeper (documented addition to
 * gatekeeper.md §2 module layout). `Date.parse` on an ISO STRING is
 * deterministic — it consults no clock — so purity (invariant I-1) holds.
 * Unparseable timestamps yield NaN; callers MUST treat NaN as fail-closed,
 * never crash (hostile input becomes a rule FAIL, not an exception).
 */

/** Epoch milliseconds for an ISO timestamp, or NaN when unparseable. */
export function isoToEpochMs(iso: string): number {
  return Date.parse(iso);
}

/**
 * Expired iff sell_by lies STRICTLY before `now` (equality = last sellable
 * instant). Chosen boundary: merchants expect "sell through the day of" to
 * hold until the instant passes; documented here so tests pin it.
 */
export function isExpired(sellByIso: string | null, nowIso: string): boolean {
  if (sellByIso === null) return false;
  const sellBy = isoToEpochMs(sellByIso);
  const now = isoToEpochMs(nowIso);
  if (Number.isNaN(sellBy)) return true; // corrupt timestamp => fail closed
  if (Number.isNaN(now)) return true; // corrupt clock input => fail closed
  return sellBy < now;
}

/**
 * Near-expiry iff sell_by falls within `horizonDays` of `now` (and not
 * already expired). Display/evidence classification only — near-expiry is
 * the campaign system's JOB to sell, so it never blocks (gatekeeper.md §10).
 */
export function isNearExpiry(
  sellByIso: string | null,
  nowIso: string,
  horizonDays = 7,
): boolean {
  if (sellByIso === null || isExpired(sellByIso, nowIso)) return false;
  const sellBy = isoToEpochMs(sellByIso);
  const now = isoToEpochMs(nowIso);
  if (Number.isNaN(sellBy) || Number.isNaN(now)) return false;
  return sellBy - now <= horizonDays * 86_400_000;
}
