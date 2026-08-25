/**
 * Test fixtures for the gatekeeper suite (gatekeeper.md §12): Meera ground
 * truth + rules from shared, pinned clock NOW, factory helpers, and the
 * one-call `evaluate()` used by every matrix row. All inputs are deep-frozen
 * before evaluation (freeze tests assert no mutation — invariant I-1).
 */
import { deepClone, deepFreeze } from "./frozen.js";
import {
  MEERA_GT_V1,
  MEERA_RULES_V3,
  type AgentVelocitySnapshot,
  type GatekeeperResult,
  type GroundTruthSnapshot,
  type InjectionSignal,
  type MerchantRulesConfig,
  type ProposedCart,
} from "@growthagent/shared";
import { evaluateProposal } from "../engine.js";

/** Pinned simulation clock (gatekeeper.md §12). */
export const NOW = "2026-08-25T10:00:00Z";

export const meeraRules = (): MerchantRulesConfig =>
  deepFreeze(deepClone(MEERA_RULES_V3));

export const meeraGroundTruth = (): GroundTruthSnapshot =>
  deepFreeze(deepClone(MEERA_GT_V1));

export const cleanInjection = (): InjectionSignal =>
  deepFreeze(
    deepClone({
      suspected: false,
      risk_score: 0,
      hits: [],
      tagger_version: "tagger-v1.0",
    }),
  );

export const mkVelocity = (
  overrides: Partial<
    Extract<AgentVelocitySnapshot, { status: "AVAILABLE" }>
  > = {},
): AgentVelocitySnapshot =>
  deepFreeze(
    deepClone({
      status: "AVAILABLE",
      agent_identity_id: "buyer-agent-alpha",
      hour_window: {
        window_seconds: 3600,
        window_end_iso: NOW,
        request_count: 0,
        approved_value_paise: 0,
      },
      day_window: {
        window_seconds: 86400,
        window_end_iso: NOW,
        request_count: 0,
        approved_value_paise: 0,
      },
      prior_escalations_24h: 0,
      prior_declines_24h: 0,
      injection_flags_24h: 0,
      source: "redis_sliding_window_v1" as const,
      ...overrides,
    }),
  );

export const unavailableVelocity = (
  reason: "REDIS_UNREACHABLE" | "REDIS_TIMEOUT" | "CORRUPT_RECORD" | "IDENTITY_UNKNOWN" = "REDIS_TIMEOUT",
): AgentVelocitySnapshot =>
  deepFreeze(
    deepClone({
      status: "UNAVAILABLE",
      reason,
      detail: `chaos toggle: ${reason}`,
    }),
  );

type ProposalOverrides = Partial<ProposedCart>;

/**
 * Baseline happy cart (gatekeeper.md §8.4 / matrix row 1):
 * CAKE-CHOC-500 x1 + BRWN-BOX-9 x2 @ 7.5% → net ₹1,060.97, margin 37.79%.
 * AI-supplied totals match the recompute exactly.
 */
export function mkProposal(overrides: ProposalOverrides = {}): ProposedCart {
  return deepFreeze(
    deepClone({
      proposal_id: "prop-base-000001",
      tx_id: "tx-base-00000001",
      buyer_agent_identity_id: "buyer-agent-alpha",
      negotiation_run_id: "run-0001-base",
      lines: [
        { sku_id: "CAKE-CHOC-500", quantity: 1, citation_ids: ["E001"] },
        { sku_id: "BRWN-BOX-9", quantity: 2, citation_ids: ["E002"] },
      ],
      bundle_discount_pct: 7.5,
      bundle_discount_reason: "NEGOTIATION_CONCESSION",
      campaign_priority_id: null,
      ai_supplied_totals: {
        subtotal_paise: 114700,
        discount_paise: 8603,
        total_paise: 106097,
        claimed_blended_margin_pct: 37.79,
      },
      negotiation_summary_md:
        "Birthday bundle: truffle cake plus two brownie boxes at a modest 7.5% concession.",
      customer_note_raw: "Please deliver Friday evening. Happy birthday!",
      issued_at_iso: "2026-08-25T09:59:50Z", // NOW − 10s
      expires_at_iso: "2026-08-25T10:03:50Z", // NOW + 230s
      citations_audited: true,
      ...overrides,
    }),
  );
}

export interface EvaluateOverrides {
  rules?: Partial<MerchantRulesConfig>;
  velocity?: AgentVelocitySnapshot;
  injection?: InjectionSignal;
  now?: string;
  txId?: string;
  /** Replace the whole ground truth (default Meera's). */
  gt?: GroundTruthSnapshot;
}

export function evaluate(
  proposal: ProposedCart,
  overrides: EvaluateOverrides = {},
): GatekeeperResult {
  const rules = overrides.rules
    ? deepFreeze({ ...meeraRules(), ...overrides.rules })
    : meeraRules();
  const result = evaluateProposal({
    proposal,
    rules,
    ground_truth: overrides.gt ?? meeraGroundTruth(),
    velocity: overrides.velocity ?? mkVelocity(),
    injection: overrides.injection ?? cleanInjection(),
    now_iso: overrides.now ?? NOW,
    tx_id: overrides.txId ?? proposal.tx_id,
  });
  return deepFreeze(result);
}
