/**
 * GK-INJECTION-GUARD (gatekeeper.md §6 row 15, §9 trigger 4) —
 * ESCALATE_IF_FAILED. Consumes the deterministic tagger's STRUCTURED verdict
 * — never raw text (invariant I-7: zero prose authority; the note itself is
 * unread by the gate). Escalates even when the resulting cart is fully
 * compliant: channel contamination warrants review regardless of whether the
 * manipulation succeeded (this is how the demo shows partial-compliance-then-catch).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";

export const injectionGuard: RuleDefinition = {
  id: "GK-INJECTION-GUARD",
  severity: "ESCALATE_IF_FAILED",
  dependsOn: [],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const sig = ctx.injection;
    if (sig.suspected) {
      return {
        status: "ESCALATE_TRIGGER",
        expected: "no injection patterns in customer channel",
        actual: `${sig.hits.length} pattern hit(s), risk score ${sig.risk_score}`,
        reason_code: "INJECTION_SUSPECTED",
        human_message: `Deterministic tagger flagged suspected prompt-injection in the customer note (risk score ${sig.risk_score}); escalating for review even though the gate never read the note.`,
        evidence: {
          risk_score: sig.risk_score,
          hits: sig.hits.map((h) => ({ pattern_id: h.pattern_id, snippet: h.snippet })),
          tagger_version: sig.tagger_version,
        },
      };
    }
    return {
      status: "PASS",
      human_message: "No injection patterns flagged in the customer channel.",
      evidence: { risk_score: sig.risk_score, tagger_version: sig.tagger_version },
    };
  },
};
