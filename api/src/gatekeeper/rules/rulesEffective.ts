/**
 * GK-RULES-EFFECTIVE (gatekeeper.md §6 row 2) — ESCALATE_IF_FAILED.
 * The coordinator must select a rules version whose effective_from has passed.
 * Violation is a configuration incident, not buyer hostility — hence it goes
 * to a HUMAN (ESCALATE), not a hard decline (§9 trigger 7).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";

export const rulesEffective: RuleDefinition = {
  id: "GK-RULES-EFFECTIVE",
  severity: "ESCALATE_IF_FAILED",
  dependsOn: [],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const effectiveFrom = Date.parse(ctx.rules.effective_from_iso);
    const now = Date.parse(ctx.now_iso);
    // Unparseable config/clock => fail closed toward the human (config incident).
    if (Number.isNaN(effectiveFrom) || Number.isNaN(now)) {
      return {
        status: "FAIL",
        expected: "rules effective_from_iso parses; now_iso parses",
        actual: "unparseable timestamp",
        reason_code: "RULES_NOT_YET_EFFECTIVE",
        human_message:
          "Rules version timestamp unparseable — configuration incident requiring human review.",
        evidence: {
          effective_from_iso: ctx.rules.effective_from_iso,
          now_iso: ctx.now_iso,
          rules_version: ctx.rules.rules_version,
        },
      };
    }
    if (effectiveFrom > now) {
      return {
        status: "FAIL",
        expected: `rules_version ${ctx.rules.rules_version} effective by ${ctx.now_iso}`,
        actual: `effective_from ${ctx.rules.effective_from_iso} is in the future`,
        reason_code: "RULES_NOT_YET_EFFECTIVE",
        human_message: `Rules version ${ctx.rules.rules_version} takes effect at ${ctx.rules.effective_from_iso}, after evaluation time ${ctx.now_iso}; escalating to a human.`,
        evidence: {
          rules_version: ctx.rules.rules_version,
          effective_from_epoch_ms: effectiveFrom,
          now_epoch_ms: now,
        },
      };
    }
    return {
      status: "PASS",
      human_message: `Rules version ${ctx.rules.rules_version} effective since ${ctx.rules.effective_from_iso}.`,
      evidence: { rules_version: ctx.rules.rules_version },
    };
  },
};
