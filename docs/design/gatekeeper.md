# GrowthAgent — Gatekeeper Subsystem Design

**Component:** `gatekeeper` — THE deterministic, non-LLM money-path checkpoint
**Repo:** GrowthAgent monorepo (`shared/`, `api/`, `web/`) | **Track:** AI Growth & Agentic Commerce | **Date:** 2026-08-25

---

## 0. Scope and verification notes

The gatekeeper is the single deterministic backstop between everything the AI agents propose and anything that can move merchant money. This document specifies it completely: module layout, verbatim zod schemas and TypeScript signatures, evaluation semantics, integer money math, escalation triggers, edge cases, a 42-row unit-test matrix, property-based tests, and the formal "why this is not an LLM" argument for ARCHITECTURE.md.

**Externally verified in this pass** (Razorpay docs):
- Orders API `amount`: *"Payment amount in the smallest currency sub-unit"* — e.g. ₹299 is passed as `29900`. Currency: ISO 3-char code (`INR`). VERIFIED via https://razorpay.com/docs/api/orders/create/. Consequence: the gatekeeper's internal integer-paise discipline is byte-compatible with what settlement forwards to Razorpay — `recomputed.net_paise` becomes the order `amount` unchanged.
- Webhook event names seen verbatim in docs: `payment.authorized`, `order.paid`, `payment.failed`.

**NOT verified in this pass** (flagged honestly, relevant to adjacent subsystems, not to gatekeeper logic):
- The webhook signature header name and HMAC variant (the `/docs/payments/payment-webhooks/` URL returned 404; the webhooks landing page defers to a "Validate and Test Webhooks" page). The commonly documented values are header `x-razorpay-signature` and HMAC-SHA256-of-raw-body with the webhook secret — the settlement-agent section MUST re-verify these before implementation.
- `payment_capture` parameter semantics (not on the create-order page fetched).
- AP2/ACP protocol specifics: out of scope here by design. The gatekeeper deliberately treats the buyer agent's identity as an OPAQUE STRING (`buyer_agent_identity_id`). Any AP2 mandate/actor mapping happens upstream in the buyer-agent/pipeline layers; the gate never parses or trusts credential structure.

---

## 1. Role, position, and hard invariants

### 1.1 Position in the pipeline

```
buyer request -> pipeline orchestrator -> Evidence Pack -> campaign PrioritySet
      -> negotiation-upsell-agent (cited PROPOSED cart)
      -> Citation Auditor (deterministic)
      -> >>> GATEKEEPER (this document; deterministic, pure) <<<
              APPROVE  -> settlement-agent (Razorpay)
              DECLINE  -> explainer-agent narrates
              ESCALATE -> human approval UI -> settlement with SAME proposal
```

### 1.2 Mapping to the brief's tuple

Brief: `(proposedCart, merchantRules, agentIdentityHistory) -> decision`. The implemented signature widens this tuple for reasons the brief itself mandates; the mapping:

| Brief concept | Implemented parameter | Why widened |
|---|---|---|
| `proposedCart` | `proposal: ProposedCart` | post-citation-audit proposal |
| `merchantRules` | `rules: MerchantRulesConfig` | versioned config |
| `agentIdentityHistory` | `velocity: AgentVelocitySnapshot` | precomputed OUTSIDE, passed IN (purity) |
| *(implicit)* raw prices | `ground_truth: GroundTruthSnapshot` | brief requires the gate RECOMPUTE margins "from RAW cost/list prices"; therefore raw catalog must be an input |
| *(implicit)* injection signal | `injection: InjectionSignal` | the heuristic tagger is a separate deterministic service; the gate consumes its structured verdict, never raw text |
| *(implicit)* clock | `now_iso: string` | a pure function cannot call `Date.now()` |

### 1.3 Hard invariants (each is enforced by a named test)

1. **I-1 Pure:** same inputs => structurally equal outputs, forever. No IO, no clock, no randomness, no network, no globals mutated. Enforced by freeze + determinism tests and a dependency-cruiser import-boundary rule (§17).
2. **I-2 Recompute, never trust:** every monetary quantity the gate judges (subtotal, discount, total, blended margin) is recomputed from item-level RAW list/cost prices x qty taken from `ground_truth`. All AI-supplied numbers exist only in `ai_supplied_totals` and are diffed, never obeyed.
3. **I-3 Integer paise only:** decisions involve no binary floating-point arithmetic. Percentages become integer basis points exactly once at load; the single HALF_UP rounding event is the bundle-discount amount; allocation conserves paise exactly.
4. **I-4 Full trace always:** every registered rule emits a `RuleEvaluation` on every run — even rules that could not execute emit `SKIP`/`UNAVAILABLE_INPUT` with a reason. The trace array length ALWAYS equals the registry length. No silent short-circuiting.
5. **I-5 Fail closed:** any missing, malformed, or unavailable input degrades toward DECLINE/ESCALATE, never APPROVE. Unavailable velocity data => ESCALATE, by schema and by rule.
6. **I-6 Identity-agnostic rules:** identical carts from different agent identities face identical value/discount/margin/category/stock rules. Identity affects ONLY the velocity and repeat-offender dimensions.
7. **I-7 No prose authority:** `negotiation_summary_md` and `customer_note_raw` are carried for audit/UI. Zero rules read them. The gatekeeper cannot be persuaded, only numbered.
8. **I-8 Downstream binding:** `GatekeeperResult.input_digest` (sha256 of canonical inputs) is what settlement-agent must match before touching Razorpay; a human approval of an ESCALATE attaches to the SAME digest — approval never licenses a re-proposal.

### 1.4 What the gatekeeper deliberately does NOT do

No Razorpay calls. No Anthropic calls. No Postgres/Redis access. No regex scanning of customer notes (that lives in the deterministic injection-tagger service). No access to catalog-enrichment data (descriptions/tags/pairings are structurally absent from `GroundTruthSnapshot`). No price authority of its own — it has no ability to *change* a proposal, only to bless, refuse, or refer it to a human.

---

## 2. Module layout

```
api/src/gatekeeper/
├── index.ts                      # barrel: export { evaluateProposal }; re-export shared types
├── engine.ts                     # evaluateProposal(): context build -> registry run -> aggregate (~180 loc)
├── context.ts                    # buildContext(): merge dup lines, bps conversion, SKU index, totals recompute
├── aggregate.ts                  # pure outcome fold: DECLINE > ESCALATE > APPROVE; builds declines[]/escalations[]
├── money.ts                      # integer money primitives (toBps, mulDivRoundHalfUp,
│                                 #   allocateProportionally, crossMarginHolds, formatPaise, assertSafeInt)
├── ids.ts                        # RuleId union, DeclineCode/EscalationCode/AdvisoryCode unions
├── errors.ts                     # ImpossibleStateError (programmer-error signal; NEVER input-driven)
├── rules/
│   ├── registry.ts               # RULE_REGISTRY: readonly RuleDefinition[]; completeness typed via Record<RuleId, ...>
│   ├── citationGate.ts           # GK-CITATION-GATE
│   ├── rulesEffective.ts         # GK-RULES-EFFECTIVE
│   ├── proposalFreshness.ts      # GK-PROPOSAL-FRESHNESS
│   ├── cartStructure.ts          # GK-CART-STRUCTURE
│   ├── skuResolution.ts          # GK-SKU-RESOLUTION
│   ├── totalsDrift.ts            # GK-TOTALS-DRIFT
│   ├── cartValue.ts              # GK-CART-VALUE
│   ├── discountCap.ts            # GK-DISCOUNT-CAP
│   ├── marginFloor.ts            # GK-MARGIN-FLOOR
│   ├── categoryAllowlist.ts      # GK-CATEGORY-ALLOWLIST
│   ├── stockAvailability.ts      # GK-STOCK-AVAILABILITY
│   ├── expiryGuard.ts            # GK-EXPIRY-GUARD
│   ├── velocityRequests.ts       # GK-VELOCITY-REQUESTS
│   ├── velocityValue.ts          # GK-VELOCITY-VALUE
│   ├── injectionGuard.ts         # GK-INJECTION-GUARD
│   └── repeatOffender.ts         # GK-REPEAT-OFFENDER
└── __tests__/
    ├── engine.spec.ts            # aggregation precedence, determinism, purity/freeze
    ├── money.spec.ts             # conservation property, HALF_UP boundaries, cross-margin equivalence
    ├── rules.spec.ts             # the §13 matrix, one describe-block per rule id
    └── fixtures.ts               # Meera ground-truth fixture + mkProposal()/mkRules() factories

shared/src/schemas/gatekeeper.ts  # ALL zod schemas below (single source of truth; imported by api AND web,
                                  #   because web renders MerchantRulesConfig editor + DecisionTrace color-coded)
api/src/services/                 # IMPURE adapters living OUTSIDE the gatekeeper directory:
├── velocity-store.ts             # Redis sliding windows -> AgentVelocitySnapshot (interface in §16)
└── injection-tagger.ts           # deterministic regex/heuristics -> InjectionSignal (own unit tests)
```

Design rule: everything `web/` needs to render (rules config form, trace colors, approvals inbox) comes from `shared/src/schemas/gatekeeper.ts`; everything with side effects stays out of `api/src/gatekeeper/` entirely.

---

## 3. Data contracts — verbatim zod schemas

All in `shared/src/schemas/gatekeeper.ts`. Written against zod v3 API (`z.string().datetime()`); NOTE for zod v4 migration: datetime validators move to `z.iso.datetime()` — mark this comment in the file.

```ts
import { z } from 'zod';

/* ============================= primitives ============================= */

/** INTEGER PAISE. All money in the system is integer paise — no exceptions.
 *  Matches Razorpay Orders `amount` semantics ("smallest currency sub-unit"). */
export const Paise = z
  .number()
  .int('money must be integer paise')
  .nonnegative()
  .lte(Number.MAX_SAFE_INTEGER);

/** Percentages validated as decimals (e.g. 7.5). Converted to integer basis
 *  points ONCE at config/proposal load; decisions never see floats. */
export const Pct = z.number().min(0).max(100);

const IsoDateTime = z.string().datetime({ offset: false }); // zod v4: z.iso.datetime()

/* ========================= MerchantRulesConfig ======================== */

export const CategoryAllowlistModeSchema = z.enum(['ALL_ALLOWED', 'ALLOWLIST']);

export const StockPolicySchema = z.object({
  /** true => any line whose qty exceeds stock_on_hand blocks approval */
  require_full_availability: z.boolean(),
  /** SKUs exempt from require_full_availability (made-to-order items) */
  backorder_allowed_skus: z.array(z.string().min(1)).max(50).default([]),
  reservation_ttl_seconds: z.number().int().positive().max(3600),
}).strict();

export const ExpiryPolicySchema = z.object({
  /** SKUs whose sell_by has passed are unsellable through the agent pipeline */
  block_expired_skus: z.boolean(),
}).strict();

export const RepeatOffenderPolicySchema = z.object({
  escalations_24h_threshold: z.number().int().positive(),   // >= triggers
  declines_24h_threshold: z.number().int().positive(),      // >= triggers
  injection_flags_24h_threshold: z.number().int().positive(), // >= triggers
}).strict();

export const PerAgentVelocitySchema = z.object({
  /** Max requests attributable to one agent identity in any rolling 3600s
   *  window INCLUDING the request being evaluated. */
  max_requests_per_hour: z.number().int().positive(),
  /** Max APPROVED (reserved/settled) value attributable to one identity in any
   *  rolling 86400s window INCLUDING the proposal being evaluated. Declines do
   *  not consume budget but DO count toward request_count. */
  max_value_per_day_paise: Paise,
  /** Frozen literal: documents that unknown velocity can only fail closed. */
  unavailable_snapshot_policy: z.literal('ESCALATE_FAIL_CLOSED'),
}).strict();

export const EscalationBandsSchema = z.object({
  /** Cart totals in [cap*(1 - x/100), cap] ESCALATE instead of auto-approving.
   *  0 disables the band. Both edges inclusive. */
  cart_value_band_pct_below_cap: Pct,
  /** Discounts within y percentage points BELOW the cap ([cap-y, cap]) ESCALATE.
   *  0 disables. Inclusive edges. At-or-over the cap remains a hard FAIL. */
  discount_band_pp_below_cap: Pct,
}).strict();

export const MerchantRulesConfigSchema = z.object({
  /** Monotonically increasing. Every decision records the version judged under.
   *  Config rows are INSERT-ONLY in Postgres (never UPDATE). */
  rules_version: z.number().int().positive(),
  effective_from_iso: IsoDateTime,
  currency: z.literal('INR'),

  /* ---- hard ceilings / floors (all INCLUSIVE at the limit) ---- */
  max_cart_value_paise: Paise,
  max_discount_pct: Pct,
  margin_floor_pct: Pct,

  category_allowlist_mode: CategoryAllowlistModeSchema,
  /** Consulted only when mode === 'ALLOWLIST'; ignored otherwise. Categories
   *  compared are the MERCHANT-ASSIGNED category_raw — never enrichment tags. */
  category_allowlist: z.array(z.string().min(1)).max(50),

  per_agent_velocity: PerAgentVelocitySchema,
  escalation_bands: EscalationBandsSchema,
  stock_policy: StockPolicySchema,
  expiry_policy: ExpiryPolicySchema,
  repeat_offender: RepeatOffenderPolicySchema,

  /** Proposal older than this (expires_at aside) is stale => DECLINE. */
  proposal_max_age_seconds: z.number().int().positive().default(300),
  /** issued_at more than this far in the future => clock attack => DECLINE. */
  proposal_max_future_skew_seconds: z.number().int().nonnegative().default(60),
  /** |ai_total - recomputed_total| beyond max(2, net*ppm/1e6) paise => ESCALATE. */
  totals_drift_material_frac_ppm: z.number().int().positive().default(10_000), // 1%
}).strict()
  .superRefine((cfg, ctx) => {
    if (cfg.category_allowlist_mode === 'ALLOWLIST' && cfg.category_allowlist.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['category_allowlist'],
        message: 'ALLOWLIST mode requires >=1 category (use ALL_ALLOWED instead)' });
    }
    if (cfg.escalation_bands.cart_value_band_pct_below_cap >= 100 &&
        cfg.escalation_bands.cart_value_band_pct_below_cap > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['escalation_bands'],
        message: 'value band of 100% covers the whole domain; pick a smaller band' });
    }
    if (cfg.per_agent_velocity.max_value_per_day_paise < cfg.max_cart_value_paise) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['per_agent_velocity'],
        message: 'daily value cap below single-cart cap makes every cart fail; raise it' });
    }
  });

export type MerchantRulesConfig = z.infer<typeof MerchantRulesConfigSchema>;
```

### 3.1 ProposedCart (input — AFTER citation auditing)

```ts
export const ProposedCartLineSchema = z.object({
  sku_id: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, 'canonical SKU id'),
  quantity: z.number().int().positive().max(999),
  /** AI's echo of the unit price. ADVISORY ONLY — the gatekeeper recomputes
   *  from ground truth; mismatch is recorded, never obeyed. */
  claimed_unit_price_paise: Paise.optional(),
  /** Citation IDs ALREADY VERIFIED by the deterministic Citation Auditor
   *  upstream; carried for trace correlation. The gate does NOT re-verify
   *  citations (separation of duties) but DOES require the flag below. */
  citation_ids: z.array(z.string().min(1)).max(20).default([]),
}).strict();

/** KEPT FOR DIFFING ONLY — deliberately loose inner types so that even garbage
 *  the negotiation model emits can flow in and be NOTICED by the drift rule. */
export const AiSuppliedTotalsSchema = z.object({
  subtotal_paise: z.number(),
  discount_paise: z.number(),
  total_paise: z.number(),
  claimed_blended_margin_pct: z.number().optional(),
}).strict();

export const BundleDiscountReasonSchema = z.enum([
  'NONE', 'CAMPAIGN_PRIORITY', 'NEGOTIATION_CONCESSION', 'PROMO_CODE',
]);

export const ProposedCartSchema = z.object({
  proposal_id: z.string().min(8).max(64),
  tx_id: z.string().min(8).max(64),

  /** Velocity subject: the external buyer-agent identity (hashed-key holder). */
  buyer_agent_identity_id: z.string().min(3).max(64),
  /** Attribution only: which negotiation run produced this. Not a rule subject. */
  negotiation_run_id: z.string().min(3).max(128),

  lines: z.array(ProposedCartLineSchema).max(25),

  bundle_discount_pct: Pct,
  bundle_discount_reason: BundleDiscountReasonSchema,
  campaign_priority_id: z.string().max(64).nullable().default(null),

  /** NEVER TRUSTED. Diffed against gatekeeper-recomputed values. */
  ai_supplied_totals: AiSuppliedTotalsSchema,

  /** The AI's persuasive pitch. Copied verbatim into the trace as
   *  UNTRUSTED_AI_CLAIMS; ZERO rules read it (invariant I-7). */
  negotiation_summary_md: z.string().max(4000).default(''),

  /** Verbatim customer note. Read by the separate deterministic injection
   *  tagger — NOT by the gatekeeper, which receives only InjectionSignal. */
  customer_note_raw: z.string().max(2000).default(''),

  issued_at_iso: IsoDateTime,
  expires_at_iso: IsoDateTime,

  /** Pipeline contract. If false, GK-CITATION-GATE BLOCKERs immediately. */
  citations_audited: z.boolean(),
}).strict()
  .refine((c) => c.lines.length > 0, { message: 'empty cart', path: ['lines'] });

export type ProposedCart = z.infer<typeof ProposedCartSchema>;
export type ProposedCartLine = z.infer<typeof ProposedCartLineSchema>;
```

### 3.2 GroundTruthSnapshot (raw merchant truth — the ONLY pricing source)

```ts
export const CatalogItemGroundTruthSchema = z.object({
  sku_id: z.string(),
  name_raw: z.string(),        // merchant-entered
  category_raw: z.string(),    // merchant-assigned category
  list_price_paise: Paise,
  cost_price_paise: Paise,
  stock_on_hand: z.number().int().nonnegative(),
  sell_by_iso: IsoDateTime.nullable(),
}).strict();
// TRUST RULE ENCODED IN THE TYPE: enrichment fields (descriptions, tags,
// occasions, pairings) are STRUCTURALLY ABSENT here. Their absence IS the
// rule "enrichment never becomes authoritative for price/cost/stock".

export const GroundTruthSnapshotSchema = z.object({
  merchant_id: z.string(),
  catalog_version: z.string(),
  taken_at_iso: IsoDateTime,
  items: z.array(CatalogItemGroundTruthSchema).max(500),
}).strict();

export type GroundTruthSnapshot = z.infer<typeof GroundTruthSnapshotSchema>;
export type CatalogItemGroundTruth = z.infer<typeof CatalogItemGroundTruthSchema>;
```

### 3.3 AgentVelocitySnapshot (history passed IN; explicit UNAVAILABLE semantics)

```ts
export const VelocityWindowStatSchema = z.object({
  window_seconds: z.union([z.literal(3600), z.literal(86400)]),
  window_end_iso: IsoDateTime,            // == snapshot taken_at
  /** Requests attributed to this identity in (end - seconds, end].
   *  EXCLUDES the proposal under evaluation — the engine adds +1 itself
   *  (documented convention; kills the classic off-by-one). */
  request_count: z.number().int().nonnegative(),
  /** APPROVED (reserved/settled) value in the same window. Declines don't
   *  consume budget but DO count in request_count (spam detection). */
  approved_value_paise: Paise,
}).strict();

export const AgentVelocitySnapshotSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('AVAILABLE'),
    agent_identity_id: z.string(),
    hour_window: VelocityWindowStatSchema,
    day_window: VelocityWindowStatSchema,
    prior_escalations_24h: z.number().int().nonnegative(),
    prior_declines_24h: z.number().int().nonnegative(),
    injection_flags_24h: z.number().int().nonnegative(),
    source: z.literal('redis_sliding_window_v1'),
  }),
  z.object({
    status: z.literal('UNAVAILABLE'),
    /** Fail-closed taxonomy: WHY we don't know, so the audit log is honest. */
    reason: z.enum(['REDIS_UNREACHABLE', 'REDIS_TIMEOUT',
                    'CORRUPT_RECORD', 'IDENTITY_UNKNOWN']),
    detail: z.string().max(500),
  }),
]);

export type AgentVelocitySnapshot = z.infer<typeof AgentVelocitySnapshotSchema>;

/** Semantics (normative):
 *  - AVAILABLE  => both velocity rules evaluate numerically.
 *  - UNAVAILABLE => both velocity rules emit status UNAVAILABLE_INPUT with
 *    reason_code VELOCITY_UNAVAILABLE => outcome is ESCALATE (never APPROVE,
 *    never silent pass). There is no third "UNKNOWN" state: absence of data
 *    is data, and it means "we do not know this agent is safe". */
```

### 3.4 InjectionSignal (from the deterministic tagger, outside LLM trust)

```ts
export const InjectionPatternHitSchema = z.object({
  pattern_id: z.string().min(1).max(64),  // e.g. 'authority_claim', 'discount_token'
  snippet: z.string().max(160),           // trimmed match; drives the UI's RED banner
}).strict();

export const InjectionSignalSchema = z.object({
  suspected: z.boolean(),
  risk_score: z.number().min(0).max(100), // deterministic heuristic; display only
  hits: z.array(InjectionPatternHitSchema).max(10),
  tagger_version: z.string().min(1),
}).strict();

export type InjectionSignal = z.infer<typeof InjectionSignalSchema>;
```

### 3.5 DecisionTrace and GatekeeperResult

```ts
export const RuleStatusSchema = z.enum([
  'PASS',                // rule satisfied
  'FAIL',                // rule violated -> consequence per severity
  'BAND',                // inside an escalation band (soft edge) -> ESCALATE
  'ESCALATE_TRIGGER',    // qualitative trigger (injection, repeat offender)
  'UNAVAILABLE_INPUT',   // required input missing/unavailable -> ESCALATE (fail closed)
  'SKIP',                // could not run because a dependency failed -> neutral,
]);                     //   reason recorded; NEVER silently absent

export const SeveritySchema = z.enum(['BLOCKER', 'ESCALATE_IF_FAILED', 'ADVISORY']);

export const RuleEvaluationSchema = z.object({
  rule_id: z.string(),                    // RuleId union at the type level (§4)
  status: RuleStatusSchema,
  severity: SeveritySchema,
  expected: z.string().nullable(),        // human bound, e.g. '<= ₹5,000.00'
  actual: z.string().nullable(),          // observation, e.g. '₹5,123.45'
  human_message: z.string(),              // mechanical sentence w/ concrete numbers;
                                          //   never quotes or paraphrases AI prose as fact
  reason_code: z.string().nullable(),     // DeclineCode | EscalationCode | AdvisoryCode
  evidence: z.record(z.unknown()),        // structured numbers for UI + tests,
                                          //   e.g. { cap_paise: 500000, total_paise: 500123 }
}).strict();

export const RecomputedTotalsSchema = z.object({
  line_count: z.number().int().nonnegative(),
  gross_paise: Paise,
  discount_paise: Paise,
  net_paise: Paise,                       // == what settlement sends as Razorpay `amount`
  cost_paise: Paise,
  margin_paise: z.number().int(),         // may be negative
  blended_margin_bps: z.number().int(),   // display only: floor(M*10000/N); decision
                                          //   used exact cross-multiplication (§8.3)
  per_line: z.array(z.object({
    sku_id: z.string(),
    quantity: z.number().int(),
    gross_paise: Paise,
    discount_alloc_paise: Paise,
    net_paise: Paise,
    cost_paise: Paise,
    margin_paise: z.number().int(),
  }).strict()),
}).strict();

export const GateOutcomeSchema = z.enum(['APPROVE', 'DECLINE', 'ESCALATE']);

export const ReasonSchema = z.object({
  rule_id: z.string(),
  reason_code: z.string(),
  human_message: z.string(),
}).strict();

export const GatekeeperResultSchema = z.object({
  tx_id: z.string(),
  proposal_id: z.string(),
  outcome: GateOutcomeSchema,
  rules_version: z.number().int().positive(),
  evaluated_at_iso: IsoDateTime,          // == input.now_iso (injected clock echoed)
  input_digest: z.string().length(64),    // sha256(canonicalJson(inputs)) — binds the
                                          //   decision to the EXACT inputs (audit chain +
                                          //   escalation re-entry binding, §18.8)
  recomputed: RecomputedTotalsSchema,
  trace: z.array(RuleEvaluationSchema),   // INVARIANT: length === RULE_REGISTRY.length, always
  summary: z.object({
    total_rules: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    escalation_triggers: z.number().int(),
    skipped: z.number().int(),
  }).strict(),
  declines: z.array(ReasonSchema),        // ALL blocker failures, populated iff DECLINE
  escalations: z.array(ReasonSchema),     // ALL escalation causes, populated iff ESCALATE
}).strict();

export type RuleEvaluation = z.infer<typeof RuleEvaluationSchema>;
export type GatekeeperResult = z.infer<typeof GatekeeperResultSchema>;
export type GateOutcome = z.infer<typeof GateOutcomeSchema>;
```

### 3.6 Reason-code unions (`ids.ts`)

```ts
export const RULE_IDS = [
  'GK-CITATION-GATE', 'GK-RULES-EFFECTIVE', 'GK-PROPOSAL-FRESHNESS',
  'GK-CART-STRUCTURE', 'GK-SKU-RESOLUTION', 'GK-TOTALS-DRIFT',
  'GK-CART-VALUE', 'GK-DISCOUNT-CAP', 'GK-MARGIN-FLOOR',
  'GK-CATEGORY-ALLOWLIST', 'GK-STOCK-AVAILABILITY', 'GK-EXPIRY-GUARD',
  'GK-VELOCITY-REQUESTS', 'GK-VELOCITY-VALUE', 'GK-INJECTION-GUARD',
  'GK-REPEAT-OFFENDER',
] as const;
export type RuleId = typeof RULE_IDS[number];

export type DeclineCode =
  | 'CITATION_GATE_FAILED' | 'STALE_PROPOSAL' | 'FUTURE_ISSUED_AT'
  | 'EMPTY_CART' | 'INVALID_QUANTITY' | 'INVALID_DISCOUNT_RANGE'
  | 'MALFORMED_NUMERIC' | 'UNKNOWN_SKU' | 'OVER_CART_VALUE'
  | 'OVER_DISCOUNT_CAP' | 'BELOW_MARGIN_FLOOR' | 'ZERO_NET_REVENUE'
  | 'CATEGORY_BLOCKED' | 'INSUFFICIENT_STOCK' | 'SKU_EXPIRED';

export type EscalationCode =
  | 'RULES_NOT_YET_EFFECTIVE' | 'VALUE_IN_BAND' | 'DISCOUNT_IN_BAND'
  | 'VELOCITY_UNAVAILABLE' | 'INJECTION_SUSPECTED' | 'REPEAT_OFFENDER'
  | 'TOTALS_DRIFT_MATERIAL';

export type AdvisoryCode = 'LINES_MERGED' | 'PRICE_ECHO_MISMATCH' | 'TOTALS_DRIFT_MINOR';
```

### 3.7 Default Meera rules (seed constant, `fixtures.ts` / seed script)

```ts
export const MEERA_RULES_V3: MerchantRulesConfig = {
  rules_version: 3,
  effective_from_iso: '2026-08-01T00:00:00Z',
  currency: 'INR',
  max_cart_value_paise: 500_000,          // ₹5,000.00
  max_discount_pct: 15,
  margin_floor_pct: 25,
  category_allowlist_mode: 'ALLOWLIST',
  category_allowlist: ['CAKES', 'BROWNIES', 'COOKIES', 'HAMPERS', 'BREADS'],
  per_agent_velocity: {
    max_requests_per_hour: 12,
    max_value_per_day_paise: 2_000_000,   // ₹20,000.00/day
    unavailable_snapshot_policy: 'ESCALATE_FAIL_CLOSED',
  },
  escalation_bands: { cart_value_band_pct_below_cap: 15, discount_band_pp_below_cap: 5 },
  stock_policy: { require_full_availability: true, backorder_allowed_skus: [],
                  reservation_ttl_seconds: 900 },
  expiry_policy: { block_expired_skus: true },
  repeat_offender: { escalations_24h_threshold: 2, declines_24h_threshold: 5,
                     injection_flags_24h_threshold: 1 },
  proposal_max_age_seconds: 300,
  proposal_max_future_skew_seconds: 60,
  totals_drift_material_frac_ppm: 10_000,
};

/** Ground-truth fixture used across the test matrix (costs chosen so margins are
 *  realistic for a home bakery; HAMP-DIW-05 = underselling seed, CKI-KAJU-250 =
 *  near-expiry seed). */
export const MEERA_GT_V1: GroundTruthSnapshot = {
  merchant_id: 'meeras-cakes',
  catalog_version: 'gt-2026-08-25.1',
  taken_at_iso: '2026-08-25T09:00:00Z',
  items: [
    { sku_id: 'CAKE-CHOC-500', name_raw: 'Chocolate Truffle Cake 500g', category_raw: 'CAKES',
      list_price_paise: 64_900, cost_price_paise: 38_000, stock_on_hand: 10, sell_by_iso: null },
    { sku_id: 'BRWN-BOX-9',    name_raw: 'Brownie Box (9 pc)',          category_raw: 'BROWNIES',
      list_price_paise: 24_900, cost_price_paise: 14_000, stock_on_hand: 40, sell_by_iso: null },
    { sku_id: 'CKI-KAJU-250',  name_raw: 'Kaju Cookie Box 250g',        category_raw: 'COOKIES',
      list_price_paise: 19_900, cost_price_paise: 9_000,  stock_on_hand: 25,
      sell_by_iso: '2026-08-27T23:59:59Z' },                       // near-expiry seed
    { sku_id: 'HAMP-DIW-05',   name_raw: 'Diwali Hamper #5',           category_raw: 'HAMPERS',
      list_price_paise: 199_900, cost_price_paise: 115_000, stock_on_hand: 6,
      sell_by_iso: null },                                          // underselling seed
    { sku_id: 'BRED-SOUR-1',   name_raw: 'Sourdough Loaf',             category_raw: 'BREADS',
      list_price_paise: 15_900, cost_price_paise: 11_000, stock_on_hand: 3, sell_by_iso: null },
  ],
};
```

---

## 4. Public API — exact pure-function signatures

```ts
// api/src/gatekeeper/index.ts
import type {
  ProposedCart, MerchantRulesConfig, GroundTruthSnapshot,
  AgentVelocitySnapshot, InjectionSignal, GatekeeperResult,
} from '@growthagent/shared';

export interface EvaluateProposalInput {
  readonly proposal: ProposedCart;             // POST citation-audit
  readonly rules: MerchantRulesConfig;         // versioned; coordinator selects effective version
  readonly ground_truth: GroundTruthSnapshot;  // RAW catalog/stock/cost (only pricing authority)
  readonly velocity: AgentVelocitySnapshot;    // history projected OUTSIDE, passed IN (purity)
  readonly injection: InjectionSignal;         // deterministic tagger output
  readonly now_iso: string;                    // injected clock — the function owns none
  readonly tx_id: string;                      // assigned by the pipeline orchestrator
}

/** THE checkpoint. Pure, synchronous, total (returns for every input; throws
 *  only ImpossibleStateError on programmer error, never on hostile input). */
export function evaluateProposal(input: EvaluateProposalInput): GatekeeperResult;
```

Supporting types:

```ts
// api/src/gatekeeper/rules/registry.ts
export type RuleVerdict =
  | { readonly status: 'PASS'; readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: 'FAIL'; readonly expected: string; readonly actual: string;
      readonly reason_code: DeclineCode; readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: 'BAND'; readonly expected: string; readonly actual: string;
      readonly reason_code: EscalationCode; readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: 'ESCALATE_TRIGGER'; readonly reason_code: EscalationCode;
      readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: 'UNAVAILABLE_INPUT'; readonly reason_code: EscalationCode;
      readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly status: 'SKIP'; readonly because: string };

export interface RuleDefinition {
  readonly id: RuleId;
  /** Meaning of a FAIL from this rule. ADVISORY rules never affect outcome. */
  readonly severity: 'BLOCKER' | 'ESCALATE_IF_FAILED' | 'ADVISORY';
  /** Rules that must have PASSED for this one to compute; otherwise SKIP. */
  readonly dependsOn: readonly RuleId[];
  /** Pure. Receives a frozen context; returns a verdict. Builds its own
   *  human_message from first-class numbers (never from AI prose). */
  readonly evaluate: (ctx: Readonly<GateContext>) => RuleVerdict;
}

/** Compile-time completeness: forgetting a rule breaks the build. */
export const RULE_REGISTRY: readonly RuleDefinition[] = /* ordered per §6 */;
type _RegistryComplete = Record<RuleId, RuleDefinition>; // registry checked against this shape in a type test

// api/src/gatekeeper/context.ts (internal; exported for white-box tests)
export interface GateContext {
  readonly tx_id: string;
  readonly now_iso: string;
  readonly rules: MerchantRulesConfig;
  readonly rules_bps: { readonly cartCap: number; readonly discCapBps: number;
                        readonly marginFloorBps: number;
                        readonly valBandLowerEdgePaise: number;
                        readonly discBandLowerBps: number };
  readonly proposal: ProposedCart;
  readonly merged_lines: readonly ProposedCartLine[];  // duplicates merged (§7)
  readonly sku_index: ReadonlyMap<string, CatalogItemGroundTruth>;
  readonly unresolved_skus: readonly string[];
  readonly totals: RecomputedTotals;                   // §8 math
  readonly ai_totals: AiSuppliedTotals;
  readonly drift_paise: number;
  readonly drift_material: boolean;
  readonly velocity: AgentVelocitySnapshot;
  readonly injection: InjectionSignal;
}

// api/src/gatekeeper/errors.ts
export class ImpossibleStateError extends Error {}
// Thrown ONLY when an internal invariant that the type system cannot express
// is violated (programmer bug). Hostile/malformed INPUT never reaches this
// path — it becomes a FAIL rule entry instead (fail closed, not crash).
```

---

## 5. Recompute-vs-trust policy

| Field on the proposal | Gatekeeper treatment |
|---|---|
| `lines[].quantity` | TRUSTED as intent (after structural validation: int, >0, <=999) |
| `lines[].sku_id` | Trusted as reference; RESOLVED against `ground_truth`; unknown => DECLINE |
| `lines[].claimed_unit_price_paise` | IGNORED for math. Mismatch vs raw list price => ADVISORY `PRICE_ECHO_MISMATCH` |
| `ai_supplied_totals.*` | IGNORED for math. Diffed vs recompute: drift <= max(2, 1% of net) => ADVISORY `TOTALS_DRIFT_MINOR`; larger => ESCALATE `TOTALS_DRIFT_MATERIAL` |
| `bundle_discount_pct` | Treated as the CLAIMED commercial term — validated structurally (0..100) and judged against the cap, but the AMOUNT is computed from it, not read from any AI-supplied rupee figure |
| `negotiation_summary_md` | Never parsed by any rule. Verbatim into trace as untrusted claims |
| `customer_note_raw` | Never seen by the gate at all (tagger consumed it upstream) |
| `campaign_priority_id`, `citation_ids`, `negotiation_run_id` | Attribution metadata only; copied to trace |
| `issued_at_iso` / `expires_at_iso` | Judged against injected `now_iso` (freshness/skew/expiry) |
| `citations_audited` | Must be `true`; else GK-CITATION-GATE blocker |

Everything the outcome depends on numerically traces to `GroundTruthSnapshot` + `MerchantRulesConfig` + `AgentVelocitySnapshot` + `InjectionSignal` + `now_iso` — five inputs, all hash-chained into `input_digest`.

---

## 6. Rule registry: evaluation ORDER, severities, dependencies

Order is FIXED and significant: structural gates first (cheap, and they produce the context later rules need), money rules next, identity/context rules last. Every rule runs on every call.

| # | rule_id | severity of FAIL | dependsOn | Emits non-PASS statuses |
|---|---|---|---|---|
| 1 | GK-CITATION-GATE | BLOCKER | — | FAIL `CITATION_GATE_FAILED` |
| 2 | GK-RULES-EFFECTIVE | ESCALATE_IF_FAILED | — | FAIL `RULES_NOT_YET_EFFECTIVE` (config error => human) |
| 3 | GK-PROPOSAL-FRESHNESS | BLOCKER | — | FAIL `STALE_PROPOSAL` / `FUTURE_ISSUED_AT` |
| 4 | GK-CART-STRUCTURE | BLOCKER | — | FAIL `EMPTY_CART`, `INVALID_QUANTITY`, `INVALID_DISCOUNT_RANGE`, `MALFORMED_NUMERIC`; carries `LINES_MERGED` advisory in evidence |
| 5 | GK-SKU-RESOLUTION | BLOCKER | GK-CART-STRUCTURE | FAIL `UNKNOWN_SKU` |
| 6 | GK-TOTALS-DRIFT | ADVISORY (minor) / ESCALATE_IF_FAILED (material) | GK-SKU-RESOLUTION | FAIL `TOTALS_DRIFT_MATERIAL` · PASS w/ evidence drift paise |
| 7 | GK-CART-VALUE | BLOCKER | GK-SKU-RESOLUTION | FAIL `OVER_CART_VALUE` · BAND `VALUE_IN_BAND` |
| 8 | GK-DISCOUNT-CAP | BLOCKER | GK-CART-STRUCTURE | FAIL `OVER_DISCOUNT_CAP` · BAND `DISCOUNT_IN_BAND` |
| 9 | GK-MARGIN-FLOOR | BLOCKER | GK-SKU-RESOLUTION, GK-TOTALS-DRIFT | FAIL `BELOW_MARGIN_FLOOR` / `ZERO_NET_REVENUE` |
| 10 | GK-CATEGORY-ALLOWLIST | BLOCKER | GK-SKU-RESOLUTION | FAIL `CATEGORY_BLOCKED` |
| 11 | GK-STOCK-AVAILABILITY | BLOCKER | GK-SKU-RESOLUTION | FAIL `INSUFFICIENT_STOCK` |
| 12 | GK-EXPIRY-GUARD | BLOCKER | GK-SKU-RESOLUTION | FAIL `SKU_EXPIRED` |
| 13 | GK-VELOCITY-REQUESTS | BLOCKER | — | FAIL `VELOCITY_REQUESTS` · UNAVAILABLE_INPUT `VELOCITY_UNAVAILABLE` |
| 14 | GK-VELOCITY-VALUE | BLOCKER | GK-SKU-RESOLUTION | FAIL `VELOCITY_VALUE_EXCEEDED` · UNAVAILABLE_INPUT `VELOCITY_UNAVAILABLE` |
| 15 | GK-INJECTION-GUARD | ESCALATE_IF_FAILED | — | ESCALATE_TRIGGER `INJECTION_SUSPECTED` |
| 16 | GK-REPEAT-OFFENDER | ESCALATE_IF_FAILED | — | ESCALATE_TRIGGER `REPEAT_OFFENDER` |

Notes:
- Margin floor has NO soft band by design: margin is merchant solvency, not convenience — a cliff, not a dial. Bands exist only where crossing slightly is commercially plausible and human judgment adds value (value, discount).
- Duplicate-SKU merging happens in `buildContext` BEFORE any rule runs; the merge is recorded as evidence on GK-CART-STRUCTURE (`LINES_MERGED` advisory), so the trace shows the normalization that occurred.

### 6.1 Engine pseudocode

```ts
export function evaluateProposal(input: EvaluateProposalInput): GatekeeperResult {
  const ctx = buildContext(input);            // pure: §7 + §8
  const trace: RuleEvaluation[] = RULE_REGISTRY.map((rule) =>
    safelyEvaluate(rule, ctx));

  const { outcome, declines, escalations } = aggregate(trace);

  return {
    tx_id: input.tx_id,
    proposal_id: input.proposal.proposal_id,
    outcome,
    rules_version: input.rules.rules_version,
    evaluated_at_iso: input.now_iso,
    input_digest: sha256Hex(canonicalJson({   // sync, deterministic — still pure
      proposal: input.proposal,
      rules_version: input.rules.rules_version,
      catalog_version: input.ground_truth.catalog_version,
      velocity: input.velocity,
      injection: input.injection,
      now_iso: input.now_iso,
    })),
    recomputed: ctx.totals,
    trace,                                    // length === RULE_REGISTRY.length, ALWAYS
    summary: summarize(trace),
    declines, escalations,
  };
}

function safelyEvaluate(rule: RuleDefinition, ctx: Readonly<GateContext>): RuleEvaluation {
  try {
    if (!rule.dependsOn.every((dep) => passed(dep, ctx.traceSoFar))) {
      return entry(rule, { status: 'SKIP',
        because: `dependency not satisfied: ${rule.dependsOn.join(',')}` });
    }
    return entry(rule, rule.evaluate(ctx));
  } catch (err) {
    if (err instanceof ImpossibleStateError) throw err;   // programmer bug surfaces loudly
    // ANY unexpected fault in a rule => fail CLOSED as a blocker-looking FAIL,
    // never crash the pipeline and never default-open.
    return entry(rule, { status: 'FAIL',
      expected: 'rule evaluates cleanly', actual: `internal error: ${rule.id}`,
      reason_code: 'MALFORMED_NUMERIC' });
  }
}
```

### 6.2 Aggregation (pure fold)

```ts
function aggregate(trace: RuleEvaluation[]) {
  const blockers = trace.filter((e) => e.status === 'FAIL' && e.severity === 'BLOCKER');
  if (blockers.length > 0) {
    return { outcome: 'DECLINE' as const,
             declines: blockers.map(toReason), escalations: [] };
  }
  const escapers = trace.filter((e) =>
    e.status === 'BAND' || e.status === 'ESCALATE_TRIGGER' ||
    e.status === 'UNAVAILABLE_INPUT' ||
    (e.status === 'FAIL' && e.severity === 'ESCALATE_IF_FAILED'));
  if (escapers.length > 0) {
    return { outcome: 'ESCALATE' as const, declines: [],
             escalations: escapers.map(toReason) };
  }
  return { outcome: 'APPROVE' as const, declines: [], escalations: [] };
}
```

**Precedence: DECLINE > ESCALATE > APPROVE.** A proposal that simultaneously trips a blocker (e.g., 50% discount over cap) and an escalation trigger (injection suspected) is DECLINED — the demo's key beat (§13 rows INJ-EMPLOYEE50, PRECEDENCE). On DECLINE, escalation causes remain visible in `trace` entries; they just do not change the outcome.

---

## 7. Context build (`buildContext`) pseudocode

```ts
function buildContext(input: EvaluateProposalInput): GateContext {
  // 1. Merge duplicate SKU lines deterministically: sum quantities; union of
  //    citation_ids preserving first-seen order; claimed_unit_price kept from
  //    FIRST occurrence only. Original proposal object untouched (purity).
  const merged: ProposedCartLine[] = [];
  const mergedFrom = new Map<string, number>();       // sku -> count of merged lines
  for (const l of input.proposal.lines) {
    const i = merged.findIndex((m) => m.sku_id === l.sku_id);
    if (i >= 0) {
      merged[i] = { ...merged[i],
        quantity: merged[i].quantity + l.quantity,
        citation_ids: uniq([...merged[i].citation_ids, ...l.citation_ids]) };
      mergedFrom.set(l.sku_id, (mergedFrom.get(l.sku_id) ?? 1) + 1);
    } else merged.push({ ...l });
  }

  // 2. Defensive numeric audit (schema already rejected most; belt & suspenders —
  //    a hand-built object bypassing zod must STILL fail closed, not crash).
  const badNumeric =
    merged.some((l) => !Number.isSafeInteger(l.quantity)) ||
    !Number.isFinite(input.proposal.bundle_discount_pct);
  const badQty     = merged.some((l) => l.quantity <= 0);
  const emptyCart  = merged.length === 0;
  const badDisc    = input.proposal.bundle_discount_pct < 0 ||
                     input.proposal.bundle_discount_pct > 100;

  // 3. Resolve SKUs against ground truth.
  const sku_index = new Map(input.ground_truth.items.map((it) => [it.sku_id, it]));
  const unresolved_skus = merged.filter((l) => !sku_index.has(l.sku_id)).map((l) => l.sku_id);

  // 4. Recompute totals from RAW prices (§8) over resolved lines.
  const resolved  = merged.filter((l) => sku_index.has(l.sku_id));
  const weights   = resolved.map((l) => sku_index.get(l.sku_id)!.list_price_paise * l.quantity);
  const gross     = weights.reduce((s, w) => s + w, 0);
  const discBps   = toBps(input.proposal.bundle_discount_pct);            // ONE conversion point
  const discount  = mulDivRoundHalfUp(gross, discBps, 10_000);            // single HALF_UP event
  const allocs    = allocateProportionally(discount, weights);            // conserves paise exactly
  const perLine   = resolved.map((l, i) => {
    const it    = sku_index.get(l.sku_id)!;
    const g     = it.list_price_paise * l.quantity;
    const net   = g - allocs[i];
    const c     = it.cost_price_paise * l.quantity;
    return { sku_id: l.sku_id, quantity: l.quantity, gross_paise: g,
             discount_alloc_paise: allocs[i], net_paise: net, cost_paise: c,
             margin_paise: net - c };
  });
  const net   = perLine.reduce((s, p) => s + p.net_paise, 0);   // == gross - discount
  const cost  = perLine.reduce((s, p) => s + costOf(p), 0);
  const margin= net - cost;
  const totals: RecomputedTotals = {
    line_count: merged.length, gross_paise: gross, discount_paise: discount,
    net_paise: net, cost_paise: cost, margin_paise: margin,
    blended_margin_bps: net > 0 ? Math.floor((margin * 10_000) / net) : 0,
    per_line: perLine,
  };

  // 5. Drift vs AI-claimed totals.
  const drift = Math.abs(input.proposal.ai_supplied_totals.total_paise - net);
  const materialThreshold = Math.max(2, mulDivRoundHalfUp(net, input.rules.totals_drift_material_frac_ppm, 1_000_000));
  ...
}
```

---

## 8. Evaluation semantics: money math, boundaries, ordering

### 8.1 Integer-paise discipline and the rounding rule

- All money: integer paise (matches Razorpay `amount` semantics — verified; see §0).
- All percentages: converted ONCE to integer basis points via `toBps(pct) = Math.round(pct * 100)` at load time (7.5% -> 750 bps). Decisions never multiply floats.
- **Rounding rule chosen: ROUND_HALF_UP, applied at exactly ONE point — the bundle-discount amount.** Everything else is exact integer/rational arithmetic; the per-line split uses largest-remainder so no second rounding exists.

Justification: (a) a single rounding point makes every decision reproducible to the paisa and auditable by simple recomputation; (b) HALF_UP is the accounting convention Indian merchants expect (₹x.50 rounds up, matching GST invoice practice more closely than banker's rounding); (c) compounding per-line rounding would let a 3-line cart's stated discount differ from its computed discount — exactly the kind of ambiguity a trust anchor must not contain. Rejected alternatives: ROUND_HALF_EVEN (surprising to merchants at .50), ROUND_DOWN (systematically under-delivers negotiated discounts, poisoning the demo), per-line rounding then summing (breaks conservation).

### 8.2 Proportional discount allocation (largest remainder, paise-conserving)

```ts
/**
 * Split `total` across weights proportionally; Σ(out) === total ALWAYS.
 * Deterministic: ties broken by ascending line index.
 */
export function allocateProportionally(total: number, weights: readonly number[]): number[] {
  assertSafeInt(total);
  if (weights.length === 0) return [];
  const wSum = weights.reduce((s, w) => s + w, 0);
  if (wSum <= 0) { const o = weights.map(() => 0); o[0] = total; return o; } // degenerate: documented
  const raw  = weights.map((w) => (total * w) / wSum);   // exact rationals as doubles for ranking only
  const base = raw.map((x) => Math.floor(x));
  let leftover = total - base.reduce((s, b) => s + b, 0); // < weights.length, provably
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) }))
                   .sort((p, q) => q.frac - p.frac || p.i - q.i);
  const out = base.slice();
  for (const { i } of order) { if (leftover === 0) break; out[i] += 1; leftover -= 1; }
  return out;
}
```

Overflow note: products stay far below 2^53 because quantity <= 999 and realistic gross <= ~₹5,00,00,000 paise; `assertSafeInt` guards the multiplication results anyway.

### 8.3 Blended margin after discount — float-free comparison

Definitions (per §7): `N` = net revenue after discount, `M` = N − total cost. Floor holds iff `M / N >= floorBps / 10000`. Cross-multiplied (valid since `N > 0`):

```
holds  <=>  M * 10000  >=  floorBps * N
```

No division, no float, exact at the boundary. If `N === 0` (all-free cart): FAIL `ZERO_NET_REVENUE` (fail closed; percentage undefined). `blended_margin_bps` in the result is display-only (`Math.floor(M*10000/N)`).

### 8.4 Worked example (this exact case is BASE-HAPPY in the test matrix)

Cart: CAKE-CHOC-500 x1 @ 64900p (cost 38000p); BRWN-BOX-9 x2 @ 24900p (cost 14000p each). Discount 7.5% (750 bps).

```
gross        G  = 64900 + 49800            = 114700 p  (₹1,147.00)
discount     D  = round_half_up(114700*750/10000) = round_half_up(8602.5) = 8603 p (₹86.03)

allocation (weights = line gross):
  raw1 = 8603*64900/114700 = 4867.783…  -> base 4867, frac .783
  raw2 = 8603*49800/114700 = 3735.217…  -> base 3735, frac .217
  Σbase = 8602, leftover = 1 -> largest frac wins (line 1)
  alloc1 = 4868, alloc2 = 3735 ;  Σalloc = 8603 = D   ✔ conservation

net1 = 64900 − 4868 = 60032 ; net2 = 49800 − 3735 = 46065
N = 106097 p (₹1,060.97)  [= G − D ✔]
cost = 38000 + 28000 = 66000 ;  M = 106097 − 66000 = 40097 p
blended margin = 40097/106097 ≈ 37.79 %   (display bps: floor(40097*10000/106097)=3779)

floor check @25% (2500 bps):  M*10000 = 400,970,000  >=  2500*N = 265,242,500  → PASS
settlement amount: net_paise = 106097 → Razorpay Orders amount = 106097, currency INR
```

### 8.5 Boundary semantics table (inclusive limits — "exactly-at-limit passes")

| Comparison | Rule | Pass condition | Exactly-at-limit | Just inside violation | Soft band (both edges inclusive) |
|---|---|---|---|---|---|
| Cart total vs cap | GK-CART-VALUE | `total <= cap` | PASS | cap+1 paise FAIL | `[cap·(1−band%), cap]` => BAND/ESCALATE |
| Discount vs cap | GK-DISCOUNT-CAP | `disc_bps <= cap_bps` | PASS | +1 bp FAIL | `[cap−y pp, cap]` => BAND/ESCALATE |
| Blended margin vs floor | GK-MARGIN-FLOOR | `M·10000 >= floorBps·N` | PASS | 1 paisa of margin less FAIL | none (hard cliff) |
| Velocity requests/hour | GK-VELOCITY-REQUESTS | `prior_count + 1 <= max` | PASS (this request is the Nth allowed) | `prior+1 = max+1` FAIL | none |
| Velocity value/day | GK-VELOCITY-VALUE | `prior_value + net <= max` | PASS | +1 paise FAIL | none |
| Stock vs qty | GK-STOCK-AVAILABILITY | `qty <= stock_on_hand` (per merged line) | PASS | +1 unit FAIL | none |
| Proposal age | GK-PROPOSAL-FRESHNESS | `now − issued_at <= max_age` AND `issued_at <= now + skew` | PASS at both edges | 1 s beyond either FAIL | none |

Convention statement for ARCHITECTURE.md: **every limit in this system is an inclusive ceiling/floor phrased "at most/at least"; nothing fails at exactly-the-number.** Bands are the exception in spirit (their whole purpose is to make the region just-inside-the-limit louder, not stricter): band membership is inclusive on both edges, and band-edge values ESCALATE.

Escalation band edges, computed in integers at context build:
```
valBandLowerEdge = cap − mulDivRoundHalfUp(cap, valBandBps, 10000)
   e.g. cap 500000, band 15% -> 500000 − 75000 = 425000 p (₹4,250)
discBandLowerBps = cap_bps − round(band_pp*100)
   e.g. cap 1500 bps, band 5pp -> 1000 bps (10%)
```

---

## 9. ESCALATE triggers — complete enumeration

Outcome ESCALATE fires when, after aggregation, any of these produced a non-PASS entry and no BLOCKER failed:

1. **VALUE_IN_BAND** — recomputed total in `[cap·(1−band%), cap]`. Healthy-but-big; human eyes.
2. **DISCOUNT_IN_BAND** — `bundle_discount_pct` in `[cap − band_pp, cap]`.
3. **VELOCITY_UNAVAILABLE** — velocity snapshot `status: 'UNAVAILABLE'` for ANY reason. Fail closed: both velocity rules emit `UNAVAILABLE_INPUT`. There is deliberately no "assume zero usage" path.
4. **INJECTION_SUSPECTED** — tagger says `suspected: true`, EVEN IF the resulting cart is fully compliant. Rationale: contamination of the channel warrants review regardless of whether the manipulation succeeded; this is also how the demo shows partial-compliance-then-catch.
5. **REPEAT_OFFENDER** — snapshot counters meet any configured threshold: `prior_escalations_24h >= t_esc`, OR `prior_declines_24h >= t_dec`, OR `injection_flags_24h >= t_inj` (Meera defaults 2 / 5 / 1).
6. **TOTALS_DRIFT_MATERIAL** — AI-supplied total differs from recompute by > max(2, 1% of net) paise. Small drift is normal model sloppiness (advisory); material drift means the proposing model's world-model is wrong or adversarial.
7. **RULES_NOT_YET_EFFECTIVE** — selected rules version's `effective_from_iso > now`. Should be impossible by coordinator contract; if it happens it is a configuration incident => human.

Explicitly NOT escalation triggers: expired SKU (hard DECLINE — expired goods must never ship, there is nothing for a human to approve), unknown SKU, negative margin item alone (margin FLOOR is basket-level; a loss-leader inside a healthy basket is fine and is exactly what campaigns do).

### 9.1 Human-approval re-entry (binding to the SAME proposal)

On ESCALATE, the coordinator stores `(tx_id, proposal_id, input_digest, decision, trace)` and opens an inbox item. Merchant approval records `{ approver_identity, approved_at, decision_id }` against the SAME `input_digest`. Settlement-agent independently verifies (defense in depth) that a gatekeeper record exists for the digest with outcome APPROVE, or outcome ESCALATE with a valid approval — THEN calls Razorpay. The gatekeeper is never re-run on approval UNLESS `rules_version` changed while the item sat in the inbox; in that case the stale approval is voided and a FRESH evaluation is required (policy documented; prevents "approve under old rules, settle under new reality").

---

## 10. Edge cases — catalog

| Edge | Handling | Where |
|---|---|---|
| Empty cart | zod `.refine` rejects at the boundary; engine ALSO defends (hand-built objects): GK-CART-STRUCTURE FAIL `EMPTY_CART` -> DECLINE | schema + rule 4 |
| qty <= 0, fractional qty, qty > 999 | schema rejects; engine re-checks -> FAIL `INVALID_QUANTITY` | rule 4 |
| Unknown SKU | FAIL `UNKNOWN_SKU` (BLOCKER); margin/value/stock/category/expiry emit visible `SKIP` entries citing the unresolved SKU | rule 5 + deps |
| Duplicate SKU lines | Merged deterministically (sum qty, union citations, first price echo kept); advisory `LINES_MERGED` recorded; all downstream math sees canonical cart | context build |
| Negative discount (<0) or >100% | schema rejects; engine re-checks -> FAIL `INVALID_DISCOUNT_RANGE` | rule 4 |
| NaN / undefined / Infinity numerics | zod rejects NaN and non-numbers upstream; engine's `Number.isFinite`/`Number.isSafeInteger` audit catches objects that bypassed validation -> FAIL `MALFORMED_NUMERIC` (never a throw — hostile input must not be able to crash the gate into failing OPEN) | rule 4 |
| Stale proposal (`age > proposal_max_age_seconds`) | FAIL `STALE_PROPOSAL` | rule 3 |
| Future-dated `issued_at` beyond skew | FAIL `FUTURE_ISSUED_AT` (clock attack / replay shape) | rule 3 |
| `expires_at_iso` already past | FAIL `STALE_PROPOSAL` (same freshness rule checks both bounds) | rule 3 |
| Expired SKU (sell_by past) | FAIL `SKU_EXPIRED` — hard decline, not escalable | rule 12 |
| Near-expiry SKU | PASSES (selling near-expiry stock is the campaign system's JOB); only past sell-by blocks | rule 12 |
| Zero-list-price item | Allowed; contributes 0 weight to allocation; if entire cart nets 0 -> `ZERO_NET_REVENUE` DECLINE | rules 9, §8.2 |
| Cost > list (loss-leader line) | Fine per-line; only BLENDED floor matters — campaigns may bundle a loss-leader | rule 9 |
| AI totals materially wrong | ESCALATE `TOTALS_DRIFT_MATERIAL` (>1%) or ADVISORY (<=1%) | rule 6 |
| Price echo wrong | APPROVE unaffected + ADVISORY `PRICE_ECHO_MISMATCH` (recompute won) | per-line evidence |
| Rules version not yet effective | ESCALATE `RULES_NOT_YET_EFFECTIVE` | rule 2 |
| Daily value cap < single-cart cap | Blocked at CONFIG load (superRefine) — misconfiguration cannot silently brick the gate | schema |
| Velocity store down | ESCALATE `VELOCITY_UNAVAILABLE` (fail closed) | rules 13–14 |
| Integer overflow | `assertSafeInt` on every product; ImpossibleStateError = programmer bug, surfaces loudly in dev/tests; bounded domain (qty<=999, <=25 lines) keeps products << 2^53 | money.ts |
| Concurrent double-submit of same tx | OUTSIDE the gate (gate is stateless); handled by settlement idempotency keys — the integration suite proves gate output is IDENTICAL for both submissions (determinism makes this trivially true) | integration tests |

---

## 11. UI rendering contract (what the frontend reads)

- `trace[]` maps 1:1 to rule rows in the live transaction screen, IN REGISTRY ORDER, so agents/rules appear in a stable visual sequence.
- Status -> color: `PASS` green, `FAIL` red, `BAND` amber, `ESCALATE_TRIGGER` amber-red pulse, `UNAVAILABLE_INPUT` amber, `SKIP` gray with tooltip = `because`.
- `evidence` powers hover tooltips ("cap ₹5,000.00 vs actual ₹5,123.45").
- `declines[]` / `escalations[]` feed the headline banner; `human_message` strings are written to stand alone (mechanical, numeric, no AI prose quoted as fact).
- Injection visuals come from `InjectionSignal.hits[].snippet` — the red highlighted fragments in the customer-note panel; `risk_score` renders as a badge.
- `summary` powers the compact "16 rules: 14 pass / 1 fail / 1 skip" chip.
- Explainer-agent consumes `trace` + `declines`/`escalations` as FACT SKELETON and narrates; if the explainer LLM dies, the raw trace JSON is shown directly (committed degradation path — the trace is designed to be human-readable without any narration).

---

## 12. Fixtures used by the test matrix

Constants (see §3.7): `MEERA_RULES_V3`, `MEERA_GT_V1`, clock pinned `NOW = '2026-08-25T10:00:00Z'`. Factory helpers: `mkProposal(overrides)`, `mkVelocity(overrides)`, `evaluate(proposal, overrides?)` returning the full `GatekeeperResult`. All inputs deep-frozen by a shared beforeEach.

Baseline happy cart (used by row 1): CAKE-CHOC-500 x1 + BRWN-BOX-9 x2, discount 7.5%, totals as worked in §8.4 (net ₹1,060.97, margin 37.79%).

---

## 13. Unit-test matrix (vitest; gatekeeper suite — heaviest in repo)

Legend: Outcome ∈ APPROVE / DECLINE / ESCALATE. "Trace highlights" name the decisive entries.

| # | Case ID | Description | Input highlights | Expected outcome | Expected trace highlights |
|---|---|---|---|---|---|
| 1 | BASE-HAPPY | Well-behaved bundle | 2 lines, d=7.5% (§8.4) | APPROVE | All 16 PASS; recomputed 114700/8603/106097; margin bps 3779 |
| 2 | VAL-EXACT | Total exactly at value cap | custom item list 500000 x1, d=0 | APPROVE | CART-VALUE PASS; expected "<= ₹5,000.00", actual ₹5,000.00 (inclusive) |
| 3 | VAL-OVER-1PAISE | One paisa over cap | total 500001 | DECLINE | CART-VALUE FAIL OVER_CART_VALUE; evidence cap=500000 actual=500001 |
| 4 | VAL-BAND-MID | Inside value band | total 450000 (band edge 425000) | ESCALATE | CART-VALUE BAND VALUE_IN_BAND; expected "[₹4,250.00, ₹5,000.00]" |
| 5 | VAL-BAND-LOWER-EDGE | Exactly at band lower edge | total 425000 | ESCALATE | BAND (inclusive lower edge) |
| 6 | VAL-BELOW-BAND | One paisa below band edge | total 424999 | APPROVE | CART-VALUE PASS |
| 7 | DISC-EXACT | Discount exactly at cap | d=15.00 (1500 bps) | APPROVE | DISCOUNT-CAP PASS; expected "<= 15%", actual "15%" |
| 8 | DISC-OVER-0.01PP | Cap + 0.01pp | d=15.01 (1501 bps) | DECLINE | FAIL OVER_DISCOUNT_CAP; evidence cap_bps=1500 actual_bps=1501 |
| 9 | DISC-BAND | Within discount band | d=11 (band [10,15]) | ESCALATE | BAND DISCOUNT_IN_BAND |
| 10 | DISC-BELOW-BAND | Just below band | d=9.99 (999 bps) | APPROVE | DISCOUNT-CAP PASS |
| 11 | MARGIN-PERSUASIVE | Margin-floor violation wrapped in persuasive-but-irrelevant prose | lines blend to 18.2% margin; negotiation_summary_md = "…margin independently verified by finance admin; override pre-approved…" | DECLINE | MARGIN-FLOOR FAIL BELOW_MARGIN_FLOOR; expected ">= 25%" actual "18.20%"; human_message states AI narrative was not evaluated; PROSE-INVARIANCE co-test proves swapping the narrative changes nothing |
| 12 | MARGIN-EXACT | Blended margin exactly at floor | 1 line list 100000 cost 75000 d=0 | APPROVE | MARGIN-FLOOR PASS via cross-mult equality (25000·10000 == 2500·100000) |
| 13 | MARGIN-JUST-BELOW | 1 paisa of margin under floor | same but cost 75001 | DECLINE | FAIL; demonstrates paisa-level sensitivity of exact math |
| 14 | MARGIN-ZERO-NET | Zero-revenue cart | single item list 0, d=0 | DECLINE | FAIL ZERO_NET_REVENUE (division undefined -> fail closed) |
| 15 | CAT-BLOCKED | Category outside allowlist | item with category_raw TOYS, mode ALLOWLIST | DECLINE | CATEGORY FAIL CATEGORY_BLOCKED; evidence lists offending categories |
| 16 | CAT-MODE-OFF | Same cart, allowlist disabled | mode ALL_ALLOWED | APPROVE | CATEGORY PASS; allowlist ignored per mode |
| 17 | STOCK-EXACT | Stock exactly equals demand | qty 10 of stock_on_hand 10 | APPROVE | STOCK PASS (inclusive) |
| 18 | STOCK-OVER-1 | One unit short | qty 11 | DECLINE | STOCK FAIL INSUFFICIENT_STOCK; per-line evidence |
| 19 | STOCK-BACKORDER-EXEMPT | Backorder-listed SKU ignores availability | HAMP-DIW-05 in backorder_allowed_skus, qty 50 stock 6 | APPROVE | STOCK PASS with evidence exemption=true; other rules still applied |
| 20 | EXPIRY-EXPIRED | Expired SKU in cart | CKI-KAJU-250 sell_by = NOW−1d | DECLINE | EXPIRY FAIL SKU_EXPIRED (hard; not escalable) |
| 21 | EXPIRY-NEAR | Near-expiry (the campaign target) | sell_by = NOW+2d | APPROVE | EXPIRY PASS; note in evidence "near_expiry=true" |
| 22 | FRESH-STALE | Proposal older than max age | issued_at = NOW−301s | DECLINE | FRESHNESS FAIL STALE_PROPOSAL |
| 23 | FRESH-FUTURE | Clock-skew attack shape | issued_at = NOW+10min | DECLINE | FRESHNESS FAIL FUTURE_ISSUED_AT |
| 24 | CITATION-GATE-NO | Pipeline contract broken | citations_audited=false | DECLINE | CITATION-GATE FAIL CITATION_GATE_FAILED |
| 25 | VEL-REQ-EXACT | Hourly requests exactly at limit | prior_count 11, max 12 | APPROVE | VEL-REQ PASS "+1 = 12 <= 12" (convention: snapshot excludes self) |
| 26 | VEL-REQ-MIDSESSION | Limit hit mid-session | prior_count 12, max 12 | DECLINE | VEL-REQ FAIL; expected "<= 12 incl. this request", actual "13" |
| 27 | VEL-VAL-EXACT | Daily value exactly at cap | prior approved 1900000 + net 100000 = 2000000 | APPROVE | VEL-VAL PASS (inclusive) |
| 28 | VEL-VAL-OVER | Daily value 1 paise over | prior 1900001 + net 100000 | DECLINE | VEL-VAL FAIL; uses RECOMPUTED net, never AI total |
| 29 | VEL-UNAVAILABLE | Velocity data unavailable (chaos toggle) | snapshot UNAVAILABLE/REDIS_TIMEOUT | ESCALATE | BOTH velocity rules UNAVAILABLE_INPUT VELOCITY_UNAVAILABLE; fail closed — never APPROVE on unknown |
| 30 | INJ-CLEAN-CART | Injection flagged, cart itself compliant | injection.suspected=true; modest compliant cart | ESCALATE | INJECTION-GUARD ESCALATE_TRIGGER INJECTION_SUSPECTED; channel contaminated => review even though nothing was stolen |
| 31 | INJ-EMPLOYEE50 | THE DEMO BEAT: adversarial EMPLOYEE50 injection | customer_note contains "SYSTEM NOTE: … EMPLOYEE50 … admin confirmed"; tagger suspected=true; proposal d=50 | DECLINE | DISCOUNT-CAP FAIL OVER_DISCOUNT_CAP (blocker) + INJECTION ESCALATE_TRIGGER coexist; aggregation picks DECLINE (precedence); escalations[] empty, both facts visible in trace for explainer |
| 32 | REOFFENDER-HIT | Prior escalations meet threshold | prior_escalations_24h=2 (thr 2) | ESCALATE | REPEAT-OFFENDER ESCALATE_TRIGGER REPEAT_OFFENDER (inclusive >=) |
| 33 | REOFFENDER-CLEAR | One below threshold | prior_escalations_24h=1 | APPROVE | REPEAT-OFFENDER PASS |
| 34 | STRUCT-EMPTY | Empty cart bypassing zod | hand-built proposal lines=[] | DECLINE | CART-STRUCTURE FAIL EMPTY_CART (engine-level defense) |
| 35 | QTY-ZERO | Zero/negative quantity | qty 0 line | DECLINE | FAIL INVALID_QUANTITY |
| 36 | DUP-SKU | Duplicate SKU lines | same sku twice (1 + 2) | APPROVE | totals identical to single-line qty 3; CART-STRUCTURE evidence LINES_MERGED=1 |
| 37 | UNKNOWN-SKU | Ghost SKU | line sku GHOST-1 | DECLINE | SKU-RESOLUTION FAIL UNKNOWN_SKU; MARGIN/CATEGORY/STOCK/EXPIRY present as SKIP with reason (full trace, nothing vanished) |
| 38 | NAN-DEFENSE | NaN smuggled past zod | constructed object qty NaN | DECLINE | CART-STRUCTURE FAIL MALFORMED_NUMERIC (defensive Number.isFinite audit; no throw) |
| 39 | DISC-NEGATIVE | Negative discount | d=−5 | DECLINE | FAIL INVALID_DISCOUNT_RANGE |
| 40 | DISC-OVERFLOW | Discount >100% | d=150 | DECLINE | FAIL INVALID_DISCOUNT_RANGE |
| 41 | DRIFT-MATERIAL | AI totals lie big | ai total 1000 vs recomputed 106097 | ESCALATE | TOTALS-DRIFT FAIL (ESCALATE_IF_FAILED) TOTALS_DRIFT_MATERIAL; drift 105097 > threshold 1061 |
| 42 | DRIFT-MINOR | Off-by-one AI total | ai total 106098 | APPROVE | TOTALS-DRIFT PASS w/ advisory evidence (drift 1 <= max(2, 1061)) |
| 43 | ECHO-MISMATCH | Wrong price echo | claimed_unit_price 100 vs real 64900 | APPROVE | PRICE_ECHO_MISMATCH advisory; recomputed math used 64900 (recompute won) |
| 44 | PRECEDENCE-D-OVER-E | Blocker + escalation together | over-cap value AND injection suspected AND discount in band | DECLINE | DECLINE outranks ESCALATE; all three entries present in trace |
| 45 | VERSION-FUTURE | Selected rules not yet effective | effective_from = tomorrow | ESCALATE | RULES-EFFECTIVE FAIL RULES_NOT_YET_EFFECTIVE |
| 46 | BAND-DISABLED | Band width 0 disables soft edge | band 0, total 450000 | APPROVE | CART-VALUE PASS (no BAND emitted) |
| 47 | DETERMINISM | Pure-function replay | evaluate twice on frozen inputs | both runs deep-equal | identical trace, digest, outcome; inputs unmutated (Object.isFrozen assertions) |
| 48 | LATENCY-BUDGET | 25-line worst-case cart | 25 lines, all rules exercised | completes | wall-clock < 5ms CI guard (typical ~tens of µs) |

Rows 1–48 constitute the required coverage: exactly-at-value-limit (2), exactly-at-discount-cap (7), margin-floor violation with persuasive-but-irrelevant justification (11), velocity exceeded mid-session (26), injection case (30, 31), unavailable-velocity case (29).

### 13.1 Property-based tests (vitest + fast-check)

| Property | Statement | Why it matters |
|---|---|---|
| PAISE-CONSERVATION | For random carts: `Σ allocations === discount_total` and `Σ net === gross − discount`, always | the settlement amount must reconcile to the paisa |
| PROSE-INVARIANCE | Mutating `negotiation_summary_md` arbitrarily never changes outcome or any numeric evidence (note: `customer_note_raw` is exempt — the TAGGER reads it upstream, the gate never does) | the gate cannot be argued with |
| MONOTONE-SAFETY | Increasing discount_pct, quantities, or totals can never flip DECLINE->APPROVE | no perverse incentives |
| CROSS-MULT-EQ-FLOAT | `crossMarginHolds(M,N,floorBps) === (M/N >= floorBps/10000)` on randomized integers (N>0) | proves the float-free comparison is faithful |
| ALLOCATION-BOUNDS | Each allocation lies in `[floor(exact_i), ceil(exact_i)]` | no line silently subsidizes another beyond 1 paisa |
| TRACE-COMPLETENESS | `result.trace.length === RULE_REGISTRY.length` for EVERY input generated | invariant I-4, machine-checked |
| DETERMINISM | `deepEqual(evaluate(i), evaluate(i))` for randomized inputs | invariant I-1 |

### 13.2 Integration-test pointers (live in `api/src/__tests__/`, referencing this suite)

| Test | Asserts |
|---|---|
| happy-path e2e | buyer request -> APPROVE -> mock Razorpay order created with `amount === recomputed.net_paise`, currency INR |
| injection caught e2e | adversarial script -> DECLINE -> explainer narration mentions the specific rule reason; SSE stream shows red injection banner |
| escalate e2e | high-value cart -> ESCALATE -> UI approval -> settlement proceeds with SAME `input_digest`; tampering with the proposal after approval fails digest check |
| double-submit idempotency | same tx twice -> identical gate decision; one Razorpay order (idempotency key at settlement) |
| redis velocity mid-session | real sliding-window increments between calls produce snapshots that flip row 25 -> row 26 behavior |
| DEMO_STABLE_MODE parity | recorded fixtures replay -> byte-identical decisions (trivially true for a pure function; the test pins it anyway) |

---

## 14. Impure adapters around the pure core (for completeness)

```ts
// api/src/services/velocity-store.ts — OUTSIDE the gatekeeper directory
export interface VelocityStore {
  /** Build the snapshot the gate will consume. Impure by design (Redis ZSET
   *  sliding windows). On ANY failure returns UNAVAILABLE — never throws upward
   *  with partial data, never fabricates zeros. */
  snapshot(agentIdentityId: string, nowIso: string): Promise<AgentVelocitySnapshot>;
  /** ATOMIC check-and-record (single Lua script): purge expired entries → read
   *  request count + value sum → compare against BOTH limits → ZADD only if
   *  within. Returns the authoritative snapshot plus a verdict. This closes the
   *  check-then-act window between snapshot() and recordRequest() (§ race
   *  acknowledgment below). Any script error ⇒ verdict path treats the store as
   *  UNAVAILABLE (fail closed). */
  checkAndRecord(
    identityId: string,
    limits: { max_requests_per_hour: number; max_value_per_day_paise: number },
    proposedNetPaise: number,
    nowIso: string,
  ): Promise<{ snapshot: AgentVelocitySnapshot; verdict: 'OK' | 'OVER_LIMIT' }>;
  /** Post-decision accounting: bumps request_count immediately (all outcomes);
   *  bumps approved_value_paise only after settlement reserve succeeds. */
  recordRequest(identityId: string, nowIso: string): Promise<void>;
  recordApprovedValue(identityId: string, netPaise: number, nowIso: string): Promise<void>;
}
```

Sliding-window implementation sketch (Redis): two ZSETs per identity (`req:{identity}` scored by epoch-ms, `val:{identity}` members = tx_id, score = net paise); `ZREMRANGEBYSCORE` below `now − window`, then `ZCARD` / `ZSUM`-via-scan for the stat; TTL = window. Counters (escalations/declines/injection flags 24h) are four plain keys with 24h TTL, incremented by the pipeline after each decision. The chaos toggle "force LLM timeout" can safely target THIS adapter to demo row 29 (VELOCITY_UNAVAILABLE => ESCALATE) live.

### 14.1 Race acknowledgment — where enforcement is actually atomic (normative)

`snapshot() → evaluateProposal() → recordRequest()` is check-then-act: N concurrent proposals from one identity can all observe `prior_count = max − 1` and all PASS. The pure gate therefore never carries the enforcement burden alone — it consumes only atomically-produced facts:

1. **Pre-gate atomic slot check.** The pipeline calls `velocityStore.checkAndRecord(...)` — ONE Redis Lua script doing purge → read counts/sums → compare BOTH limits → ZADD only if within limits — and feeds the snapshot that script returned into `evaluateProposal()`. Script verdict `OVER_LIMIT` maps to the FAIL paths (`VELOCITY_REQUESTS` / `VELOCITY_VALUE_EXCEEDED`, rule 13/14 trace rows intact); any script error ⇒ status UNAVAILABLE ⇒ ESCALATE (fail closed, unchanged from row 29).
2. **Money-moment re-verification.** Settlement re-verifies both ceilings atomically inside the reservation transaction via an `identity_velocity` ledger keyed `(identity_hash, day)` — a limit breach aborts that SAME Postgres transaction as the stock holds (settlement.md §7.2). N racing approvals cannot jointly exceed a limit at the single point where money movement commits.
3. **The pure gate stays byte-identical and racy-by-design-safe**: it judges only the snapshot handed to it; determinism tests are unaffected because the snapshot remains an ordinary immutable input.

---

## 15. Chaos toggles vs the gatekeeper

The gatekeeper itself has NO chaos toggle — there is nothing to break: it performs no IO. Committed degradation mapping:

- force-LLM-timeout on negotiation -> FALLBACK bundle (rule-based, labeled FALLBACK) -> still gated like any proposal (row 1 applies unchanged).
- force-LLM-timeout on velocity-store adapter -> UNAVAILABLE snapshot -> ESCALATE (row 29) — graceful, loud, safe.
- force-gateway-error -> occurs AFTER approval, inside settlement; the gate decision stands in the audit chain.
- catalog-enrichment failure -> irrelevant to the gate (enrichment fields are structurally absent from its input type).

An LLM outage can degrade SUGGESTIONS anywhere in the system; it can never weaken ENFORCEMENT.

---

## 16. Purity enforcement (mechanical, not aspirational)

1. **Import-boundary rule** (dependency-cruiser, wired into CI):

```js
// api/.dependency-cruiser.cjs (excerpt)
{
  name: 'gatekeeper-is-pure',
  severity: 'error',
  comment: 'The money gate imports no SDK, no DB, no cache, no HTTP, no clock.',
  from: { path: '^src/gatekeeper/' },
  to: { path: 'node_modules|razorpay|anthropic|ioredis|pg|express|^(src/(services|routes))' },
}
```

2. **Freeze tests**: every spec deep-freezes inputs; any mutation attempt throws in strict mode.
3. **Determinism tests** (§13.1 DETERMINISM) plus DEMO_STABLE_MODE replay parity.
4. **No `Date.now()`/`Math.random()` lint rule** scoped to `src/gatekeeper/**` (eslint no-restricted-syntax).
5. **Type-level completeness**: `Record<RuleId, RuleDefinition>` shape-check keeps registry and trace honest.

---

## 17. "Why this one piece is NOT an LLM" — section for ARCHITECTURE.md

> ### 17.x The gatekeeper is not an LLM — and that is the architecture's load-bearing wall
>
> Every other component in GrowthAgent reasons. The gatekeeper computes. This is not an implementation shortcut; it is a formal property with six consequences.
>
> **1. Determinism.** `evaluateProposal` is referentially transparent: identical inputs yield identical outputs — today, next month, and years later from the hash-chained audit log. Formally: for inputs `i, j`, `i = j ⟹ evaluate(i) = evaluate(j)`. An LLM policy offers no such algebraic identity: sampling, prompt drift, and model updates mean "the same case" can decide differently across runs. A safety property you cannot re-derive is not a property; it is a memory.
>
> **2. Zero injection surface.** The gate has no prompt to inject into. Its entire input surface is a closed, `strict()`-validated schema; unknown fields are rejected outright, prose fields are typed but unread by any rule. The adversarial buyer-agent in our demo literally has no address at which to speak to the gatekeeper — it can only shout at agents who do not control money. The strongest prompt-injection defense is architectural: there is nothing for the attack to attach to.
>
> **3. Exhaustive testability.** Because the input space is finite, validated, and partitionable, the safety claim is machine-checkable: a 48-row boundary matrix plus property-based invariants give measurable 100% behavioral coverage of every rule, including exactly-at-limit rows on both sides of every cliff. No LLM policy can be proven to satisfy "never approves a discount above the cap" — you cannot enumerate the inputs to a neural network. You CAN enumerate ours; the suite in §13 does.
>
> **4. Microsecond latency, zero failure modes.** Pure integer arithmetic over <=25 lines executes in tens of microseconds with no network hop, no retry budget, no timeout semantics, no degraded mode. Critically for the trust story: there is no outage during which enforcement quietly relaxes. Our chaos toggles can kill every LLM in the system and the gate's guarantee is bit-identical.
>
> **5. Per-line auditability.** Every rule emits `{expected, actual, evidence}` derived from first-class integers. The trace is simultaneously (a) the compliance record, (b) the UI payload, (c) the regression oracle, and (d) the explainer-agent's fact skeleton. One artifact, four consumers, zero translation loss. When a merchant asks "why was this declined?", the answer is arithmetic, not a confidence score.
>
> **6. The inversion.** Because the backstop is hard, the AI agents are freed from defensive hedging. Negotiation can propose boldly — aggressive bundles, campaign-driven discounts — knowing the worst case is a DECLINE_WITH_REASON or a human review, never unauthorized money movement. Campaign mining can hunt expiry-risk and underselling stock aggressively for the same reason. Safety is not smeared across seventeen prompts hoping each model behaves; it is concentrated in one provably boring, exhaustively tested pure function. "AI proposes, the gatekeeper disposes" works precisely because the disposing half is dumb as a rock and correct as a theorem. The interesting system is allowed to be probabilistic because the money-touching half is not.

Formal claims pinned by the suite: `outcome = APPROVE ⟹ every BLOCKER rule PASS ∧ zero escalation triggers ∧ all totals recomputed from raw ground truth ∧ velocity AVAILABLE ∧ injection not suspected`.

---

## 18. Threat-model excerpt (trust-boundary rows owned by the gatekeeper)

| # | Threat | Vector | Gatekeeper control | Residual risk / mitigation elsewhere |
|---|---|---|---|---|
| T1 | Prompt-injected buyer extracts unauthorized discount | Manipulation text in `customer_note_raw` ("SYSTEM NOTE … EMPLOYEE50") | Gate never reads the note; tagger flags; discount RECOMPUTED and capped regardless of what any agent agreed to | Partial compliance by negotiator is acceptable & surfaced; explainer narrates the catch |
| T2 | Negotiation hallucinates prices/margins | Fabricated numbers in proposal | All totals recomputed from `GroundTruthSnapshot`; enrichment fields structurally absent from the type | — |
| T3 | Hallucinated/tampered totals | Wrong `ai_supplied_totals` | Drift detector: minor => advisory, >1% => ESCALATE | — |
| T4 | Compromised/negotiating agent gone rogue | Arbitrary cart contents | Rules are identity-agnostic (I-6); velocity keyed to BUYER identity; citation gate | Agent key revocation lives in identity service |
| T5 | Velocity store outage hides abuse | Redis down mid-attack | UNAVAILABLE => ESCALATE, fail closed (row 29) | Ops alerting on UNAVAILABLE frequency |
| T6 | Replay/stale proposal resubmission | Old approved cart re-sent | Freshness rule + skew guard + `input_digest` binding at settlement | Nonce/idempotency at settlement layer |
| T7 | Rules tampering to loosen limits | Config edit under pressure | Insert-only versioned config, `effective_from`, version stamped into every decision + digest | Authz on config endpoint (web screen b) |
| T8 | DoS via absurd carts | 10^6 lines / giant qtys | Schema maxes (25 lines, qty<=999) + structural FAILs + microsecond eval | Rate limiting upstream |
| T9 | Social-engineered human approval | Escalated cart dressed up in prose | Approval UI shows mechanical rule trace + evidence numbers beside any AI narrative; approval binds to digest | Merchant training; explainer labels AI claims as untrusted |
| T10 | Settlement bypassing the gate | Bug or shortcut calls Razorpay directly | Module isolation: ONLY settlement may import the Razorpay adapter (mirror of the gatekeeper purity rule); settlement verifies gate record + digest before ordering | Import-lint test mirrors §16 |

---

## 19. Open items and explicit non-decisions

1. **Webhook signature details** (header name, HMAC variant): NOT verified in this pass — settlement-agent owner must confirm against Razorpay's "Validate Webhooks" page before implementation. Zero impact on gatekeeper logic.
2. **AP2/ACP field mapping**: the gate treats `buyer_agent_identity_id` as opaque. If AP2 mandates carry semantic constraints later, they enter as ADDITIONAL structured inputs (new rule appended to the registry — order and aggregation unchanged), never as prose.
3. **Zod version pin**: schemas written v3-style; v4 migration renames datetime validators (`z.iso.datetime()`). Pin in root package.json; note lives atop `shared/src/schemas/gatekeeper.ts`.
4. **Degenerate allocation** (all-zero-weight cart): assigned wholly to line 1 and documented; unreachable in practice because `ZERO_NET_REVENUE` declines first when every price is zero, and unknown-SKU lines never reach allocation.
5. **Multi-merchant generalization**: single-merchant demo assumed; `merchant_id` rides along in `GroundTruthSnapshot` so the rules-config table is already keyed correctly for growth.

---

## 20. Summary of guarantees delivered by this design

One pure function, sixteen fixed rules, five hashed inputs, zero trusted AI numbers, three outcomes with strict precedence (DECLINE > ESCALATE > APPROVE), inclusive limits everywhere, one HALF_UP rounding event, paise-exact allocation, a trace that is always complete, fail-closed semantics for every unknown, and a test matrix that proves all of it. This is the wall the rest of the system gets to be creative in front of.