/**
 * Canonical display formatters (campaign.md §6.1) + the metric-set contract.
 * The display strings here are THE auditable tokens: prompt, verifier, and
 * frontend all render these exact bytes.
 */
import { describe, expect, it } from "vitest";
import type { OpportunityType } from "@growthagent/shared";
import {
  METRIC_KEYS,
  METRIC_SETS,
  fmtDate,
  fmtDays,
  fmtDow,
  fmtInt,
  fmtPaise,
  fmtPct,
  fmtRate,
  fmtRatio,
  fmtUnits,
  fmtWeeks,
} from "../analytics/format.js";

describe("golden display strings", () => {
  it("ratio / pct / units", () => {
    expect(fmtRatio(0.4642857142857143)).toBe("0.46x");
    expect(fmtPct(0.06)).toBe("6.0%");
    expect(fmtPct(0.15)).toBe("15.0%");
    expect(fmtUnits(13)).toBe("13 units");
    expect(fmtRate(13 / 28)).toBe("0.46 units/day");
  });

  it("Indian digit grouping for paise (§14 numerics)", () => {
    expect(fmtPaise(138_886_0)).toBe("₹13,888.60");
    expect(fmtPaise(12_345_600)).toBe("₹1,23,456.00"); // lakh grouping
    expect(fmtPaise(100)).toBe("₹1.00");
  });

  it("durations and dates", () => {
    expect(fmtDays(5.2)).toBe("5 days");
    expect(fmtWeeks(60 / ((13 / 28) * 7))).toBe("18.5 weeks");
    expect(fmtDate("2026-08-29T00:00:00Z")).toBe("2026-08-29");
    expect(fmtInt(199.6)).toBe("200");
    expect(fmtDow(7)).toBe("Sundays");
    expect(fmtDow(1)).toBe("Mondays");
  });
});

describe("METRIC_SETS contract (exact-set rule)", () => {
  it("pins each type's key set", () => {
    expect([...METRIC_SETS.UNDERSELLING]).toEqual([
      "units_per_day",
      "peer_units_per_day",
      "velocity_ratio",
      "stock_units",
      "weeks_of_stock_cover",
    ]);
    expect([...METRIC_SETS.EXPIRY_RISK]).toEqual([
      "stock_units",
      "expected_sell_through",
      "expires_on",
      "days_to_expiry",
      "projected_surplus_units",
    ]);
    expect([...METRIC_SETS.ATTACH_BUNDLE]).toEqual([
      "co_count",
      "support",
      "confidence_a_to_b",
    ]);
    expect([...METRIC_SETS.TIMING]).toEqual([
      "lift",
      "dow_label",
      "occ_label",
      "cell_units",
      "expected_units",
    ]);
  });

  it("METRIC_KEYS is exactly the union of the per-type sets", () => {
    const union = [...new Set(Object.values(METRIC_SETS).flat())].sort();
    expect([...METRIC_KEYS].sort()).toEqual(union);
  });

  it("every set has >= schema minimum of 2 metrics", () => {
    for (const t of Object.keys(METRIC_SETS) as OpportunityType[]) {
      expect(METRIC_SETS[t].length).toBeGreaterThanOrEqual(2);
    }
  });
});
