/**
 * Pure outcome fold (gatekeeper.md §6.2). Precedence: DECLINE > ESCALATE >
 * APPROVE. A proposal that simultaneously trips a blocker (e.g. 50% discount
 * over cap) and an escalation trigger (injection suspected) is DECLINED —
 * escalation causes remain visible in trace entries; they just do not change
 * the outcome. On APPROVE both reason arrays are empty.
 */
import type { GateOutcome, Reason, RuleEvaluation } from "@growthagent/shared";

export interface Aggregation {
  readonly outcome: GateOutcome;
  /** ALL blocker failures — populated iff DECLINE. */
  readonly declines: Reason[];
  /** ALL escalation causes — populated iff ESCALATE. */
  readonly escalations: Reason[];
}

function toReason(e: RuleEvaluation): Reason {
  return {
    rule_id: e.rule_id,
    reason_code: e.reason_code ?? "UNKNOWN",
    human_message: e.human_message,
  };
}

export function aggregate(trace: readonly RuleEvaluation[]): Aggregation {
  const blockers = trace.filter((e) => e.status === "FAIL" && e.severity === "BLOCKER");
  if (blockers.length > 0) {
    return { outcome: "DECLINE", declines: blockers.map(toReason), escalations: [] };
  }

  const escapers = trace.filter(
    (e) =>
      e.status === "BAND" ||
      e.status === "ESCALATE_TRIGGER" ||
      e.status === "UNAVAILABLE_INPUT" ||
      (e.status === "FAIL" && e.severity === "ESCALATE_IF_FAILED"),
  );
  if (escapers.length > 0) {
    return { outcome: "ESCALATE", declines: [], escalations: escapers.map(toReason) };
  }

  return { outcome: "APPROVE", declines: [], escalations: [] };
}
