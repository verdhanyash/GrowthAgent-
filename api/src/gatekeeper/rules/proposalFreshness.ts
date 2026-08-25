/**
 * GK-PROPOSAL-FRESHNESS (gatekeeper.md §6 row 3, §10 rows 7–9) — BLOCKER.
 * Three bounds judged against the INJECTED clock (never the real one):
 *  1. issued_at more than `proposal_max_future_skew_seconds` in the future
 *     => FUTURE_ISSUED_AT (clock attack / replay shape).
 *  2. now − issued_at beyond `proposal_max_age_seconds` => STALE_PROPOSAL.
 *  3. expires_at strictly past => STALE_PROPOSAL.
 * All limits inclusive at the boundary (§8.5): exactly-at-limit passes.
 * Unparseable timestamps fail closed as stale.
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";

export const proposalFreshness: RuleDefinition = {
  id: "GK-PROPOSAL-FRESHNESS",
  severity: "BLOCKER",
  dependsOn: [],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const issued = Date.parse(ctx.proposal.issued_at_iso);
    const expires = Date.parse(ctx.proposal.expires_at_iso);
    const now = Date.parse(ctx.now_iso);

    if (Number.isNaN(issued) || Number.isNaN(expires) || Number.isNaN(now)) {
      return {
        status: "FAIL",
        expected: "parseable issued_at / expires_at / now timestamps",
        actual: "unparseable timestamp",
        reason_code: "STALE_PROPOSAL",
        human_message:
          "Proposal timestamp unparseable; treated as stale and declined (fail closed).",
        evidence: {
          issued_at_iso: ctx.proposal.issued_at_iso,
          expires_at_iso: ctx.proposal.expires_at_iso,
        },
      };
    }

    const skewSeconds = ctx.rules.proposal_max_future_skew_seconds;
    if (issued - now > skewSeconds * 1000) {
      return {
        status: "FAIL",
        expected: `issued_at <= now + ${skewSeconds}s future skew`,
        actual: `issued_at ${ctx.proposal.issued_at_iso} exceeds skew vs ${ctx.now_iso}`,
        reason_code: "FUTURE_ISSUED_AT",
        human_message: `Proposal claims issue time ${ctx.proposal.issued_at_iso}, more than ${skewSeconds}s ahead of evaluation time ${ctx.now_iso} — clock-attack shape declined.`,
        evidence: { issued_epoch_ms: issued, now_epoch_ms: now, max_future_skew_seconds: skewSeconds },
      };
    }

    const ageSeconds = Math.floor((now - issued) / 1000);
    const maxAge = ctx.rules.proposal_max_age_seconds;
    if (ageSeconds > maxAge) {
      return {
        status: "FAIL",
        expected: `age <= ${maxAge}s`,
        actual: `age ${ageSeconds}s`,
        reason_code: "STALE_PROPOSAL",
        human_message: `Proposal is ${ageSeconds}s old (limit ${maxAge}s); declined as stale.`,
        evidence: { age_seconds: ageSeconds, max_age_seconds: maxAge },
      };
    }

    if (expires < now) {
      return {
        status: "FAIL",
        expected: `expires_at >= evaluation time ${ctx.now_iso}`,
        actual: `expired at ${ctx.proposal.expires_at_iso}`,
        reason_code: "STALE_PROPOSAL",
        human_message: `Proposal validity lapsed at ${ctx.proposal.expires_at_iso}, before evaluation time ${ctx.now_iso}; declined as stale.`,
        evidence: { expires_epoch_ms: expires, now_epoch_ms: now },
      };
    }

    return {
      status: "PASS",
      human_message: `Proposal fresh: age ${ageSeconds}s (limit ${maxAge}s), valid until ${ctx.proposal.expires_at_iso}.`,
      evidence: {
        age_seconds: ageSeconds,
        max_age_seconds: maxAge,
        expires_at_iso: ctx.proposal.expires_at_iso,
      },
    };
  },
};
