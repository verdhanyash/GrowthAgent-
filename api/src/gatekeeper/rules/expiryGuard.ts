/**
 * GK-EXPIRY-GUARD (gatekeeper.md §6 row 12, §10 rows 10–11) — BLOCKER, HARD,
 * NOT escalable: expired goods must never ship; there is nothing for a human
 * to approve. Near-expiry PASSES (selling near-expiry stock is the campaign
 * system's job) and is flagged in evidence. Boundary: expired iff sell_by is
 * STRICTLY before the injected now (see time.ts).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";
import { isExpired, isNearExpiry } from "../time.js";

export const expiryGuard: RuleDefinition = {
  id: "GK-EXPIRY-GUARD",
  severity: "BLOCKER",
  dependsOn: ["GK-SKU-RESOLUTION"],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const policy = ctx.rules.expiry_policy;
    const expired: { sku_id: string; sell_by_iso: string }[] = [];
    const nearExpirySkus: string[] = [];

    for (const line of ctx.merged_lines) {
      const item = ctx.sku_index.get(line.sku_id);
      if (item === undefined) continue; // unresolved SKUs handled by GK-SKU-RESOLUTION
      if (policy.block_expired_skus && isExpired(item.sell_by_iso, ctx.now_iso)) {
        expired.push({ sku_id: item.sku_id, sell_by_iso: item.sell_by_iso ?? "null" });
        continue;
      }
      if (isNearExpiry(item.sell_by_iso, ctx.now_iso)) nearExpirySkus.push(item.sku_id);
    }

    if (expired.length > 0) {
      return {
        status: "FAIL",
        expected: policy.block_expired_skus
          ? "no line past its sell_by instant"
          : "expiry policy disabled",
        actual: expired.map((e) => `${e.sku_id} (sell_by ${e.sell_by_iso})`).join(", "),
        reason_code: "SKU_EXPIRED",
        human_message: `Expired SKU(s) cannot ship through the agent pipeline: ${expired
          .map((e) => `${e.sku_id} expired ${e.sell_by_iso}`)
          .join(", ")}. Hard decline — not escalable.`,
        evidence: { expired_items: expired, block_expired_skus: policy.block_expired_skus },
      };
    }

    return {
      status: "PASS",
      human_message:
        nearExpirySkus.length > 0
          ? `No expired SKUs (near-expiry, campaign-targetable: ${nearExpirySkus.join(", ")}).`
          : "No expired SKUs.",
      evidence: {
        block_expired_skus: policy.block_expired_skus,
        ...(nearExpirySkus.length > 0 ? { near_expiry_skus: nearExpirySkus, near_expiry: true } : {}),
      },
    };
  },
};
