/**
 * GK-STOCK-AVAILABILITY (gatekeeper.md §6 row 11) — BLOCKER.
 * Per merged line: qty > stock_on_hand fails UNLESS the SKU is exempt in
 * `backorder_allowed_skus` (made-to-order items) — exemption recorded as
 * evidence, and ALL OTHER RULES still apply to exempt lines. When the
 * merchant disables require_full_availability, availability never blocks.
 * Inclusive boundary: qty == stock PASSES (§8.5).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";

export const stockAvailability: RuleDefinition = {
  id: "GK-STOCK-AVAILABILITY",
  severity: "BLOCKER",
  dependsOn: ["GK-SKU-RESOLUTION"],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const policy = ctx.rules.stock_policy;
    if (!policy.require_full_availability) {
      return {
        status: "PASS",
        human_message: "Full-availability policy disabled by merchant; stock not enforced at the gate.",
        evidence: { require_full_availability: false },
      };
    }

    const backorder = new Set(policy.backorder_allowed_skus);
    const shortfalls: {
      sku_id: string;
      quantity: number;
      stock_on_hand: number;
      backorder_exempt: boolean;
    }[] = [];
    let exemptions = 0;

    for (const line of ctx.merged_lines) {
      const item = ctx.sku_index.get(line.sku_id);
      if (item === undefined) continue; // unresolved SKUs handled by GK-SKU-RESOLUTION
      if (line.quantity <= item.stock_on_hand) continue;
      const exempt = backorder.has(line.sku_id);
      if (exempt) exemptions += 1;
      shortfalls.push({
        sku_id: line.sku_id,
        quantity: line.quantity,
        stock_on_hand: item.stock_on_hand,
        backorder_exempt: exempt,
      });
    }

    const blocking = shortfalls.filter((s) => !s.backorder_exempt);
    if (blocking.length > 0) {
      return {
        status: "FAIL",
        expected: "quantity <= stock_on_hand per line",
        actual: blocking
          .map((s) => `${s.sku_id} qty ${s.quantity} vs stock ${s.stock_on_hand}`)
          .join("; "),
        reason_code: "INSUFFICIENT_STOCK",
        human_message: `Insufficient stock: ${blocking
          .map((s) => `${s.sku_id} requests ${s.quantity} with ${s.stock_on_hand} on hand`)
          .join("; ")}.`,
        evidence: { shortfalls, exemptions },
      };
    }

    return {
      status: "PASS",
      human_message:
        exemptions > 0
          ? `Stock satisfied (${exemptions} line(s) on allowed backorder).`
          : "Stock satisfies every line.",
      evidence: {
        require_full_availability: true,
        ...(exemptions > 0 ? { exemptions, backorder_applied: true } : {}),
      },
    };
  },
};
