/**
 * SSE live-event protocol types — ported from docs/design/frontend-events.md
 * §1.4–§1.5 (M1 minimal subset: envelope + full taxonomy + DURABILITY CLASSES).
 *
 * Hard interface rule (FE doc §0): every SSE payload is a zod schema in the
 * shared workspace package — emitter validates on write, browser validates on
 * read.
 *
 * Normalization note (recorded): frontend-events.md mirrored an EARLIER
 * 7-rule gatekeeper vocabulary ("MAX_CART_VALUE", verdict "ESCALATE",
 * decision "DECLINE_WITH_REASON"). The canonical registry is gatekeeper.md
 * §3.6/§6 (16 GK-* rule ids), which WINS per repo policy — the two
 * gatekeeper payloads below mirror it exactly. Cross-doc normalization
 * register lives in ARCHITECTURE.md.
 */
import { z } from "zod";
import { RULE_IDS } from "./schemas.js";

/* ---------------------------- primitives ------------------------------ */

export const TxId = z.string().regex(/^tx_[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
export type TxId = z.infer<typeof TxId>;

export const AgentKind = z.enum([
  "BUYER",
  "PIPELINE",
  "CAMPAIGN",
  "NEGOTIATION",
  "CITATION_AUDITOR",
  "GATEKEEPER",
  "SETTLEMENT",
  "EXPLAINER",
  "SYSTEM",
]);
export type AgentKind = z.infer<typeof AgentKind>;

export const AgentIdentitySchema = z.object({
  agent_id: z.string(), // e.g. "buyer.sim.well-behaved"
  kind: AgentKind,
  key_hash: z.string().length(64), // sha256 hex of hashed API key — NEVER the raw key
});

export const StageName = z.enum([
  "INTAKE",
  "CONTEXT_BUILD",
  "CAMPAIGN_INJECT",
  "NEGOTIATION",
  "CITATION_AUDIT",
  "GATEKEEPER",
  "ESCALATION_WAIT",
  "SETTLEMENT",
  "EXPLAIN",
]);
export type StageName = z.infer<typeof StageName>;

/** Wire envelope = exactly one row of the audit log (durable events). */
export interface AuditEnvelope<T extends EventName = EventName> {
  seq: number; // GLOBAL audit_log.seq == SSE id
  prev_hash: string | null; // hash chain
  hash: string;
  tx_id: TxId;
  ts: string; // ISO-8601 UTC
  event: T;
  actor: z.infer<typeof AgentIdentitySchema>;
  rules_version: number; // MerchantRulesConfig version active at emission
  payload: EventPayloadMap[T];
}

/* ------------------------ durability classes --------------------------
 * DURABLE: persisted to hash-chained audit_log, carries SSE `id:` == seq,
 *          replayable exactly after reconnect.
 * EPHEMERAL: bus only — negotiation_token / negotiation_snapshot /
 *          heartbeat. No DB row, no `id:` (never perturbs resume position);
 *          mid-negotiation text reconstructed via negotiation_snapshot. */

export const EPHEMERAL_EVENTS = [
  "negotiation_token",
  "negotiation_snapshot",
  "heartbeat",
] as const;
export type EphemeralEventName = (typeof EPHEMERAL_EVENTS)[number];

export function isEphemeralEvent(name: EventName): name is EphemeralEventName {
  return (EPHEMERAL_EVENTS as readonly string[]).includes(name);
}

/* --------------------------- taxonomy --------------------------------- */

export const EVENT_NAMES = [
  "stage_started", // durable
  "stage_completed", // durable
  "evidence_pack_built",
  "campaign_priority_injected",
  "negotiation_token", // EPHEMERAL — no id, not persisted
  "negotiation_snapshot", // EPHEMERAL — reconnect recovery
  "proposal_ready",
  "citation_audit_result",
  "gatekeeper_rule_result", // PER RULE — enables progressive color-coded table
  "gatekeeper_decision",
  "settlement_step",
  "webhook_received",
  "escalation_created",
  "escalation_approved",
  "escalation_rejected",
  "explanation_narrative",
  "degraded",
  "injection_flagged",
  "error",
  "heartbeat", // EPHEMERAL — no id, not persisted
  "rules_version_updated", // admin stream only (inbox + form stale-guard)
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/* ----------------------- payload schemas ------------------------------ */

const StageStartedZ = z.object({ stage: StageName, attempt: z.number().int().positive() });
const StageCompletedZ = z.object({
  stage: StageName,
  duration_ms: z.number().int().nonnegative(),
  outcome: z.enum(["OK", "DEGRADED", "FAILED"]),
});

const NegotiationTokenZ = z.object({
  delta_index: z.number().int().nonnegative(),
  kind: z.enum(["text", "thinking_summary"]),
  text: z.string(),
});
const NegotiationSnapshotZ = z.object({
  text_so_far: z.string(),
  thinking_so_far: z.string(),
  delta_index_so_far: z.number().int().nonnegative(),
  stream_open: z.boolean(),
});
const HeartbeatZ = z.object({ server_ts: z.string(), head_seq: z.number().int() });

/** Mirrors gatekeeper.md §3.5 RuleEvaluation (canonical 16-rule registry). */
const GatekeeperRuleResultZ = z.object({
  run_id: z.string(),
  rule_id: z.enum(RULE_IDS),
  status: z.enum(["PASS", "FAIL", "BAND", "ESCALATE_TRIGGER", "UNAVAILABLE_INPUT", "SKIP"]),
  severity: z.enum(["BLOCKER", "ESCALATE_IF_FAILED", "ADVISORY"]),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  human_message: z.string(),
  reason_code: z.string().nullable(),
  evidence: z.record(z.unknown()),
});
const GatekeeperDecisionZ = z.object({
  decision: z.enum(["APPROVE", "DECLINE", "ESCALATE"]),
  rules_version_evaluated: z.number().int(),
  input_digest: z.string().length(64),
  declines: z.array(
    z.object({ rule_id: z.string(), reason_code: z.string(), human_message: z.string() }),
  ),
  escalations: z.array(
    z.object({ rule_id: z.string(), reason_code: z.string(), human_message: z.string() }),
  ),
  total_duration_ms: z.number().int().nonnegative(),
});

const InjectionFlaggedZ = z.object({
  detector: z.literal("HEURISTIC_TAGGER"), // deterministic, OUTSIDE LLM trust
  patterns_matched: z.array(z.string()), // e.g. ["SYSTEM_NOTE_SPOOF","DISCOUNT_OVERRIDE_TOKEN"]
  // Bounded CONTRACTUALLY, not just by the producer: the tagger already caps
  // each snippet at 160 chars and can match at most one hit per pattern (5),
  // so these limits never reject a legitimate emit — they stop a future
  // detector from turning this frame into an unbounded attacker-text channel.
  matched_snippets: z.array(z.string().max(160)).max(8),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  // Bounded preview shown in the red banner (full note is persisted server-side
  // in proposal_txs.request_bytes); prevents a hostile note from dumping
  // unbounded attacker text to every subscriber. matched_snippets keep forensics.
  // NOTE: the preview is CONTEXT, not evidence — a note can pad 280+ benign
  // chars before the injection, so the banner must quote matched_snippets.
  customer_note_preview: z.string().max(280),
  customer_note_len: z.number().int().nonnegative(),
  agent_identity_hash: z.string(),
  velocity_counter_incremented: z.boolean(),
});

const ErrorEventZ = z.object({
  stage: StageName,
  code: z.enum([
    "LLM_TIMEOUT",
    "LLM_API_ERROR",
    "GATEKEEPER_INVARIANT",
    "DB_ERROR",
    "ADAPTER_ERROR",
    "INTERNAL",
  ]),
  message: z.string(), // safe-for-display; no stack traces, no secrets
  retriable: z.boolean(),
  chaos_forced: z.boolean().optional(),
});

const RulesVersionUpdatedZ = z.object({
  rules_version: z.number().int(),
  updated_by: z.string(),
  changed_fields: z.array(z.string()),
});

/* ------------------------------------------------------------------------
 * Payloads that earlier milestones (M2–M7) pinned as PlaceholderZ. They are
 * now completed to mirror the EXACT objects the pipeline orchestrator emits
 * at each stage (verified field-by-field against
 * api/src/pipeline/orchestrator.ts). Design goals, in priority order:
 *
 *  1. validate-on-write must NEVER regress. The emitter calls
 *     EVENT_SCHEMAS[event].parse(payload) and THROWS on failure (failing the
 *     stage). So these use plain z.object (NOT .strict) — extra/future keys
 *     are tolerated — and every value type is permissive (enum-ish fields are
 *     z.string(), not z.enum(...)) so a legitimate emit can never be rejected.
 *  2. emit()'s compile-time type (EventPayloadMap[K]) must still accept the
 *     orchestrator's emit-site object literals: each schema declares exactly
 *     the top-level keys the emitter composes, marking conditionally-emitted
 *     keys .optional(), so there is no excess-property or missing-key error.
 *  3. The browser gets real payload types instead of `unknown`.
 *
 * Sub-objects owned by other builders (the evidence pack, the zod/v4
 * NegotiationProposal — which cannot be nested inside this zod v3 module) are
 * kept loose (.passthrough() / z.unknown()) so a richer legit payload passes.
 */

// evidence_pack_built — { pack: EvidencePackContainer } (see pipeline/evidence.ts)
const EvidencePackWireEntryZ = z
  .object({
    id: z.string(),
    kind: z.string(),
    sku: z.string().nullable().optional(),
    payload: z.unknown(),
    source_table: z.string().optional(),
    computed_at: z.string().optional(),
  })
  .passthrough();
const EvidencePackBuiltZ = z.object({
  pack: z
    .object({
      pack_hash: z.string(),
      built_at: z.string(),
      sim_today: z.string(),
      merchant_id: z.string(),
      entries: z.array(EvidencePackWireEntryZ),
    })
    .passthrough(),
});

// campaign_priority_injected
const CampaignPriorityInjectedZ = z.object({
  priority_set_id: z.string(),
  generated_at: z.string(),
  degraded: z.boolean(),
  priorities: z.array(
    z
      .object({
        priority_id: z.string(),
        action: z.string(),
        target_skus: z.array(z.string()),
        weight: z.number().int(),
        rationale_plain_language: z.string(),
      })
      .passthrough(),
  ),
});

// proposal_ready — proposal is the zod/v4 NegotiationProposal; mirrored loosely
// (a v4 schema cannot be nested inside this v3 module).
const ProposalWireZ = z
  .object({
    proposed_items: z.array(z.unknown()).optional(),
    bundle_discount_pct: z.number().optional(),
    claims: z.array(z.unknown()).optional(),
    customer_pitch: z.string().optional(),
    upsell_reasoning_summary: z.string().optional(),
    used_campaign_priority: z.boolean().optional(),
    campaign_priority_ids: z.array(z.string()).optional(),
  })
  .passthrough();
const ProposalReadyZ = z.object({
  proposal: ProposalWireZ,
  generator: z.string(),
  is_fallback: z.boolean(),
  degraded: z.boolean(),
  latency_ms: z.number().int().nonnegative(),
});

// citation_audit_result — the reduced SSE projection (NOT the full
// negotiation/audit.ts CitationAuditResult) the orchestrator emits.
const CitationAuditResultZ = z.object({
  auditor: z.string(),
  verdict: z.string(),
  checked_claims: z.number().int().nonnegative(),
  violation_count: z.number().int().nonnegative(),
  violations: z.array(
    z
      .object({
        claim_index: z.number().int().nullable().optional(),
        code: z.string(),
        detail: z.string(),
      })
      .passthrough(),
  ),
  proposal_accepted_into_pipeline: z.boolean(),
});

// settlement_step — only STOCK_RESERVE / RAZORPAY_ORDER_CREATE / PAYMENT_AWAIT
// (+ failures) are emitted today; step/status kept as strings for forward steps.
const SettlementStepZ = z.object({
  step: z.string(),
  status: z.string(),
  attempt: z.number().int().positive(),
  provider_mode: z.string().optional(),
  amount_paise: z.number().int().optional(),
  currency: z.string().optional(),
  razorpay_order_id: z.string().optional(),
  error_code: z.string().optional(),
});

// webhook_received — NOT currently emitted by the pipeline; schema pinned for
// forward-compat so the taxonomy/parseFrame dispatch stays stable.
const WebhookReceivedZ = z
  .object({
    provider: z.string().optional(),
    event_type: z.string().optional(),
    razorpay_order_id: z.string().optional(),
    status: z.string().optional(),
    verified: z.boolean().optional(),
  })
  .passthrough();

// escalation_created
const EscalationCreatedZ = z.object({
  escalation_id: z.string(),
  reason_codes: z.array(z.string()),
  expires_at: z.string(),
  proposed_cart: z
    .object({
      lines: z.array(z.unknown()),
      subtotal_paise: z.number().int(),
      discount_percent_bps: z.number().int(),
      discount_paise: z.number().int(),
      total_paise: z.number().int(),
    })
    .passthrough(),
  rule_trace_ref: z
    .object({ run_id: z.string(), trace_digest: z.string() })
    .passthrough(),
});

// escalation_approved / escalation_rejected (shared resolved shape)
const EscalationResolvedZ = z.object({
  escalation_id: z.string(),
  decision: z.string(),
  decided_by: z.string(),
  decided_at: z.string(),
  note: z.string().optional(),
});

// explanation_narrative — mirrors explainer/schema.ts ExplanationNarrativeSchema.
const ExplanationNarrativeZ = z.object({
  audience: z.string(),
  title: z.string(),
  body_md: z.string(),
  non_authoritative: z.literal(true),
  grounded_on_events: z.array(z.number().int()),
  degraded: z.boolean(),
});

// degraded — one per stage that fell back to a deterministic path.
const DegradedZ = z.object({
  stage: z.string(),
  cause: z.string(),
  fallback_engaged: z.string(),
  chaos_forced: z.boolean(),
});

export const EVENT_SCHEMAS = {
  stage_started: StageStartedZ,
  stage_completed: StageCompletedZ,
  evidence_pack_built: EvidencePackBuiltZ,
  campaign_priority_injected: CampaignPriorityInjectedZ,
  negotiation_token: NegotiationTokenZ,
  negotiation_snapshot: NegotiationSnapshotZ,
  proposal_ready: ProposalReadyZ,
  citation_audit_result: CitationAuditResultZ,
  gatekeeper_rule_result: GatekeeperRuleResultZ,
  gatekeeper_decision: GatekeeperDecisionZ,
  settlement_step: SettlementStepZ,
  webhook_received: WebhookReceivedZ,
  escalation_created: EscalationCreatedZ,
  escalation_approved: EscalationResolvedZ,
  escalation_rejected: EscalationResolvedZ,
  explanation_narrative: ExplanationNarrativeZ,
  degraded: DegradedZ,
  injection_flagged: InjectionFlaggedZ,
  error: ErrorEventZ,
  heartbeat: HeartbeatZ,
  rules_version_updated: RulesVersionUpdatedZ,
} as const satisfies Record<EventName, z.ZodTypeAny>;

export type EventPayloadMap = {
  [K in EventName]: z.infer<(typeof EVENT_SCHEMAS)[K]>;
};

export type AnyEnvelope = { [K in EventName]: AuditEnvelope<K> }[EventName];

/** Validate one SSE `data:` frame against the taxonomy. Malformed or unknown
 *  frames return ok:false — the stream never dies on a poison frame. */
export function parseFrame(
  event: string,
  data: string,
): { ok: true; value: AnyEnvelope } | { ok: false; error: unknown } {
  const schema = (EVENT_SCHEMAS as Record<string, z.ZodTypeAny | undefined>)[event];
  if (!schema) return { ok: false, error: new Error(`unknown event ${event}`) };
  try {
    const r = schema.safeParse(JSON.parse(data));
    return r.success
      ? { ok: true, value: r.data as AnyEnvelope }
      : { ok: false, error: r.error };
  } catch (err) {
    return { ok: false, error: err };
  }
}
