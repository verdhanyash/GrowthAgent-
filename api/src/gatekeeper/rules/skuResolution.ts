/**
 * GK-SKU-RESOLUTION (gatekeeper.md §6 row 5) — BLOCKER.
 * Every merged line's sku_id must resolve in the GroundTruthSnapshot. Ghost
 * SKUs decline here; downstream money rules then SKIP visibly (full trace,
 * nothing vanishes — invariant I-4).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";

export const skuResolution: RuleDefinition = {
  id: "GK-SKU-RESOLUTION",
  severity: "BLOCKER",
  dependsOn: ["GK-CART-STRUCTURE"],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    if (ctx.unresolved_skus.length > 0) {
      return {
        status: "FAIL",
        expected: "all line SKUs present in ground-truth catalog snapshot",
        actual: `unresolved: ${ctx.unresolved_skus.join(", ")}`,
        reason_code: "UNKNOWN_SKU",
        human_message: `Cart references SKU(s) absent from the merchant catalog: ${ctx.unresolved_skus.join(", ")}.`,
        evidence: { unresolved_skus: [...ctx.unresolved_skus] },
      };
    }
    return {
      status: "PASS",
      human_message:
        ctx.price_echo_mismatches.length > 0
          ? `All ${ctx.merged_lines.length} line SKU(s) resolved; ${ctx.price_echo_mismatches.length} AI price-echo claim(s) disagreed with RAW list prices (recompute won — advisory PRICE_ECHO_MISMATCH).`
          : `All ${ctx.merged_lines.length} line SKU(s) resolved against the catalog snapshot.`,
      evidence: {
        resolved_count: ctx.merged_lines.length,
        ...(ctx.price_echo_mismatches.length > 0
          ? {
              advisories: ["PRICE_ECHO_MISMATCH"],
              price_echo_mismatches: [...ctx.price_echo_mismatches],
            }
          : {}),
      },
    };
  },
};
