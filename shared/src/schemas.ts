/**
 * GrowthAgent shared data contracts.
 *
 * Section A — Gatekeeper schemas: ported VERBATIM from docs/design/gatekeeper.md
 * §3 (names, fields, severities, reason codes, band edges). THE contract for the
 * money path; consumed by api AND web.
 *
 * Section B — Evidence Pack schemas: ported VERBATIM from docs/design/
 * negotiation.md §1.1/§1.2 (evidence entry union + pack container).
 *
 * ZOD VERSION NOTE (gatekeeper.md §19.3): schemas are written against zod v3
 * API (`z.string().datetime()`). On a zod v4 migration the datetime validators
 * move to `z.iso.datetime()`.
 */
import { z } from "zod";

/* ======================= SECTION A — GATEKEEPER ======================== */
/* ============================ primitives =============================== */

/** INTEGER PAISE. All money in the system is integer paise — no exceptions.
 *  Matches Razorpay Orders `amount` semantics ("smallest currency sub-unit"). */
export const Paise = z
  .number()
  .int("money must be integer paise")
  .nonnegative()
  .lte(Number.MAX_SAFE_INTEGER);
/** Declaration merge (same-name z.infer) so importers can use `Paise` as a
 *  TYPE too — settlement/provider DTOs annotate money fields with it. */
export type Paise = z.infer<typeof Paise>;

/** Percentages validated as decimals (e.g. 7.5). Converted to integer basis
 *  points ONCE at config/proposal load; decisions never see floats. */
export const Pct = z.number().min(0).max(100);

const IsoDateTime = z.string().datetime({ offset: false }); // zod v4: z.iso.datetime()

/* ========================= MerchantRulesConfig ========================= */

export const CategoryAllowlistModeSchema = z.enum(["ALL_ALLOWED", "ALLOWLIST"]);

export const StockPolicySchema = z
  .object({
    /** true => any line whose qty exceeds stock_on_hand blocks approval */
    require_full_availability: z.boolean(),
    /** SKUs exempt from require_full_availability (made-to-order items) */
    backorder_allowed_skus: z.array(z.string().min(1)).max(50).default([]),
    reservation_ttl_seconds: z.number().int().positive().max(3600),
  })
  .strict();

export const ExpiryPolicySchema = z
  .object({
    /** SKUs whose sell_by has passed are unsellable through the agent pipeline */
    block_expired_skus: z.boolean(),
  })
  .strict();

export const RepeatOffenderPolicySchema = z
  .object({
    escalations_24h_threshold: z.number().int().positive(), // >= triggers
    declines_24h_threshold: z.number().int().positive(), // >= triggers
    injection_flags_24h_threshold: z.number().int().positive(), // >= triggers
  })
  .strict();

export const PerAgentVelocitySchema = z
  .object({
    /** Max requests attributable to one agent identity in any rolling 3600s
     *  window INCLUDING the request being evaluated. */
    max_requests_per_hour: z.number().int().positive(),
    /** Max APPROVED (reserved/settled) value attributable to one identity in any
     *  rolling 86400s window INCLUDING the proposal being evaluated. Declines do
     *  not consume budget but DO count toward request_count. */
    max_value_per_day_paise: Paise,
    /** Frozen literal: documents that unknown velocity can only fail closed. */
    unavailable_snapshot_policy: z.literal("ESCALATE_FAIL_CLOSED"),
  })
  .strict();

export const EscalationBandsSchema = z
  .object({
    /** Cart totals in [cap*(1 - x/100), cap] ESCALATE instead of auto-approving.
     *  0 disables the band. Both edges inclusive. */
    cart_value_band_pct_below_cap: Pct,
    /** Discounts within y percentage points BELOW the cap ([cap-y, cap]) ESCALATE.
     *  0 disables. Inclusive edges. At-or-over the cap remains a hard FAIL. */
    discount_band_pp_below_cap: Pct,
  })
  .strict();

export const MerchantRulesConfigSchema = z
  .object({
    /** Monotonically increasing. Every decision records the version judged under.
     *  Config rows are INSERT-ONLY in Postgres (never UPDATE). */
    rules_version: z.number().int().positive(),
    effective_from_iso: IsoDateTime,
    currency: z.literal("INR"),

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
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (
      cfg.category_allowlist_mode === "ALLOWLIST" &&
      cfg.category_allowlist.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["category_allowlist"],
        message:
          "ALLOWLIST mode requires >=1 category (use ALL_ALLOWED instead)",
      });
    }
    if (
      cfg.escalation_bands.cart_value_band_pct_below_cap >= 100 &&
      cfg.escalation_bands.cart_value_band_pct_below_cap > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["escalation_bands"],
        message: "value band of 100% covers the whole domain; pick a smaller band",
      });
    }
    if (cfg.per_agent_velocity.max_value_per_day_paise < cfg.max_cart_value_paise) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["per_agent_velocity"],
        message:
          "daily value cap below single-cart cap makes every cart fail; raise it",
      });
    }
  });

export type MerchantRulesConfig = z.infer<typeof MerchantRulesConfigSchema>;

/* ===================== ProposedCart (post-audit input) ================= */

export const ProposedCartLineSchema = z
  .object({
    sku_id: z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, "canonical SKU id"),
    quantity: z.number().int().positive().max(999),
    /** AI's echo of the unit price. ADVISORY ONLY — the gatekeeper recomputes
     *  from ground truth; mismatch is recorded, never obeyed. */
    claimed_unit_price_paise: Paise.optional(),
    /** Citation IDs ALREADY VERIFIED by the deterministic Citation Auditor
     *  upstream; carried for trace correlation. The gate does NOT re-verify
     *  citations (separation of duties) but DOES require the flag below. */
    citation_ids: z.array(z.string().min(1)).max(20).default([]),
  })
  .strict();

export type ProposedCartLine = z.infer<typeof ProposedCartLineSchema>;

/** KEPT FOR DIFFING ONLY — deliberately loose inner types so that even garbage
 *  the negotiation model emits can flow in and be NOTICED by the drift rule. */
export const AiSuppliedTotalsSchema = z
  .object({
    subtotal_paise: z.number(),
    discount_paise: z.number(),
    total_paise: z.number(),
    claimed_blended_margin_pct: z.number().optional(),
  })
  .strict();

export type AiSuppliedTotals = z.infer<typeof AiSuppliedTotalsSchema>;

export const BundleDiscountReasonSchema = z.enum([
  "NONE",
  "CAMPAIGN_PRIORITY",
  "NEGOTIATION_CONCESSION",
  "PROMO_CODE",
]);

export const ProposedCartSchema = z
  .object({
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
    negotiation_summary_md: z.string().max(4000).default(""),

    /** Verbatim customer note. Read by the separate deterministic injection
     *  tagger — NOT by the gatekeeper, which receives only InjectionSignal. */
    customer_note_raw: z.string().max(2000).default(""),

    issued_at_iso: IsoDateTime,
    expires_at_iso: IsoDateTime,

    /** Pipeline contract. If false, GK-CITATION-GATE BLOCKERs immediately. */
    citations_audited: z.boolean(),
  })
  .strict()
  .refine((c) => c.lines.length > 0, {
    message: "empty cart",
    path: ["lines"],
  });

export type ProposedCart = z.infer<typeof ProposedCartSchema>;

/* ============= GroundTruthSnapshot (the ONLY pricing source) =========== */

export const CatalogItemGroundTruthSchema = z
  .object({
    sku_id: z.string(),
    name_raw: z.string(), // merchant-entered
    category_raw: z.string(), // merchant-assigned category
    list_price_paise: Paise,
    cost_price_paise: Paise,
    stock_on_hand: z.number().int().nonnegative(),
    sell_by_iso: IsoDateTime.nullable(),
  })
  .strict();
// TRUST RULE ENCODED IN THE TYPE: enrichment fields (descriptions, tags,
// occasions, pairings) are STRUCTURALLY ABSENT here. Their absence IS the
// rule "enrichment never becomes authoritative for price/cost/stock".

export type CatalogItemGroundTruth = z.infer<typeof CatalogItemGroundTruthSchema>;

export const GroundTruthSnapshotSchema = z
  .object({
    merchant_id: z.string(),
    catalog_version: z.string(),
    taken_at_iso: IsoDateTime,
    items: z.array(CatalogItemGroundTruthSchema).max(500),
  })
  .strict();

export type GroundTruthSnapshot = z.infer<typeof GroundTruthSnapshotSchema>;

/* ========== AgentVelocitySnapshot (explicit UNAVAILABLE semantics) ===== */

export const VelocityWindowStatSchema = z
  .object({
    window_seconds: z.union([z.literal(3600), z.literal(86400)]),
    window_end_iso: IsoDateTime, // == snapshot taken_at
    /** Requests attributed to this identity in (end - seconds, end].
     *  EXCLUDES the proposal under evaluation — the engine adds +1 itself
     *  (documented convention; kills the classic off-by-one). */
    request_count: z.number().int().nonnegative(),
    /** APPROVED (reserved/settled) value in the same window. Declines don't
     *  consume budget but DO count in request_count (spam detection). */
    approved_value_paise: Paise,
  })
  .strict();

export const AgentVelocitySnapshotSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("AVAILABLE"),
      agent_identity_id: z.string(),
      hour_window: VelocityWindowStatSchema,
      day_window: VelocityWindowStatSchema,
      prior_escalations_24h: z.number().int().nonnegative(),
      prior_declines_24h: z.number().int().nonnegative(),
      injection_flags_24h: z.number().int().nonnegative(),
      source: z.literal("redis_sliding_window_v1"),
    })
    .strict(),
  z
    .object({
      status: z.literal("UNAVAILABLE"),
      /** Fail-closed taxonomy: WHY we don't know, so the audit log is honest. */
      reason: z.enum([
        "REDIS_UNREACHABLE",
        "REDIS_TIMEOUT",
        "CORRUPT_RECORD",
        "IDENTITY_UNKNOWN",
      ]),
      detail: z.string().max(500),
    })
    .strict(),
]);

export type AgentVelocitySnapshot = z.infer<typeof AgentVelocitySnapshotSchema>;
export type VelocityWindowStat = z.infer<typeof VelocityWindowStatSchema>;

/* Semantics (normative):
 *  - AVAILABLE   => both velocity rules evaluate numerically.
 *  - UNAVAILABLE => both velocity rules emit status UNAVAILABLE_INPUT with
 *    reason_code VELOCITY_UNAVAILABLE => outcome is ESCALATE (never APPROVE,
 *    never silent pass). There is no third "UNKNOWN" state: absence of data
 *    is data, and it means "we do not know this agent is safe". */

/* ================= InjectionSignal (deterministic tagger) ============== */

export const InjectionPatternHitSchema = z
  .object({
    pattern_id: z.string().min(1).max(64), // e.g. 'authority_claim', 'discount_token'
    snippet: z.string().max(160), // trimmed match; drives the UI's RED banner
  })
  .strict();

export const InjectionSignalSchema = z
  .object({
    suspected: z.boolean(),
    risk_score: z.number().min(0).max(100), // deterministic heuristic; display only
    hits: z.array(InjectionPatternHitSchema).max(10),
    tagger_version: z.string().min(1),
  })
  .strict();

export type InjectionSignal = z.infer<typeof InjectionSignalSchema>;

/* ==================== DecisionTrace and GatekeeperResult =============== */

export const RuleStatusSchema = z.enum([
  "PASS", // rule satisfied
  "FAIL", // rule violated -> consequence per severity
  "BAND", // inside an escalation band (soft edge) -> ESCALATE
  "ESCALATE_TRIGGER", // qualitative trigger (injection, repeat offender)
  "UNAVAILABLE_INPUT", // required input missing/unavailable -> ESCALATE (fail closed)
  "SKIP", // could not run because a dependency failed -> neutral,
]); //   reason recorded; NEVER silently absent

export const SeveritySchema = z.enum(["BLOCKER", "ESCALATE_IF_FAILED", "ADVISORY"]);

export type RuleStatus = z.infer<typeof RuleStatusSchema>;
export type Severity = z.infer<typeof SeveritySchema>;

export const RuleEvaluationSchema = z
  .object({
    rule_id: z.string(), // RuleId union at the type level (gatekeeper.md §4)
    status: RuleStatusSchema,
    severity: SeveritySchema,
    expected: z.string().nullable(), // human bound, e.g. '<= ₹5,000.00'
    actual: z.string().nullable(), // observation, e.g. '₹5,123.45'
    human_message: z.string(), // mechanical sentence w/ concrete numbers;
    //   never quotes or paraphrases AI prose as fact
    reason_code: z.string().nullable(), // DeclineCode | EscalationCode | AdvisoryCode
    evidence: z.record(z.unknown()), // structured numbers for UI + tests,
    //   e.g. { cap_paise: 500000, total_paise: 500123 }
  })
  .strict();

export type RuleEvaluation = z.infer<typeof RuleEvaluationSchema>;

export const RecomputedTotalsSchema = z
  .object({
    line_count: z.number().int().nonnegative(),
    gross_paise: Paise,
    discount_paise: Paise,
    net_paise: Paise, // == what settlement sends as Razorpay `amount`
    cost_paise: Paise,
    margin_paise: z.number().int(), // may be negative
    blended_margin_bps: z.number().int(), // display only: floor(M*10000/N); decision
    //   used exact cross-multiplication (§8.3)
    per_line: z
      .array(
        z
          .object({
            sku_id: z.string(),
            quantity: z.number().int(),
            gross_paise: Paise,
            discount_alloc_paise: Paise,
            net_paise: Paise,
            cost_paise: Paise,
            margin_paise: z.number().int(),
          })
          .strict(),
      ),
  })
  .strict();

export type RecomputedTotals = z.infer<typeof RecomputedTotalsSchema>;

export const GateOutcomeSchema = z.enum(["APPROVE", "DECLINE", "ESCALATE"]);

export type GateOutcome = z.infer<typeof GateOutcomeSchema>;

export const ReasonSchema = z.object({
  rule_id: z.string(),
  reason_code: z.string(),
  human_message: z.string(),
});

export type Reason = z.infer<typeof ReasonSchema>;

export const GatekeeperResultSchema = z
  .object({
    tx_id: z.string(),
    proposal_id: z.string(),
    outcome: GateOutcomeSchema,
    rules_version: z.number().int().positive(),
    evaluated_at_iso: IsoDateTime, // == input.now_iso (injected clock echoed)
    input_digest: z.string().length(64), // sha256(canonicalJson(inputs)) — binds the
    //   decision to the EXACT inputs (audit chain + escalation re-entry binding, §18.8)
    recomputed: RecomputedTotalsSchema,
    trace: z.array(RuleEvaluationSchema), // INVARIANT: length === RULE_REGISTRY.length, always
    summary: z
      .object({
        total_rules: z.number().int(),
        passed: z.number().int(),
        failed: z.number().int(),
        escalation_triggers: z.number().int(),
        skipped: z.number().int(),
      })
      .strict(),
    declines: z.array(ReasonSchema), // ALL blocker failures, populated iff DECLINE
    escalations: z.array(ReasonSchema), // ALL escalation causes, populated iff ESCALATE
  })
  .strict();

export type GatekeeperResult = z.infer<typeof GatekeeperResultSchema>;

/* ======================= Reason-code unions (ids) ====================== */
/* Ported from gatekeeper.md §3.6. NOTE (documented normalization): the §3.6
 * DeclineCode list omits the two velocity decline codes that the §6 registry
 * table mandates (`VELOCITY_REQUESTS`, `VELOCITY_VALUE_EXCEEDED`); they are
 * added here because §6 is the operative registry contract. */

export const RULE_IDS = [
  "GK-CITATION-GATE",
  "GK-RULES-EFFECTIVE",
  "GK-PROPOSAL-FRESHNESS",
  "GK-CART-STRUCTURE",
  "GK-SKU-RESOLUTION",
  "GK-TOTALS-DRIFT",
  "GK-CART-VALUE",
  "GK-DISCOUNT-CAP",
  "GK-MARGIN-FLOOR",
  "GK-CATEGORY-ALLOWLIST",
  "GK-STOCK-AVAILABILITY",
  "GK-EXPIRY-GUARD",
  "GK-VELOCITY-REQUESTS",
  "GK-VELOCITY-VALUE",
  "GK-INJECTION-GUARD",
  "GK-REPEAT-OFFENDER",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export type DeclineCode =
  | "CITATION_GATE_FAILED"
  | "STALE_PROPOSAL"
  | "FUTURE_ISSUED_AT"
  | "EMPTY_CART"
  | "INVALID_QUANTITY"
  | "INVALID_DISCOUNT_RANGE"
  | "MALFORMED_NUMERIC"
  | "UNKNOWN_SKU"
  | "OVER_CART_VALUE"
  | "OVER_DISCOUNT_CAP"
  | "BELOW_MARGIN_FLOOR"
  | "ZERO_NET_REVENUE"
  | "CATEGORY_BLOCKED"
  | "INSUFFICIENT_STOCK"
  | "SKU_EXPIRED"
  | "VELOCITY_REQUESTS"
  | "VELOCITY_VALUE_EXCEEDED";

export type EscalationCode =
  | "RULES_NOT_YET_EFFECTIVE"
  | "VALUE_IN_BAND"
  | "DISCOUNT_IN_BAND"
  | "VELOCITY_UNAVAILABLE"
  | "INJECTION_SUSPECTED"
  | "REPEAT_OFFENDER"
  | "TOTALS_DRIFT_MATERIAL";

export type AdvisoryCode =
  | "LINES_MERGED"
  | "PRICE_ECHO_MISMATCH"
  | "TOTALS_DRIFT_MINOR";

/* ================= Default Meera rules + ground truth (seed) =========== */

export const MEERA_RULES_V3: MerchantRulesConfig = {
  rules_version: 3,
  effective_from_iso: "2026-08-01T00:00:00Z",
  currency: "INR",
  max_cart_value_paise: 500_000, // ₹5,000.00
  max_discount_pct: 15,
  margin_floor_pct: 25,
  category_allowlist_mode: "ALLOWLIST",
  category_allowlist: ["CAKES", "BROWNIES", "COOKIES", "HAMPERS", "BREADS"],
  per_agent_velocity: {
    max_requests_per_hour: 12,
    max_value_per_day_paise: 2_000_000, // ₹20,000.00/day
    unavailable_snapshot_policy: "ESCALATE_FAIL_CLOSED",
  },
  escalation_bands: { cart_value_band_pct_below_cap: 15, discount_band_pp_below_cap: 5 },
  stock_policy: {
    require_full_availability: true,
    backorder_allowed_skus: [],
    reservation_ttl_seconds: 900,
  },
  expiry_policy: { block_expired_skus: true },
  repeat_offender: {
    escalations_24h_threshold: 2,
    declines_24h_threshold: 5,
    injection_flags_24h_threshold: 1,
  },
  proposal_max_age_seconds: 300,
  proposal_max_future_skew_seconds: 60,
  totals_drift_material_frac_ppm: 10_000,
};

/** Ground-truth fixture used across the test matrix (costs chosen so margins are
 *  realistic for a home bakery; HAMP-DIW-05 = underselling seed, CKI-KAJU-250 =
 *  near-expiry seed). */
export const MEERA_GT_V1: GroundTruthSnapshot = {
  merchant_id: "meeras-cakes",
  catalog_version: "gt-2026-08-25.1",
  taken_at_iso: "2026-08-25T09:00:00Z",
  items: [
    {
      sku_id: "CAKE-CHOC-500",
      name_raw: "Chocolate Truffle Cake 500g",
      category_raw: "CAKES",
      list_price_paise: 64_900,
      cost_price_paise: 38_000,
      stock_on_hand: 10,
      sell_by_iso: null,
    },
    {
      sku_id: "BRWN-BOX-9",
      name_raw: "Brownie Box (9 pc)",
      category_raw: "BROWNIES",
      list_price_paise: 24_900,
      cost_price_paise: 14_000,
      stock_on_hand: 40,
      sell_by_iso: null,
    },
    {
      sku_id: "CKI-KAJU-250",
      name_raw: "Kaju Cookie Box 250g",
      category_raw: "COOKIES",
      list_price_paise: 19_900,
      cost_price_paise: 9_000,
      stock_on_hand: 25,
      sell_by_iso: "2026-08-27T23:59:59Z", // near-expiry seed
    },
    {
      sku_id: "HAMP-DIW-05",
      name_raw: "Diwali Hamper #5",
      category_raw: "HAMPERS",
      list_price_paise: 199_900,
      cost_price_paise: 115_000,
      stock_on_hand: 6,
      sell_by_iso: null, // underselling seed
    },
    {
      sku_id: "BRED-SOUR-1",
      name_raw: "Sourdough Loaf",
      category_raw: "BREADS",
      list_price_paise: 15_900,
      cost_price_paise: 11_000,
      stock_on_hand: 3,
      sell_by_iso: null,
    },
  ],
};

/* ================== SECTION B — EVIDENCE PACK SCHEMAS ==================
 * Ported VERBATIM from docs/design/negotiation.md §1.1–§1.2. All money fields
 * are INTEGER PAISE. All pct fields are rounded to 2dp by trusted code. */

export const EvidenceKindZ = z.enum([
  "PRICE",
  "STOCK",
  "MARGIN",
  "SALES_STAT",
  "ATTACH_RATE",
  "OCCASION_FIT",
  "PAIRING",
  "CAMPAIGN_PRIORITY",
]);
export type EvidenceKind = z.infer<typeof EvidenceKindZ>;

export const PricePayloadZ = z
  .object({
    label: z.string(), // RAW merchant product name (never LLM-enriched)
    category_raw: z.string(),
    list_price_paise: z.number().int().positive(),
    cost_paise: z.number().int().nonnegative(),
    currency: z.literal("INR"),
  })
  .strict();

export const StockPayloadZ = z
  .object({
    qty_on_hand: z.number().int().nonnegative(),
    reserved_qty: z.number().int().nonnegative(),
    available_qty: z.number().int().nonnegative(), // on_hand - reserved, computed by trusted SQL
    expires_on: z.string().date().nullable(), // ISO date, null = no expiry
    days_to_expiry: z.number().int().nullable(), // floor((expires_on - simToday)/24h), null-safe
  })
  .strict();

export const MarginPayloadZ = z
  .object({
    margin_pct: z.number(), // ((list-cost)/list*100), rounded HALF_UP to 2dp
    contribution_per_unit_paise: z.number().int(), // list_price_paise - cost_paise
  })
  .strict();

export const SalesStatPayloadZ = z
  .object({
    window_days: z.literal(90),
    units_sold: z.number().int().nonnegative(),
    revenue_paise: z.number().int().nonnegative(),
    orders_with_sku: z.number().int().nonnegative(),
    avg_units_per_week: z.number(), // round(units/90*7, 1)
    trend_pct: z.number().nullable(), // last-30d vs prior-30d weekly rate delta, 1dp; null if prior=0
  })
  .strict();

export const AttachRatePayloadZ = z
  .object({
    base_sku: z.string(),
    attach_sku: z.string(),
    attach_rate_pct: z.number(), // 2dp, computed upstream (campaign MV)
    co_occurrence_orders: z.number().int().nonnegative(),
    sample_orders: z.number().int().nonnegative(),
  })
  .strict();

export const OccasionFitPayloadZ = z
  .object({
    occasions: z.array(z.string()).max(6),
    tags: z.array(z.string()).max(10),
    confidence: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const PairingPayloadZ = z
  .object({
    pairs_with: z.array(z.string()).max(6), // SKUs or free-text pairing hints
    pitch_line: z.string().max(240), // enrichment copy — NEVER price/margin/stock content
  })
  .strict();

// NORMALIZATION (ARCHITECTURE.md §18 row 5): campaign.md's producer enum wins
// over negotiation.md's sketched PUSH_ITEM/BUILD_BUNDLE/CLEARANCE/CROSS_SELL_TIMING.
export const CampaignActionZ = z.enum([
  "PRIORITIZE_IN_BUNDLES",
  "CLEAR_NEAR_EXPIRY",
  "PROMOTE_PAIR",
]);

export const CampaignPriorityPayloadZ = z
  .object({
    priority_id: z.string().regex(/^PRI-[A-Z0-9-]{3,32}$/),
    action: CampaignActionZ,
    target_skus: z.array(z.string()).min(1),
    rationale_plain: z.string().max(280), // plain-language "why" from campaign agent
    weight: z.number().int().min(0).max(100),
    /** Merchant-configured ADVERTISED ceiling for this campaign. Advisory only:
     *  the auditor uses it to detect fabricated discount claims; it authorizes NOTHING. */
    max_discount_pct_advertised: z.number().min(0).max(100).nullable(),
  })
  .strict();

export type PricePayload = z.infer<typeof PricePayloadZ>;
export type StockPayload = z.infer<typeof StockPayloadZ>;
export type MarginPayload = z.infer<typeof MarginPayloadZ>;
export type SalesStatPayload = z.infer<typeof SalesStatPayloadZ>;
export type AttachRatePayload = z.infer<typeof AttachRatePayloadZ>;
export type OccasionFitPayload = z.infer<typeof OccasionFitPayloadZ>;
export type PairingPayload = z.infer<typeof PairingPayloadZ>;
export type CampaignPriorityPayload = z.infer<typeof CampaignPriorityPayloadZ>;

/** Discriminated payload union — `payload.kind` must equal the entry kind;
 *  enforced by superRefine on the entry below (negotiation.md §1.1 note).
 *  Invariant: you cannot construct an entry whose payload shape disagrees
 *  with its kind. */
export const EvidencePayloadZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PRICE"), payload: PricePayloadZ }).strict(),
  z.object({ kind: z.literal("STOCK"), payload: StockPayloadZ }).strict(),
  z.object({ kind: z.literal("MARGIN"), payload: MarginPayloadZ }).strict(),
  z.object({ kind: z.literal("SALES_STAT"), payload: SalesStatPayloadZ }).strict(),
  z.object({ kind: z.literal("ATTACH_RATE"), payload: AttachRatePayloadZ }).strict(),
  z.object({ kind: z.literal("OCCASION_FIT"), payload: OccasionFitPayloadZ }).strict(),
  z.object({ kind: z.literal("PAIRING"), payload: PairingPayloadZ }).strict(),
  z
    .object({ kind: z.literal("CAMPAIGN_PRIORITY"), payload: CampaignPriorityPayloadZ })
    .strict(),
]);

export type EvidencePayload = z.infer<typeof EvidencePayloadZ>;

export const EvidencePackEntryZ = z
  .object({
    id: z.string().regex(/^E\d{3}$/),
    kind: EvidenceKindZ,
    // NORMALIZATION (ARCHITECTURE.md §18): canonical SKU shape adopted from the
    // gatekeeper fixtures (`CAKE-CHOC-500`) — NOT negotiation.md's sketched
    // `^SKU-[A-Z0-9-]{3,24}$`; packs are built from the same catalog rows.
    sku: z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/)
      .nullable(), // null for store-level stats & campaigns
    payload: EvidencePayloadZ,
    source_table: z.string(), // e.g. "products", "inventory+stock_reservations"
    computed_at: z.string().datetime(), // simulation-clock instant, ISO 8601
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.payload.kind !== entry.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: `payload.kind ${entry.payload.kind} disagrees with entry.kind ${entry.kind}`,
      });
    }
  });

export type EvidencePackEntry = z.infer<typeof EvidencePackEntryZ>;

/** Pack container (negotiation.md §1.2). */
export const EvidencePackContainerZ = z
  .object({
    pack_hash: z.string().length(64), // sha256 hex of canonicalJson(entries)
    built_at: z.string().datetime(), // simulation clock
    sim_today: z.string().date(),
    merchant_id: z.string(),
    entries: z.array(EvidencePackEntryZ), // sorted by id ascending — canonical order
  })
  .strict();

export type EvidencePackContainer = z.infer<typeof EvidencePackContainerZ>;
