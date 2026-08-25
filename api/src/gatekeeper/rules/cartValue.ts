/**
 * GK-CART-VALUE (gatekeeper.md §6 row 7, §8.5) — BLOCKER with soft band.
 * RECOMPUTED net total (never the AI figure) is judged against the cap:
 *   net >  cap        => FAIL OVER_CART_VALUE
 *   net ∈ [lowerEdge, cap] => BAND VALUE_IN_BAND (healthy-but-big → human)
 *   net <  lowerEdge  => PASS
 * Band width 0 disables the band entirely (row BAND-DISABLED). Both edges of
 * the band inclusive; the cap itself is an inclusive ceiling (exactly-at-cap
 * PASSES, cap+1 paisa FAILs).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";
import { formatPaise, mulDivRoundHalfUp, toBps } from "@growthagent/shared";

export const cartValue: RuleDefinition = {
  id: "GK-CART-VALUE",
  severity: "BLOCKER",
  dependsOn: ["GK-SKU-RESOLUTION"],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const total = ctx.totals.net_paise;
    const cap = ctx.rules_bps.cartCap;
    const bandPct = ctx.rules.escalation_bands.cart_value_band_pct_below_cap;

    if (total > cap) {
      return {
        status: "FAIL",
        expected: `<= ${formatPaise(cap)}`,
        actual: formatPaise(total),
        reason_code: "OVER_CART_VALUE",
        human_message: `Recomputed cart total ${formatPaise(total)} exceeds the merchant cap ${formatPaise(cap)}.`,
        evidence: { cap_paise: cap, total_paise: total },
      };
    }

    // Band enabled only for widths > 0; lower edge precomputed in integers.
    // NORMALIZATION (documented): the band is [lowerEdge, cap) — lower edge
    // INCLUSIVE, upper edge EXCLUSIVE — because §13 rows 2/7 pin
    // exactly-at-cap => APPROVE (the inclusive-ceiling boundary rule) while
    // rows 4/5/9 pin inside-band => ESCALATE. An inclusive upper edge would
    // make row 2 ESCALATE; §13 is normative ("rows 1–48 constitute the
    // required coverage"). §8.5's "both edges inclusive" reading is thus
    // narrowed: band membership runs up to JUST BELOW the cap.
    if (
      bandPct > 0 &&
      total >= ctx.rules_bps.valBandLowerEdgePaise &&
      total < cap
    ) {
      return {
        status: "BAND",
        expected: `< ${formatPaise(ctx.rules_bps.valBandLowerEdgePaise)} to auto-approve (band [${formatPaise(
          ctx.rules_bps.valBandLowerEdgePaise,
        )}, ${formatPaise(cap)}] escalates)`,
        actual: formatPaise(total),
        reason_code: "VALUE_IN_BAND",
        human_message: `Cart total ${formatPaise(total)} sits in the escalation band [${formatPaise(
          ctx.rules_bps.valBandLowerEdgePaise,
        )}, ${formatPaise(cap)}] below the ${formatPaise(cap)} cap; a human reviews it.`,
        evidence: {
          cap_paise: cap,
          band_lower_edge_paise: ctx.rules_bps.valBandLowerEdgePaise,
          total_paise: total,
          band_width_pct: bandPct,
        },
      };
    }

    return {
      status: "PASS",
      expected: `<= ${formatPaise(cap)}`,
      actual: formatPaise(total),
      human_message: `Cart total ${formatPaise(total)} within cap ${formatPaise(cap)}.`,
      evidence: { cap_paise: cap, total_paise: total },
    };
  },
};

/** Exposed for tests: integer band lower edge exactly as context computes it. */
export function valueBandLowerEdge(cartCapPaise: number, bandPct: number): number {
  return cartCapPaise - mulDivRoundHalfUp(cartCapPaise, toBps(bandPct), 10_000);
}
