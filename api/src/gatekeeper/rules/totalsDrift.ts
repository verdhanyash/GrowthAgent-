/**
 * GK-TOTALS-DRIFT (gatekeeper.md §6 row 6, §9 trigger 6) — dual severity:
 * ADVISORY when the AI's total is within max(2, net·ppm/1e6) paise of the
 * recompute (normal model sloppiness); ESCALATE_IF_FAILED beyond it
 * (material drift = wrong or adversarial world-model). The FAIL verdict
 * carries `severityOverride` — the single documented extension to §4.
 *
 * Dependency on GK-SKU-RESOLUTION: drift is only meaningful once totals were
 * recomputed over resolved lines; otherwise it SKIPs.
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";
import { formatPaise } from "@growthagent/shared";

export const totalsDrift: RuleDefinition = {
  id: "GK-TOTALS-DRIFT",
  severity: "ADVISORY", // base severity; material FAILs override (below)
  dependsOn: ["GK-SKU-RESOLUTION"],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const { drift_paise, drift_threshold_paise } = ctx;
    if (ctx.drift_material) {
      return {
        status: "FAIL",
        expected: `|ai_total − recomputed_total| <= ${drift_threshold_paise} paise`,
        actual: `${drift_paise} paise`,
        reason_code: "TOTALS_DRIFT_MATERIAL",
        human_message: `AI-supplied total differs from gatekeeper-recomputed total by ${formatPaise(drift_paise)} (tolerance ${formatPaise(drift_threshold_paise)}); recomputed figures govern.`,
        severityOverride: "ESCALATE_IF_FAILED",
        evidence: {
          ai_total_paise: ctx.ai_totals.total_paise,
          recomputed_total_paise: ctx.totals.net_paise,
          drift_paise,
          threshold_paise: drift_threshold_paise,
        },
      };
    }
    return {
      status: "PASS",
      human_message:
        drift_paise > 0
          ? `AI total within tolerance: off by ${formatPaise(drift_paise)} (advisory TOTALS_DRIFT_MINOR).`
          : "AI total matches recompute exactly.",
      evidence: {
        ai_total_paise: ctx.ai_totals.total_paise,
        recomputed_total_paise: ctx.totals.net_paise,
        drift_paise,
        threshold_paise: drift_threshold_paise,
        ...(drift_paise > 0 ? { advisories: ["TOTALS_DRIFT_MINOR"] } : {}),
      },
    };
  },
};
