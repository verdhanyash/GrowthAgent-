/**
 * The 16-rule fixed-order registry (gatekeeper.md §6). Order is FIXED and
 * significant: structural gates first, money rules next, identity/context
 * rules last. Every rule runs on every call (invariant I-4).
 *
 * Completeness is compile-time: DEFINITIONS_BY_ID must fill Record<RuleId,
 * RuleDefinition>, so forgetting a rule breaks the build; RULE_REGISTRY is
 * emitted in shared RULE_IDS order (= the §6 table order).
 */
import { RULE_IDS, type RuleId } from "@growthagent/shared";
import type { AdvisoryCode, DeclineCode, EscalationCode } from "../ids.js";
import type { GateContext } from "../context.js";
import { citationGate } from "./citationGate.js";
import { rulesEffective } from "./rulesEffective.js";
import { proposalFreshness } from "./proposalFreshness.js";
import { cartStructure } from "./cartStructure.js";
import { skuResolution } from "./skuResolution.js";
import { totalsDrift } from "./totalsDrift.js";
import { cartValue } from "./cartValue.js";
import { discountCap } from "./discountCap.js";
import { marginFloor } from "./marginFloor.js";
import { categoryAllowlist } from "./categoryAllowlist.js";
import { stockAvailability } from "./stockAvailability.js";
import { expiryGuard } from "./expiryGuard.js";
import { velocityRequests } from "./velocityRequests.js";
import { velocityValue } from "./velocityValue.js";
import { injectionGuard } from "./injectionGuard.js";
import { repeatOffender } from "./repeatOffender.js";

export type Severity = "BLOCKER" | "ESCALATE_IF_FAILED" | "ADVISORY";

/** Pure verdict returned by one rule (gatekeeper.md §4).
 *  Documented normalizations vs the §4 sketch (§6 rows 2/6 are operative):
 *  1. FAIL.reason_code is widened to DeclineCode | EscalationCode — the two
 *     ESCALATE_IF_FAILED rules (GK-RULES-EFFECTIVE, GK-TOTALS-DRIFT) emit
 *     FAIL carrying ESCALATION codes.
 *  2. FAIL may carry `severityOverride` for the single dual-severity rule
 *     GK-TOTALS-DRIFT ("ADVISORY (minor) / ESCALATE_IF_FAILED (material)").
 *  3. ESCALATE_TRIGGER / UNAVAILABLE_INPUT / PASS may carry optional
 *     expected/actual strings — RuleEvaluationSchema renders both on every
 *     trace row, and §13 boundary rows pin expected/actual on PASSes too. */
export type RuleVerdict =
  | { readonly status: "PASS"; readonly human_message?: string;
      readonly expected?: string; readonly actual?: string;
      readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: "FAIL"; readonly expected: string; readonly actual: string;
      readonly reason_code: DeclineCode | EscalationCode; readonly human_message?: string;
      readonly severityOverride?: Severity;
      readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: "BAND"; readonly expected: string; readonly actual: string;
      readonly reason_code: EscalationCode; readonly human_message?: string;
      readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: "ESCALATE_TRIGGER";
      readonly reason_code: EscalationCode;
      readonly expected?: string; readonly actual?: string;
      readonly human_message?: string;
      readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: "UNAVAILABLE_INPUT"; readonly reason_code: EscalationCode;
      readonly expected?: string; readonly actual?: string;
      readonly human_message?: string;
      readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: "SKIP"; readonly because: string };

export interface RuleDefinition {
  readonly id: RuleId;
  /** Meaning of a FAIL from this rule. ADVISORY rules never affect outcome. */
  readonly severity: Severity;
  /** Rules that must have PASSED for this one to compute; otherwise SKIP. */
  readonly dependsOn: readonly RuleId[];
  /** Pure. Receives a frozen context; returns a verdict. Builds its own
   *  human_message from first-class numbers (never from AI prose). */
  readonly evaluate: (ctx: Readonly<GateContext>) => RuleVerdict;
}

const DEFINITIONS_BY_ID: Record<RuleId, RuleDefinition> = {
  "GK-CITATION-GATE": citationGate,
  "GK-RULES-EFFECTIVE": rulesEffective,
  "GK-PROPOSAL-FRESHNESS": proposalFreshness,
  "GK-CART-STRUCTURE": cartStructure,
  "GK-SKU-RESOLUTION": skuResolution,
  "GK-TOTALS-DRIFT": totalsDrift,
  "GK-CART-VALUE": cartValue,
  "GK-DISCOUNT-CAP": discountCap,
  "GK-MARGIN-FLOOR": marginFloor,
  "GK-CATEGORY-ALLOWLIST": categoryAllowlist,
  "GK-STOCK-AVAILABILITY": stockAvailability,
  "GK-EXPIRY-GUARD": expiryGuard,
  "GK-VELOCITY-REQUESTS": velocityRequests,
  "GK-VELOCITY-VALUE": velocityValue,
  "GK-INJECTION-GUARD": injectionGuard,
  "GK-REPEAT-OFFENDER": repeatOffender,
};

/** Fixed evaluation order = §6 table order (shared RULE_IDS array). */
export const RULE_REGISTRY: readonly RuleDefinition[] = RULE_IDS.map(
  (id) => DEFINITIONS_BY_ID[id],
);

/** Advisory codes surfacing inside rule evidence records. */
export const ADVISORY_CODES: readonly AdvisoryCode[] = [
  "LINES_MERGED",
  "PRICE_ECHO_MISMATCH",
  "TOTALS_DRIFT_MINOR",
] as const;

export function isDeclineCode(code: string): code is DeclineCode {
  return DECLINE_CODES.includes(code as DeclineCode);
}

const DECLINE_CODES: readonly DeclineCode[] = [
  "CITATION_GATE_FAILED", "STALE_PROPOSAL", "FUTURE_ISSUED_AT",
  "EMPTY_CART", "INVALID_QUANTITY", "INVALID_DISCOUNT_RANGE",
  "MALFORMED_NUMERIC", "UNKNOWN_SKU", "OVER_CART_VALUE",
  "OVER_DISCOUNT_CAP", "BELOW_MARGIN_FLOOR", "ZERO_NET_REVENUE",
  "CATEGORY_BLOCKED", "INSUFFICIENT_STOCK", "SKU_EXPIRED",
  "VELOCITY_REQUESTS", "VELOCITY_VALUE_EXCEEDED",
];

export const ESCALATION_CODES: readonly EscalationCode[] = [
  "RULES_NOT_YET_EFFECTIVE", "VALUE_IN_BAND", "DISCOUNT_IN_BAND",
  "VELOCITY_UNAVAILABLE", "INJECTION_SUSPECTED", "REPEAT_OFFENDER",
  "TOTALS_DRIFT_MATERIAL",
];
