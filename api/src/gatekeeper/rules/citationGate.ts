/**
 * GK-CITATION-GATE (gatekeeper.md §6 row 1) — BLOCKER.
 * Pipeline contract: the proposal must have passed the deterministic Citation
 * Auditor upstream. The gate does NOT re-verify citations (separation of
 * duties); it requires the flag. A hand-built object that bypassed zod and
 * omitted the field is treated as `false` (fail closed).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";

export const citationGate: RuleDefinition = {
  id: "GK-CITATION-GATE",
  severity: "BLOCKER",
  dependsOn: [],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    if (ctx.proposal.citations_audited !== true) {
      return {
        status: "FAIL",
        expected: "citations_audited === true (Citation Auditor verdict CLEAN or STRIPPED)",
        actual: "citations_audited !== true",
        reason_code: "CITATION_GATE_FAILED",
        human_message:
          "Proposal did not pass the citation audit pipeline contract; refusing to judge its numbers.",
        evidence: { citations_audited: ctx.proposal.citations_audited ?? null },
      };
    }
    return {
      status: "PASS",
      human_message: "Citation-audit pipeline contract satisfied.",
      evidence: { citations_audited: true },
    };
  },
};
