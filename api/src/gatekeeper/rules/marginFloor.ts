/**
 * GK-MARGIN-FLOOR (gatekeeper.md §6 row 9, §8.3) — BLOCKER, HARD CLIFF, no
 * band by design: margin is merchant solvency, not convenience.
 *
 * Float-free comparison over recomputed integers:
 *   N = net revenue after discount, M = N − total cost
 *   holds  <=>  M · 10000 >= floorBps · N        (valid while N > 0)
 * No division reaches a decision; exact at the boundary (equality PASSES).
 * N === 0 (all-free cart) => FAIL ZERO_NET_REVENUE — percentage undefined,
 * fail closed. Basket-level only: a loss-leader line inside a healthy basket
 * is fine (that is what campaigns do).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";
import { crossMarginHolds, formatPct } from "@growthagent/shared";

export const marginFloor: RuleDefinition = {
  id: "GK-MARGIN-FLOOR",
  severity: "BLOCKER",
  dependsOn: ["GK-SKU-RESOLUTION", "GK-TOTALS-DRIFT"],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const { net_paise: net, margin_paise: margin, cost_paise: cost } = ctx.totals;
    const floorBps = ctx.rules_bps.marginFloorBps;

    if (net <= 0) {
      return {
        status: "FAIL",
        expected: "net revenue > 0 paise",
        actual: `${net} paise`,
        reason_code: "ZERO_NET_REVENUE",
        human_message: `Recomputed net revenue is ${net} paise; blended margin undefined — declining rather than approving a zero-revenue cart.`,
        evidence: { net_paise: net, cost_paise: cost, floor_bps: floorBps },
      };
    }

    if (!crossMarginHolds(margin, net, floorBps)) {
      // Display-only percentage for the trace (decision used cross-multiplication).
      const displayPct = (margin / net) * 100;
      return {
        status: "FAIL",
        expected: `>= ${formatPct(floorBps / 100)} blended margin after discount`,
        actual: formatPct(displayPct),
        reason_code: "BELOW_MARGIN_FLOOR",
        human_message: `Blended margin ${formatPct(displayPct)} (${margin} of ${net} paise) is below the merchant floor of ${floorBps / 100}%. AI narrative was not evaluated.`,
        evidence: {
          margin_paise: margin,
          net_paise: net,
          cost_paise: cost,
          floor_bps: floorBps,
          margin_times_10000: margin * 10_000,
          floorBps_times_net: floorBps * net,
        },
      };
    }

    const displayBps = Math.floor((margin * 10_000) / net);
    return {
      status: "PASS",
      human_message: `Blended margin ${(displayBps / 100).toFixed(2)}% meets the ${floorBps / 100}% floor.`,
      evidence: {
        margin_paise: margin,
        net_paise: net,
        floor_bps: floorBps,
        display_blended_margin_bps: displayBps,
      },
    };
  },
};
