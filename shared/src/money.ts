/**
 * Integer-paise money primitives — THE single money-math implementation for
 * GrowthAgent (gatekeeper.md §8, invariant I-3).
 *
 * Discipline:
 *  - All money is INTEGER PAISE (matches Razorpay Orders `amount` semantics).
 *  - Percentages become integer basis points EXACTLY ONCE via toBps() at load.
 *  - The single HALF_UP rounding event in the system is the bundle-discount
 *    amount (mulDivRoundHalfUp); per-line allocation is largest-remainder and
 *    conserves paise exactly (Σalloc === discount).
 *  - Margin comparison is cross-multiplied integers — never a division/float:
 *      margin holds  <=>  M * 10000 >= floorBps * N        (valid while N > 0)
 *  - Every limit is an inclusive ceiling/floor: exactly-at-limit PASSES,
 *    limit+1 FAILS. Enforced by the boundary test matrix (gatekeeper.md §13).
 */

/** Throws on any non-safe-integer (NaN, ±Infinity, float, >2^53-1). */
export function assertSafeInt(n: number, label = "value"): number {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${label} must be a safe integer, got ${String(n)}`);
  }
  return n;
}

/** Percent (e.g. 7.5) -> integer basis points (750). ONE conversion point. */
export function toBps(pct: number): number {
  if (!Number.isFinite(pct)) {
    throw new RangeError(`percent must be finite, got ${String(pct)}`);
  }
  return Math.round(pct * 100);
}

/**
 * round_half_up(a*b/c) for non-negative safe integers — the ONLY rounding
 * event allowed in the money path (applied to the bundle-discount amount).
 */
export function mulDivRoundHalfUp(a: number, b: number, c: number): number {
  assertSafeInt(a, "a");
  assertSafeInt(b, "b");
  assertSafeInt(c, "c");
  if (c <= 0) throw new RangeError("divisor must be positive");
  const p = a * b;
  assertSafeInt(p, "a*b");
  const q = Math.floor(p / c);
  const r = p - q * c;
  return r * 2 >= c ? q + 1 : q;
}

/**
 * Split `total` across weights proportionally; Σ(out) === total ALWAYS
 * (largest-remainder method; ties broken by ascending line index).
 * Degenerate all-zero-weight case (documented, gatekeeper.md §19.4): line 1
 * takes the whole total.
 */
export function allocateProportionally(
  total: number,
  weights: readonly number[],
): number[] {
  assertSafeInt(total, "total");
  if (weights.length === 0) return [];
  const wSum = weights.reduce((s, w) => s + assertSafeInt(w, "weight"), 0);
  assertSafeInt(wSum, "Σweights");
  if (wSum <= 0) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  // Exact rationals rendered as doubles for RANKING only; bases are floors so
  // Σbase <= total and leftover < weights.length (provably).
  const raw = weights.map((w) => (total * w) / wSum);
  const base = raw.map((x) => Math.floor(x));
  let leftover = total - base.reduce((s, b) => s + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((p, q) => q.frac - p.frac || p.i - q.i);
  const out = base.slice();
  for (const { i } of order) {
    if (leftover === 0) break;
    out[i] = (out[i] ?? 0) + 1;
    leftover -= 1;
  }
  return out;
}

/**
 * Float-free blended-margin comparison: holds <=> M/N >= floorBps/10000,
 * cross-multiplied (exact while N > 0). No division ever reaches a decision.
 */
export function crossMarginHolds(
  marginPaise: number,
  netPaise: number,
  floorBps: number,
): boolean {
  assertSafeInt(marginPaise, "marginPaise");
  assertSafeInt(netPaise, "netPaise");
  assertSafeInt(floorBps, "floorBps");
  if (netPaise <= 0) return false; // undefined percentage => fail closed
  return marginPaise * 10_000 >= floorBps * netPaise;
}

/** ₹ formatting with en-IN lakh/crore grouping: 106097 -> "₹1,060.97". */
export function formatPaise(p: number): string {
  assertSafeInt(p, "paise");
  const negative = p < 0;
  const abs = Math.abs(p);
  const rupees = Math.floor(abs / 100);
  const ps = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}₹${rupees.toLocaleString("en-IN")}.${ps}`;
}

/** Fixed-decimal percent formatting for trace strings: 18.1987 -> "18.20%". */
export function formatPct(pct: number, dp = 2): string {
  if (!Number.isFinite(pct)) return `${String(pct)}%`;
  return `${pct.toFixed(dp)}%`;
}
