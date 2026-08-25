/**
 * GK-VELOCITY-REQUESTS (gatekeeper.md §6 row 13, §8.5) — BLOCKER.
 * Rolling-hour request ceiling per BUYER-agent identity (identity affects
 * ONLY velocity/offender dimensions — invariant I-6). Convention that kills
 * the classic off-by-one: the snapshot's request_count EXCLUDES the proposal
 * under evaluation; the rule adds +1 itself.
 *   prior + 1 > max => FAIL VELOCITY_REQUESTS (prior+1 == max PASSES)
 * Snapshot UNAVAILABLE for ANY reason => UNAVAILABLE_INPUT VELOCITY_UNAVAILABLE
 * => ESCALATE — fail closed; there is no "assume zero usage" path (§9 trigger 3).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";

export const velocityRequests: RuleDefinition = {
  id: "GK-VELOCITY-REQUESTS",
  severity: "BLOCKER",
  dependsOn: [],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const v = ctx.velocity;
    if (v.status === "UNAVAILABLE") {
      return {
        status: "UNAVAILABLE_INPUT",
        expected: "velocity snapshot AVAILABLE",
        actual: `UNAVAILABLE (${v.reason})`,
        reason_code: "VELOCITY_UNAVAILABLE",
        human_message:
          "Buyer velocity data is unavailable; cannot verify this agent is safe — escalating rather than assuming zero usage.",
        evidence: { reason: v.reason, detail: v.detail },
      };
    }
    const max = ctx.rules.per_agent_velocity.max_requests_per_hour;
    const inclThis = v.hour_window.request_count + 1;
    if (inclThis > max) {
      return {
        status: "FAIL",
        expected: `<= ${max} requests/hour including this request`,
        actual: `${inclThis}`,
        reason_code: "VELOCITY_REQUESTS",
        human_message: `This would be request ${inclThis} in the rolling hour for identity ${v.agent_identity_id}; merchant limit is ${max}.`,
        evidence: {
          prior_request_count: v.hour_window.request_count,
          including_this_request: inclThis,
          max_requests_per_hour: max,
          agent_identity_id: v.agent_identity_id,
        },
      };
    }
    return {
      status: "PASS",
      human_message: `Request ${inclThis} of ${max} allowed this hour for identity ${v.agent_identity_id}.`,
      evidence: {
        prior_request_count: v.hour_window.request_count,
        including_this_request: inclThis,
        max_requests_per_hour: max,
      },
    };
  },
};
