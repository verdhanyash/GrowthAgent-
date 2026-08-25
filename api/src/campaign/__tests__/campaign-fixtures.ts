/**
 * Golden campaign fixtures (campaign.md §15-A/§6.5 worked examples). One
 * opportunity per type carrying EXACTLY its METRIC_SETS keys; weights derive
 * from the UNROUNDED values below and round to 2dp at assembly.
 */
import {
  type Metric,
  type Opportunity,
  type OpportunityType,
} from "@growthagent/shared";
import { opportunityId, assembleEntries } from "../domain/derive.js";
import { METRIC_SETS } from "../analytics/format.js";

export const RUN_ID = "ar_20260824_ab12cd34";
export const AS_OF = "2026-08-24T18:29:59.000Z"; // 2026-08-24T23:59:59+05:30

const m = (
  key: string,
  label: string,
  value: number | string,
  display: string,
): Metric => ({ key, label, value, display });

/* §6.5 worked example: units_per_day = 13/28 = 0.4643 vs peer median 1.00 */
export const OPP_UNDER: Opportunity = {
  opportunity_id: opportunityId(RUN_ID, "UNDERSELLING", ["MANGO_PASTRY"]),
  type: "UNDERSELLING",
  skus: ["MANGO_PASTRY"],
  metrics: [
    m("units_per_day", "Units sold per day (28d)", 13 / 28, "0.46 units/day"),
    m("peer_units_per_day", "Category-peer median units/day", 1, "1.00 units/day"),
    m("velocity_ratio", "Velocity vs category-peer median", 0.4642857142857143, "0.46x"),
    m("stock_units", "Stock on hand", 60, "60 units"),
    m("weeks_of_stock_cover", "Weeks of stock cover", 60 / ((13 / 28) * 7), "18.5 weeks"),
  ],
  weight: 0.6 * (1 - Math.min(0.4642857142857143 / 0.5, 1)) + 0.4 * 1,
  analytics_run_id: RUN_ID,
  generated_at_sim: AS_OF,
};

/* §6.5 expiry worked example: stock 30, dte 5, upd 0.4 → surplus 28. On
 * F=DRY_CAKE_ASSORTED (§15-A dataset), NOT E=KAJU_KATLI_250G — the doc's
 * AT-1 pair claims E too, and a shared SKU here would suppress ATTACH at
 * assembly, silently shrinking every downstream 4-entry expectation. */
export const OPP_EXPIRY: Opportunity = {
  opportunity_id: opportunityId(RUN_ID, "EXPIRY_RISK", ["DRY_CAKE_ASSORTED"]),
  type: "EXPIRY_RISK",
  skus: ["DRY_CAKE_ASSORTED"],
  metrics: [
    m("stock_units", "Stock on hand", 30, "30 units"),
    m("expected_sell_through", "Expected sell-through before expiry", 2.0, "2 units"),
    m("expires_on", "Expiry date", "2026-08-29", "2026-08-29"),
    m("days_to_expiry", "Days to expiry", 5, "5 days"),
    m("projected_surplus_units", "Projected surplus at expiry", 28, "28 units"),
  ],
  weight:
    0.65 * Math.min(28 / 30, 1) + 0.35 * (1 - 5 / 7),
  analytics_run_id: RUN_ID,
  generated_at_sim: AS_OF,
};

/* §15-A AT-1: co 12 of 200 baskets; anchor D in 80 → conf 15% */
export const OPP_ATTACH: Opportunity = {
  opportunity_id: opportunityId(RUN_ID, "ATTACH_BUNDLE", [
    "BUTTER_COOKIE_JAR",
    "KAJU_KATLI_250G",
  ]),
  type: "ATTACH_BUNDLE",
  skus: ["BUTTER_COOKIE_JAR", "KAJU_KATLI_250G"],
  metrics: [
    m("co_count", "Baskets containing both", 12, "12"),
    m("support", "Share of all baskets", 0.06, "6.0%"),
    m("confidence_a_to_b", "Attach rate from anchor", 0.15, "15.0%"),
  ],
  weight: 0.5 * (0.15 / 0.3) + 0.5 * (0.06 / 0.09),
  analytics_run_id: RUN_ID,
  generated_at_sim: AS_OF,
};

/* §15-A WD-1: eggless×Sunday lift 2.15 */
export const OPP_TIMING: Opportunity = {
  opportunity_id: opportunityId(RUN_ID, "TIMING", ["EGGLESS_LOAF"]),
  type: "TIMING",
  skus: ["EGGLESS_LOAF"],
  metrics: [
    m("lift", "Demand lift vs independence baseline", 2.15, "2.15x"),
    m("dow_label", "Peak weekday", 7, "Sundays"),
    m("occ_label", "Occasion", "eggless", "eggless"),
    m("cell_units", "Units in peak cell", 43, "43 units"),
    m("expected_units", "Independence-expected units", 20, "20 units"),
  ],
  weight: (2.15 - 1) / 1.5,
  analytics_run_id: RUN_ID,
  generated_at_sim: AS_OF,
};

export const ALL_OPPS: readonly Opportunity[] = [
  OPP_UNDER,
  OPP_EXPIRY,
  OPP_ATTACH,
  OPP_TIMING,
];

/** Assembly over ALL_OPPS + DraftArgs whose metricsByEntry is aligned through
 *  the opportunity lookup. NEVER zip assembly output against ALL_OPPS
 *  positionally: assembly reorders (weight desc) and can suppress conflicts. */
export const ASSEMBLY = assembleEntries(ALL_OPPS);
const OPP_BY_ID = new Map(ALL_OPPS.map((o) => [o.opportunity_id, o] as const));
export const DRAFT_ARGS = {
  entries: ASSEMBLY.entries,
  metricsByEntry: ASSEMBLY.entries.map(
    (e) => OPP_BY_ID.get(e.opportunity_id)!.metrics,
  ),
};

/** Structural guard: every fixture carries exactly its contract metric set. */
export function assertMetricContract(): void {
  for (const o of ALL_OPPS) {
    const keys = o.metrics.map((x) => x.key);
    const want = [...METRIC_SETS[o.type as OpportunityType]].sort();
    if (JSON.stringify([...keys].sort()) !== JSON.stringify(want)) {
      throw new Error(`fixture drift: ${o.type} metrics ${keys} != ${want}`);
    }
  }
}

/** Honest rationale per type — quotes EVERY display, invents nothing. Used by
 *  verifier U-4 tests and as replay-fixture content. */
export const HONEST_RATIONALES: Record<OpportunityType, string> = {
  UNDERSELLING:
    "PRIORITIZE_IN_BUNDLES for MANGO_PASTRY: selling 0.46 units/day versus a peer " +
    "median of 1.00 units/day — that is 0.46x of normal pace — while 60 units sit in " +
    "stock with 18.5 weeks of cover ahead. Bundle this into hampers to close the gap.",
  EXPIRY_RISK:
    "CLEAR_NEAR_EXPIRY for DRY_CAKE_ASSORTED: we hold 30 units but expect sell-through " +
    "of only 2 units before 2026-08-29 (5 days away), leaving 28 units at risk. " +
    "Discount-and-bundle now to convert it.",
  ATTACH_BUNDLE:
    "PROMOTE_PAIR BUTTER_COOKIE_JAR + KAJU_KATLI_250G: the pair landed together in 12 " +
    "baskets — 6.0% of all baskets and a 15.0% attach from BUTTER_COOKIE_JAR. Offer " +
    "them as one combo.",
  TIMING:
    "PRIORITIZE_IN_BUNDLES for EGGLESS_LOAF: demand peaks at 2.15x on Sundays for the " +
    "\"eggless\" occasion (43 units vs 20 units expected). Feature it in weekend bundles.",
};
