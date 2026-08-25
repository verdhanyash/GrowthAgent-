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
  matched_snippets: z.array(z.string()),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  customer_note_full: z.string(), // manipulative text shown VERBATIM in red banner
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

/* Payloads owned by later modules (M2+); names pinned now so the taxonomy,
 * envelope typing and parseFrame dispatch stay stable. Their owning module
 * specs refine these in place. */
const PlaceholderZ = z.unknown();

export const EVENT_SCHEMAS = {
  stage_started: StageStartedZ,
  stage_completed: StageCompletedZ,
  evidence_pack_built: PlaceholderZ,
  campaign_priority_injected: PlaceholderZ,
  negotiation_token: NegotiationTokenZ,
  negotiation_snapshot: NegotiationSnapshotZ,
  proposal_ready: PlaceholderZ,
  citation_audit_result: PlaceholderZ,
  gatekeeper_rule_result: GatekeeperRuleResultZ,
  gatekeeper_decision: GatekeeperDecisionZ,
  settlement_step: PlaceholderZ,
  webhook_received: PlaceholderZ,
  escalation_created: PlaceholderZ,
  escalation_approved: PlaceholderZ,
  escalation_rejected: PlaceholderZ,
  explanation_narrative: PlaceholderZ,
  degraded: PlaceholderZ,
  injection_flagged: InjectionFlaggedZ,
  error: ErrorEventZ,
  heartbeat: HeartbeatZ,
  rules_version_updated: RulesVersionUpdatedZ,
} as const satisfies Record<EventName, z.ZodTypeAny>;

export type EventPayloadMap = {
  [K in EventName]: K extends keyof typeof TYPED_PAYLOADS
    ? z.infer<(typeof TYPED_PAYLOADS)[K]>
    : unknown;
};

/** Subset of payloads fully specified for M1. */
export const TYPED_PAYLOADS = {
  stage_started: StageStartedZ,
  stage_completed: StageCompletedZ,
  negotiation_token: NegotiationTokenZ,
  negotiation_snapshot: NegotiationSnapshotZ,
  heartbeat: HeartbeatZ,
  gatekeeper_rule_result: GatekeeperRuleResultZ,
  gatekeeper_decision: GatekeeperDecisionZ,
  injection_flagged: InjectionFlaggedZ,
  error: ErrorEventZ,
  rules_version_updated: RulesVersionUpdatedZ,
} as const;

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
