/**
 * GK-REPEAT-OFFENDER (gatekeeper.md §6 row 16, §9 trigger 5) —
 * ESCALATE_IF_FAILED. Prior 24h counters from the velocity snapshot meet ANY
 * configured threshold (inclusive >=) => forced human review:
 *   prior_escalations_24h >= escalations_24h_threshold  OR
 *   prior_declines_24h    >= declines_24h_threshold     OR
 *   injection_flags_24h   >= injection_flags_24h_threshold
 *
 * Documented decision (not pinned in spec): when the snapshot is UNAVAILABLE
 * this rule emits SKIP ("counters unreadable") rather than a second
 * VELOCITY_UNAVAILABLE escalation — rules 13/14 already fail the outcome
 * closed to ESCALATE, and duplicating the cause would only noise the inbox.
 * The skip is recorded (invariant I-4); nothing passes silently.
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";

export const repeatOffender: RuleDefinition = {
  id: "GK-REPEAT-OFFENDER",
  severity: "ESCALATE_IF_FAILED",
  dependsOn: [],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const v = ctx.velocity;
    if (v.status === "UNAVAILABLE") {
      return {
        status: "SKIP",
        because:
          "velocity snapshot unavailable; repeat-offender counters unreadable (rules GK-VELOCITY-REQUESTS/GK-VELOCITY-VALUE already escalate on this)",
      };
    }
    const t = ctx.rules.repeat_offender;
    const trips = {
      escalations: v.prior_escalations_24h >= t.escalations_24h_threshold,
      declines: v.prior_declines_24h >= t.declines_24h_threshold,
      injection_flags: v.injection_flags_24h >= t.injection_flags_24h_threshold,
    };

    if (trips.escalations || trips.declines || trips.injection_flags) {
      const trippedList = [
        trips.escalations
          ? `${v.prior_escalations_24h} prior escalations (threshold ${t.escalations_24h_threshold})`
          : null,
        trips.declines
          ? `${v.prior_declines_24h} prior declines (threshold ${t.declines_24h_threshold})`
          : null,
        trips.injection_flags
          ? `${v.injection_flags_24h} prior injection flags (threshold ${t.injection_flags_24h_threshold})`
          : null,
      ].filter((x): x is string => x !== null);
      return {
        status: "ESCALATE_TRIGGER",
        expected: "all 24h offender counters below thresholds",
        actual: trippedList.join("; "),
        reason_code: "REPEAT_OFFENDER",
        human_message: `Repeat-offender review triggered for identity ${v.agent_identity_id}: ${trippedList.join("; ")}.`,
        evidence: {
          agent_identity_id: v.agent_identity_id,
          prior_escalations_24h: v.prior_escalations_24h,
          prior_declines_24h: v.prior_declines_24h,
          injection_flags_24h: v.injection_flags_24h,
          thresholds: t,
          tripped: trips,
        },
      };
    }

    return {
      status: "PASS",
      human_message: `No repeat-offender thresholds met for identity ${v.agent_identity_id}.`,
      evidence: {
        prior_escalations_24h: v.prior_escalations_24h,
        prior_declines_24h: v.prior_declines_24h,
        injection_flags_24h: v.injection_flags_24h,
        thresholds: t,
      },
    };
  },
};
