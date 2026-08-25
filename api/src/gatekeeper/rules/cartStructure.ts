/**
 * GK-CART-STRUCTURE (gatekeeper.md §6 row 4, §10 rows 1–6, 34–36, 38–40) —
 * BLOCKER. Engine-level defense for hand-built objects that bypassed zod:
 * empty cart, qty <= 0, NaN/non-finite numerics, discount outside [0,100].
 * Priority when multiple defects coexist (documented):
 *   EMPTY_CART > MALFORMED_NUMERIC > INVALID_QUANTITY > INVALID_DISCOUNT_RANGE
 * (numeric sanity outranks range checks so NaN can never masquerade as a
 * mere out-of-range value). A healthy cart PASSes carrying the LINES_MERGED
 * advisory evidence whenever duplicate-SKU lines were merged upstream.
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";
import { formatPct } from "@growthagent/shared";

export const cartStructure: RuleDefinition = {
  id: "GK-CART-STRUCTURE",
  severity: "BLOCKER",
  dependsOn: [],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const s = ctx.structural;

    if (s.emptyCart) {
      return {
        status: "FAIL",
        expected: ">= 1 line after merge",
        actual: "0 lines",
        reason_code: "EMPTY_CART",
        human_message: "Cart contains no lines; nothing sellable to approve.",
        evidence: { raw_line_count: ctx.proposal.lines.length, merged_line_count: 0 },
      };
    }
    if (s.badNumeric) {
      return {
        status: "FAIL",
        expected: "all quantities safe integers; discount finite",
        actual: "NaN or non-safe-integer numeric detected",
        reason_code: "MALFORMED_NUMERIC",
        human_message:
          "Cart carries a malformed numeric value (NaN or unsafe integer); declined without arithmetic.",
        evidence: { line_count: ctx.merged_lines.length },
      };
    }
    if (s.badQty) {
      return {
        status: "FAIL",
        expected: "quantity >= 1 per line",
        actual: "quantity <= 0 present",
        reason_code: "INVALID_QUANTITY",
        human_message: "A cart line requests a non-positive quantity.",
        evidence: {
          offending: ctx.merged_lines
            .filter((l) => l.quantity <= 0)
            .map((l) => ({ sku_id: l.sku_id, quantity: l.quantity })),
        },
      };
    }
    if (s.badDisc) {
      return {
        status: "FAIL",
        expected: "bundle_discount_pct within [0, 100]",
        actual: `${formatPct(ctx.proposal.bundle_discount_pct)}`,
        reason_code: "INVALID_DISCOUNT_RANGE",
        human_message: `Bundle discount ${formatPct(ctx.proposal.bundle_discount_pct)} is outside the definable range [0%, 100%].`,
        evidence: { bundle_discount_pct: ctx.proposal.bundle_discount_pct },
      };
    }

    return {
      status: "PASS",
      human_message:
        s.mergedCount > 0
          ? `Cart structure valid (${ctx.merged_lines.length} lines after merging ${s.mergedCount} duplicate).`
          : `Cart structure valid (${ctx.merged_lines.length} lines).`,
      evidence: {
        raw_line_count: ctx.proposal.lines.length,
        merged_line_count: ctx.merged_lines.length,
        lines_merged: s.mergedCount,
        // Advisory surfaced only when a merge actually happened (§6 note).
        ...(s.mergedCount > 0 ? { advisories: ["LINES_MERGED"] } : {}),
      },
    };
  },
};
