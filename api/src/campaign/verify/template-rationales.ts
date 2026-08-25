/**
 * Deterministic template rationales (campaign.md §8.2). Templates quote the
 * same canonical metric displays as verified LLM output — so even the
 * fallback is fully auditable, and the VERIFIER ITSELF PASSES on template
 * output (property-tested: verifyRationale(opp, entry, template) === VERIFIED
 * for every fixture opportunity).
 */
import type { Opportunity } from "@growthagent/shared";
import type { EntryDraft } from "../domain/derive.js";

const M = (o: Opportunity, key: string): string =>
  o.metrics.find((m) => m.key === key)?.display ?? "<missing>"; // defensive; analytics always populates

export function templateRationale(o: Opportunity, entry: EntryDraft): string {
  const [sku] = entry.skus;
  switch (o.type) {
    case "UNDERSELLING":
      // Quotes stock_units too (exact-set rule, format.ts): SKU digits in
      // rationales need a legitimizing quantity display (§8.1).
      return (
        `PRIORITIZE_IN_BUNDLES for ${sku}: selling ${M(o, "units_per_day")} vs peer median ` +
        `${M(o, "peer_units_per_day")} (${M(o, "velocity_ratio")} of normal) with ${M(o, "stock_units")} on hand ` +
        `and ${M(o, "weeks_of_stock_cover")} of stock cover. Push this SKU into bundles to close the velocity gap.`
      );
    case "EXPIRY_RISK": {
      const pairSku = entry.skus[1];
      return (
        `CLEAR_NEAR_EXPIRY for ${sku}${pairSku ? ` paired with ${pairSku}` : ""}: ` +
        `${M(o, "stock_units")} on hand, expected sell-through ${M(o, "expected_sell_through")} before ` +
        `${M(o, "expires_on")} (${M(o, "days_to_expiry")} away), leaving ${M(o, "projected_surplus_units")} at risk.` +
        ` Discount-and-bundle now to convert it.`
      );
    }
    case "ATTACH_BUNDLE":
      return (
        `PROMOTE_PAIR ${entry.skus.join(" + ")}: bought together in ${M(o, "co_count")} baskets ` +
        `(${M(o, "support")} of all baskets, ${M(o, "confidence_a_to_b")} attach from ${o.skus[0]}). ` +
        `Offer as a combo to lift basket size.`
      );
    case "TIMING":
      return (
        `PRIORITIZE_IN_BUNDLES for ${sku}: demand peaks at ${M(o, "lift")} on ${M(o, "dow_label")} ` +
        `for the "${M(o, "occ_label")}" occasion (${M(o, "cell_units")} vs ${M(o, "expected_units")} expected). ` +
        `Feature it in weekend/festive bundles.`
      );
  }
}
