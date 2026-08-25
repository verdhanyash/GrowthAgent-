/**
 * GK-VELOCITY-VALUE (gatekeeper.md §6 row 14, §8.5) — BLOCKER.
 * Rolling-day APPROVED-value ceiling per buyer identity. Uses the
 * RECOMPUTED net (never the AI total — invariant I-2). Declines do not
 * consume budget but DO count toward request_count (spam detection).
 *   prior_approved + recomputed_net > max => FAIL VELOCITY_VALUE_EXCEEDED
 *   equality PASSES (inclusive ceiling)
 * Snapshot UNAVAILABLE => UNAVAILABLE_INPUT VELOCITY_UNAVAILABLE (fail closed).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";
import { formatPaise } from "@growthagent/shared";

export const velocityValue: RuleDefinition = {
  id: "GK-VELOCITY-VALUE",
  severity: "BLOCKER",
  dependsOn: ["GK-SKU-RESOLUTION"],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const v = ctx.velocity;
    if (v.status === "UNAVAILABLE") {
      return {
        status: "UNAVAILABLE_INPUT",
        expected: "velocity snapshot AVAILABLE",
        actual: `UNAVAILABLE (${v.reason})`,
        reason_code: "VELOCITY_UNAVAILABLE",
        human_message:
          "Buyer velocity data is unavailable; approved-value budget unverifiable — escalating rather than assuming an empty ledger.",
        evidence: { reason: v.reason, detail: v.detail },
      };
    }
    const max = ctx.rules.per_agent_velocity.max_value_per_day_paise;
    const prior = v.day_window.approved_value_paise;
    const projected = prior + ctx.totals.net_paise;
    if (projected > max) {
      return {
        status: "FAIL",
        expected: `approved value <= ${formatPaise(max)} per day`,
        actual: formatPaise(projected),
        reason_code: "VELOCITY_VALUE_EXCEEDED",
        human_message: `Approving this cart would take identity ${v.agent_identity_id} to ${formatPaise(projected)} of approved value today (limit ${formatPaise(max)}).`,
        evidence: {
          prior_approved_value_paise: prior,
          proposed_net_paise: ctx.totals.net_paise,
          projected_value_paise: projected,
          max_value_per_day_paise: max,
          agent_identity_id: v.agent_identity_id,
        },
      };
    }
    return {
      status: "PASS",
      human_message: `Identity ${v.agent_identity_id} at ${formatPaise(projected)} of its ${formatPaise(max)} daily value budget with this cart.`,
      evidence: {
        prior_approved_value_paise: prior,
        proposed_net_paise: ctx.totals.net_paise,
        projected_value_paise: projected,
        max_value_per_day_paise: max,
      },
    };
  },
};
