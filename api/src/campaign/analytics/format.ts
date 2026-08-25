/**
 * Canonical display formatters (campaign.md §6.1) — single source of truth
 * for every metric's rendered string. The display string is THE auditable
 * token: it goes into the LLM prompt, it is what the verifier checks for, and
 * what the frontend renders. The verifier never recomputes numbers from raw
 * values; it matches these strings (normalized).
 *
 * Rounding policy: internal math runs at full precision; values are rounded
 * ONCE here at emission. Weights compute from UNROUNDED metrics and round to
 * 2 dp only at entry assembly (derive.ts) — order pinned by derive.spec.ts.
 */
import type { OpportunityType } from "@growthagent/shared";

export const fmtRatio = (x: number): string => `${x.toFixed(2)}x`; // "0.46x"
export const fmtPct = (x: number): string => `${(x * 100).toFixed(1)}%`; // "15.0%"
export const fmtUnits = (n: number): string => `${Math.round(n)} units`; // "13 units"
export const fmtDays = (n: number): string => `${Math.round(n)} days`;
export const fmtWeeks = (n: number): string => `${n.toFixed(1)} weeks`; // "18.5 weeks"
export const fmtDate = (iso: string): string => iso.slice(0, 10); // "2026-08-29"
export const fmtInt = (n: number): string => Math.round(n).toString(); // "200"

/** Per-day rates ("0.46 units/day") — added beyond the doc's eight formatters
 *  because rounding 0.4643 through fmtUnits renders the misleading "0 units".
 *  Registered in ARCHITECTURE.md §18 (M2). */
export const fmtRate = (x: number): string => `${x.toFixed(2)} units/day`;

/** Indian digit grouping ("₹1,23,456.00"). en-IN via Intl — deterministic on
 *  Node ≥ 14 with full ICU; golden-string-pinned by format.spec.ts. */
export const fmtPaise = (p: number): string =>
  `₹${(p / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const fmtDow = (dowIso: number): string =>
  DOW_LABELS[dowIso] ?? `dow-${dowIso}`;

const DOW_LABELS: Record<number, string> = {
  1: "Mondays",
  2: "Tuesdays",
  3: "Wednesdays",
  4: "Thursdays",
  5: "Fridays",
  6: "Saturdays",
  7: "Sundays",
};

/**
 * Metric-key contract between analytics (SQL layer, M3), the templates, and
 * the verifier.
 *
 * EXACT-SET RULE: each opportunity type carries EXACTLY the metrics its
 * template quotes — no more, no fewer. The verifier's Rule 1 demands every
 * metric display appear in a rationale; an extra metric would make honest
 * output AND the template itself unverifiable. Analytics extending a set must
 * extend that type's template + this table together.
 *
 * Why UNDERSELLING carries stock_units (§8.1): SKU codes tokenize into digits
 * ("CHOC_TRUFFLE_500G" → token 500), so a pack MUST include a quantity
 * display legitimizing them. §8.2's template sketch predates that constraint;
 * adjudicated toward §8.1 and the template extended to quote it (§18 register).
 */
// Declared BEFORE the table as a plain literal union — deriving it from
// METRIC_KEYS would make the Record annotation circularly reference itself.
export type MetricKey =
  | "units_per_day"
  | "peer_units_per_day"
  | "velocity_ratio"
  | "stock_units"
  | "weeks_of_stock_cover"
  | "expected_sell_through"
  | "expires_on"
  | "days_to_expiry"
  | "projected_surplus_units"
  | "co_count"
  | "support"
  | "confidence_a_to_b"
  | "lift"
  | "dow_label"
  | "occ_label"
  | "cell_units"
  | "expected_units";

export const METRIC_SETS: Record<OpportunityType, readonly MetricKey[]> = {
  UNDERSELLING: [
    "units_per_day",
    "peer_units_per_day",
    "velocity_ratio",
    "stock_units",
    "weeks_of_stock_cover",
  ],
  EXPIRY_RISK: [
    "stock_units",
    "expected_sell_through",
    "expires_on",
    "days_to_expiry",
    "projected_surplus_units",
  ],
  ATTACH_BUNDLE: ["co_count", "support", "confidence_a_to_b"],
  TIMING: ["lift", "dow_label", "occ_label", "cell_units", "expected_units"],
};

export const METRIC_KEYS = [
  ...new Set(Object.values(METRIC_SETS).flat()),
] as const;
