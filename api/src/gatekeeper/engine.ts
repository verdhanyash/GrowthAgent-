/**
 * THE checkpoint (gatekeeper.md §6.1). Pure, synchronous, total: builds the
 * context, runs EVERY registered rule in FIXED order (invariant I-4 — trace
 * length always equals registry length; skips recorded, never silent),
 * aggregates with DECLINE > ESCALATE > APPROVE precedence, and binds the
 * decision to its exact inputs via input_digest (invariant I-8).
 *
 * Throws ONLY ImpossibleStateError on programmer bug. Hostile/malformed input
 * never throws — it becomes FAIL rule entries (fail closed, not crash); an
 * unexpected fault inside any rule is likewise converted to a fail-closed
 * BLOCKER-looking FAIL rather than crashing the pipeline open.
 */
import type {
  GatekeeperResult,
  RuleEvaluation,
  RuleStatus,
  Severity,
} from "@growthagent/shared";
import { RULE_IDS } from "@growthagent/shared";
import { buildContext, type EvaluateProposalInput } from "./context.js";
import { aggregate } from "./aggregate.js";
import { sha256Hex } from "./digest.js";
import { ImpossibleStateError } from "./errors.js";
import { RULE_REGISTRY, type RuleDefinition, type RuleVerdict } from "./rules/registry.js";

function entry(
  rule: RuleDefinition,
  status: RuleStatus,
  severity: Severity,
  fields: {
    expected?: string | null;
    actual?: string | null;
    human_message: string;
    reason_code?: string | null;
    evidence?: Readonly<Record<string, unknown>> | undefined;
  },
): RuleEvaluation {
  return {
    rule_id: rule.id,
    status,
    severity,
    expected: fields.expected ?? null,
    actual: fields.actual ?? null,
    human_message: fields.human_message,
    reason_code: fields.reason_code ?? null,
    evidence: { ...(fields.evidence ?? {}) },
  };
}

function verdictToEntry(rule: RuleDefinition, v: RuleVerdict): RuleEvaluation {
  switch (v.status) {
    case "PASS":
      return entry(rule, "PASS", rule.severity, {
        expected: v.expected ?? null,
        actual: v.actual ?? null,
        human_message: v.human_message ?? `Rule ${rule.id} satisfied.`,
        evidence: v.evidence,
      });
    case "FAIL":
      // severityOverride supports the single dual-severity rule (GK-TOTALS-DRIFT).
      return entry(rule, "FAIL", v.severityOverride ?? rule.severity, {
        expected: v.expected,
        actual: v.actual,
        reason_code: v.reason_code,
        human_message:
          v.human_message ?? `Rule ${rule.id} failed (${v.reason_code}).`,
        evidence: v.evidence,
      });
    case "BAND":
      return entry(rule, "BAND", rule.severity, {
        expected: v.expected,
        actual: v.actual,
        reason_code: v.reason_code,
        human_message: v.human_message ?? `Rule ${rule.id} hit an escalation band.`,
        evidence: v.evidence,
      });
    case "ESCALATE_TRIGGER":
      return entry(rule, "ESCALATE_TRIGGER", rule.severity, {
        reason_code: v.reason_code,
        human_message: v.human_message ?? `Rule ${rule.id} triggered escalation.`,
        evidence: v.evidence,
      });
    case "UNAVAILABLE_INPUT":
      return entry(rule, "UNAVAILABLE_INPUT", rule.severity, {
        expected: v.expected ?? "required input available",
        actual: v.actual ?? "input unavailable",
        reason_code: v.reason_code,
        human_message:
          v.human_message ?? `Rule ${rule.id} could not run: required input unavailable.`,
        evidence: v.evidence,
      });
    case "SKIP":
      return entry(rule, "SKIP", rule.severity, {
        human_message: `Skipped: ${v.because}`,
        evidence: { because: v.because },
      });
  }
}

/** Fail-closed conversion of ANY unexpected rule fault (§6.1 safelyEvaluate). */
function faultToEntry(rule: RuleDefinition, err: unknown): RuleEvaluation {
  return entry(rule, "FAIL", rule.severity === "ADVISORY" ? "ADVISORY" : "BLOCKER", {
    expected: "rule evaluates cleanly",
    actual: `internal error: ${err instanceof Error ? err.name : "unknown"}`,
    reason_code: "MALFORMED_NUMERIC",
    human_message: `Rule ${rule.id} faulted internally and was failed CLOSED (never open).`,
    evidence: { internal_error: err instanceof Error ? err.message : String(err) },
  });
}

export function evaluateProposal(input: EvaluateProposalInput): GatekeeperResult {
  const ctx = buildContext(input);

  const trace: RuleEvaluation[] = [];
  const passed = new Set<string>();
  for (const rule of RULE_REGISTRY) {
    let e: RuleEvaluation;
    if (!rule.dependsOn.every((dep) => passed.has(dep))) {
      e = entry(rule, "SKIP", rule.severity, {
        human_message: `Skipped: dependency not satisfied (${rule.dependsOn.join(", ")})`,
        evidence: { because: `dependency not satisfied: ${rule.dependsOn.join(",")}` },
      });
    } else {
      try {
        e = verdictToEntry(rule, rule.evaluate(ctx));
      } catch (err) {
        if (err instanceof ImpossibleStateError) throw err; // programmer bug surfaces loudly
        e = faultToEntry(rule, err); // hostile world => fail closed, never crash open
      }
    }
    if (e.status === "PASS") passed.add(rule.id);
    trace.push(e);
  }

  const { outcome, declines, escalations } = aggregate(trace);

  let summaryPasses = 0;
  let summaryFails = 0;
  let summaryEscalationTriggers = 0;
  let summarySkips = 0;
  for (const e of trace) {
    if (e.status === "PASS") summaryPasses += 1;
    else if (e.status === "FAIL") summaryFails += 1;
    else if (
      e.status === "BAND" ||
      e.status === "ESCALATE_TRIGGER" ||
      e.status === "UNAVAILABLE_INPUT"
    )
      summaryEscalationTriggers += 1;
    else summarySkips += 1;
  }

  return {
    tx_id: input.tx_id,
    proposal_id: input.proposal.proposal_id,
    outcome,
    rules_version: input.rules.rules_version,
    evaluated_at_iso: input.now_iso, // injected clock echoed back
    input_digest: sha256Hex({
      proposal: input.proposal,
      rules_version: input.rules.rules_version,
      catalog_version: input.ground_truth.catalog_version,
      velocity: input.velocity,
      injection: input.injection,
      now_iso: input.now_iso,
    }),
    recomputed: ctx.totals,
    trace,
    summary: {
      total_rules: RULE_IDS.length,
      passed: summaryPasses,
      failed: summaryFails,
      escalation_triggers: summaryEscalationTriggers,
      skipped: summarySkips,
    },
    declines,
    escalations,
  };
}
