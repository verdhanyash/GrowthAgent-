/**
 * GK-DISCOUNT-CAP (gatekeeper.md §6 row 8, §8.5) — BLOCKER with soft band.
 * Judges the CLAIMED commercial term (`bundle_discount_pct` → bps, converted
 * ONCE at context build) against the merchant cap:
 *   disc_bps >  cap_bps         => FAIL OVER_DISCOUNT_CAP
 *   disc_bps ∈ [cap−band, cap]  => BAND DISCOUNT_IN_BAND
 *   disc_bps <  cap−band        => PASS
 * The AMOUNT is always recomputed from this pct over raw prices — no AI-supplied
 * rupee figure is ever read. Band width 0 disables; edges inclusive; at-or-over
 * the cap is a hard FAIL even when inside what would be band range.
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";
import { formatPct } from "@growthagent/shared";

export const discountCap: RuleDefinition = {
  id: "GK-DISCOUNT-CAP",
  severity: "BLOCKER",
  dependsOn: ["GK-CART-STRUCTURE"],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const discBps = ctx.discount_bps;
    const capBps = ctx.rules_bps.discCapBps;
    const bandPp = ctx.rules.escalation_bands.discount_band_pp_below_cap;
    const lowerBps = ctx.rules_bps.discBandLowerBps;

    if (discBps > capBps) {
      return {
        status: "FAIL",
        expected: `<= ${formatPct(capBps / 100)} (${capBps} bps)`,
        actual: `${ctx.proposal.bundle_discount_pct}% (${discBps} bps)`,
        reason_code: "OVER_DISCOUNT_CAP",
        human_message: `Proposed bundle discount ${ctx.proposal.bundle_discount_pct}% exceeds the merchant cap ${capBps / 100}% — recomputed and refused regardless of any negotiated claim.`,
        evidence: { cap_bps: capBps, proposed_bps: discBps },
      };
    }

    // NORMALIZATION (documented, mirrors cartValue.ts): the band is
    // [cap−band_pp, cap) bps — exactly-at-cap PASSES (§13 row 7 pins this),
    // above-cap FAILs (row 8), inside-band ESCALATEs (row 9).
    if (bandPp > 0 && discBps >= lowerBps && discBps < capBps) {
      return {
        status: "BAND",
        expected: `< ${formatPct(lowerBps / 100)} to auto-approve (band [${lowerBps}, ${capBps}] bps escalates)`,
        actual: `${ctx.proposal.bundle_discount_pct}%`,
        reason_code: "DISCOUNT_IN_BAND",
        human_message: `Discount ${ctx.proposal.bundle_discount_pct}% sits within ${bandPp}pp of the ${capBps / 100}% cap; a human reviews it.`,
        evidence: {
          cap_bps: capBps,
          band_lower_bps: lowerBps,
          proposed_bps: discBps,
          band_width_pp: bandPp,
        },
      };
    }

    return {
      status: "PASS",
      expected: `<= ${formatPct(capBps / 100)} (${capBps} bps)`,
      actual: `${ctx.proposal.bundle_discount_pct}% (${discBps} bps)`,
      human_message: `Discount ${ctx.proposal.bundle_discount_pct}% within cap ${capBps / 100}%.`,
      evidence: { cap_bps: capBps, proposed_bps: discBps },
    };
  },
};
