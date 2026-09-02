/**
 * shared/src/api/admin-contracts.ts — admin + demo control-plane schemas
 * (api-contract.md §7). Browser-safe (pure zod): the web admin screens (M-web)
 * and the api routes both bind these. NOTHING here imports node builtins.
 *
 * Kept out of contracts.ts (the buyer surface) so the two audiences stay
 * visibly separate — buyers never see these shapes.
 */
import { z } from "zod";
import { TxId, ApprovalId, IsoDateTime, RulesVersion } from "./primitives.js";
import { MerchantRulesConfigSchema } from "../schemas.js";
import { TerminalOutcomeSchema } from "./contracts.js";

/* ------------------------------ §7.1 rules ------------------------------- */

/** GET /v1/admin/rules — full config plus version metadata. */
export const AdminRulesResponseSchema = z
  .object({
    rules: MerchantRulesConfigSchema,
    rules_version: RulesVersion,
    updated_at: IsoDateTime,
  })
  .strict();
export type AdminRulesResponse = z.infer<typeof AdminRulesResponseSchema>;

/**
 * PUT /v1/admin/rules body. `patch` is a partial config merged over the current
 * one, then re-validated against the FULL schema. `expected_version` drives
 * optimistic concurrency (409 RULES_VERSION_CONFLICT on mismatch).
 * `confirm_increase` is required when the merge RAISES any guarded limit.
 */
export const PutRulesRequestSchema = z
  .object({
    patch: z.record(z.string(), z.unknown()),
    expected_version: RulesVersion,
    note: z.string().max(2000).optional(),
    confirm_increase: z.boolean().optional(),
  })
  .strict();
export type PutRulesRequest = z.infer<typeof PutRulesRequestSchema>;

/** One row of GET /v1/admin/rules/history. */
export const RulesHistoryEntrySchema = z
  .object({
    rules_version: RulesVersion,
    actor: z.string(),
    note: z.string().nullable(),
    increase: z.boolean(),
    diff: z.unknown(), // { before: partial, after: partial } — advisory display only
    created_at: IsoDateTime,
  })
  .strict();
export const RulesHistoryResponseSchema = z
  .object({ history: z.array(RulesHistoryEntrySchema) })
  .strict();
export type RulesHistoryEntry = z.infer<typeof RulesHistoryEntrySchema>;

/* ---------------------------- §7.2 approvals ----------------------------- */

export const ApproveRequestSchema = z
  .object({
    approver_note: z.string().max(2000).optional(),
    confirm_rules_version: RulesVersion.optional(),
  })
  .strict();
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

export const RejectRequestSchema = z
  .object({ approver_note: z.string().max(2000).optional() })
  .strict();
export type RejectRequest = z.infer<typeof RejectRequestSchema>;

/** 202 from approve — settlement resumes on the frozen proposal, detached. */
export const ApprovalResolvedSchema = z
  .object({
    approval_id: ApprovalId,
    status: z.enum(["SETTLING", "DECLINED"]),
  })
  .strict();
export type ApprovalResolved = z.infer<typeof ApprovalResolvedSchema>;

/* --------------------------- §7.3 audit replay --------------------------- */

export const AuditReplaySchema = z
  .object({
    tx_id: TxId,
    chain_valid: z.boolean(),
    broken_at_seq: z.number().int().positive().nullable(),
    event_count: z.number().int().nonnegative(),
    rebuilt_stages: z.array(
      z
        .object({
          stage: z.string(),
          entered_seq: z.number().int(),
          exited_seq: z.number().int().nullable(),
        })
        .strict(),
    ),
    rebuilt_outcome: TerminalOutcomeSchema.nullable(),
    first_event_at: IsoDateTime.nullable(),
    last_event_at: IsoDateTime.nullable(),
  })
  .strict();
export type AuditReplay = z.infer<typeof AuditReplaySchema>;

/* ------------------------------ §7 agents -------------------------------- */

export const AdminAgentSchema = z
  .object({
    agent_id: z.string(),
    display_name: z.string(),
    role: z.enum(["buyer_agent", "system"]),
    api_key_prefix: z.string(), // display only — NEVER the hash
    created_at: IsoDateTime,
    revoked_at: IsoDateTime.nullable(),
    revoked_reason: z.string().nullable(),
  })
  .strict();
export const AdminAgentsResponseSchema = z.object({ agents: z.array(AdminAgentSchema) }).strict();
export type AdminAgent = z.infer<typeof AdminAgentSchema>;

export const RevokeAgentRequestSchema = z
  .object({ reason: z.string().max(500).optional() })
  .strict();
export type RevokeAgentRequest = z.infer<typeof RevokeAgentRequestSchema>;

/* ------------------------------ §7.4 chaos ------------------------------- */

export const ChaosFlagSchema = z.enum(["LLM_TIMEOUT", "GATEWAY_ERROR"]);
export type ChaosFlag = z.infer<typeof ChaosFlagSchema>;

export const PutChaosRequestSchema = z
  .object({
    flag: ChaosFlagSchema,
    scope: z.object({ tx_ids: z.array(TxId).max(50) }).strict().optional(),
    ttl_minutes: z.number().int().positive().max(30).optional(), // default 10, cap 30
  })
  .strict();
export type PutChaosRequest = z.infer<typeof PutChaosRequestSchema>;

export const ArmedChaosSchema = z
  .object({
    flag: ChaosFlagSchema,
    tx_ids: z.array(TxId).nullable(), // null = global scope
    expires_at: IsoDateTime,
  })
  .strict();
export const ChaosStateResponseSchema = z.object({ armed: z.array(ArmedChaosSchema) }).strict();
export type ArmedChaos = z.infer<typeof ArmedChaosSchema>;

/* ---------------------------- §7.4 scenarios ----------------------------- */

export const ScenarioNameSchema = z.enum([
  "well_behaved",
  "adversarial_injection",
  "high_value_escalate",
  "llm_timeout_chaos",
  "gateway_error_chaos",
]);
export type ScenarioName = z.infer<typeof ScenarioNameSchema>;

export const ScenarioParamsSchema = z.object({ name: ScenarioNameSchema }).strict();

export const RunScenarioRequestSchema = z
  .object({
    overrides: z.object({ agent_alias: z.string().max(64).optional() }).strict().optional(),
  })
  .strict();
export type RunScenarioRequest = z.infer<typeof RunScenarioRequestSchema>;

export const ScenarioAcceptedSchema = z
  .object({
    run_id: z.string(),
    scenario: ScenarioNameSchema,
    tx_ids: z.array(TxId),
    watch_urls: z.array(z.string()),
  })
  .strict();
export type ScenarioAccepted = z.infer<typeof ScenarioAcceptedSchema>;

export const ScenarioRunResultSchema = z
  .object({
    run_id: z.string(),
    scenario: ScenarioNameSchema,
    status: z.enum(["RUNNING", "DONE", "ERROR"]),
    expected_outcome: z.string(),
    actual_outcome: z.string().nullable(),
    assertions: z.array(
      z.object({ name: z.string(), pass: z.boolean(), detail: z.string() }).strict(),
    ),
    pass: z.boolean(),
    tx_ids: z.array(TxId),
  })
  .strict();
export type ScenarioRunResult = z.infer<typeof ScenarioRunResultSchema>;

/* ----------------------------- §7.4 reset -------------------------------- */

export const DemoResetRequestSchema = z
  .object({ confirm: z.literal(true), force: z.boolean().optional() })
  .strict();
export type DemoResetRequest = z.infer<typeof DemoResetRequestSchema>;

export const DemoResetResponseSchema = z
  .object({
    reset_at: IsoDateTime,
    seeded: z.object({
      agents: z.array(z.string()),
      skus: z.array(z.string()),
      rules_version: RulesVersion,
    }),
    forced: z.boolean(),
  })
  .strict();
export type DemoResetResponse = z.infer<typeof DemoResetResponseSchema>;

/* --------------------------- §7.5 analytics ------------------------------
 * Read-only aggregates over the tables the pipeline already writes:
 * proposal_txs (outcome + timing), audit_log (rule verdicts, stage durations,
 * injection/degradation events), transactions + completed_sales (money), and
 * approvals (human-review latency). NOTHING here is synthesised — an empty
 * database yields zeroes and empty arrays, never placeholder shapes.
 */

/** Time window the dashboard scopes every figure to. */
export const AnalyticsWindowSchema = z.enum(["24h", "7d", "30d"]);
export type AnalyticsWindow = z.infer<typeof AnalyticsWindowSchema>;

/** The four terminal outcomes, as a chart-friendly flat enum. */
export const OutcomeKindSchema = z.enum(["APPROVED", "ESCALATED", "DECLINED", "FAILED"]);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

export const AnalyticsTotalsSchema = z
  .object({
    proposals: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
    declined: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    in_flight: z.number().int().nonnegative(),
    /** approved / (approved+escalated+declined+failed); null when nothing decided. */
    approval_rate_pct: z.number().nullable(),
    /** created_at → finished_at, over decided proposals only. */
    decision_p50_ms: z.number().int().nonnegative().nullable(),
    decision_p95_ms: z.number().int().nonnegative().nullable(),
    /** Sum of approved_total_paise on settlement rows opened in the window. */
    approved_value_paise: z.number().int().nonnegative(),
    /** Same, restricted to COMPLETED. */
    settled_value_paise: z.number().int().nonnegative(),
    injections_blocked: z.number().int().nonnegative(),
    degradations: z.number().int().nonnegative(),
  })
  .strict();
export type AnalyticsTotals = z.infer<typeof AnalyticsTotalsSchema>;

/** One time bucket: hourly for 24h, daily for 7d/30d. Empty buckets are present
 *  with zeroes so a chart never has to invent a gap. */
export const VolumeBucketSchema = z
  .object({
    bucket_start: IsoDateTime,
    approved: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
    declined: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();
export type VolumeBucket = z.infer<typeof VolumeBucketSchema>;

export const OutcomeShareSchema = z
  .object({
    outcome: OutcomeKindSchema,
    count: z.number().int().nonnegative(),
    share_pct: z.number(),
  })
  .strict();
export type OutcomeShare = z.infer<typeof OutcomeShareSchema>;

/** Per-rule verdict tally from gatekeeper_rule_result events. */
export const RuleFindingSchema = z
  .object({
    rule_id: z.string().min(1),
    evaluations: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    escalate: z.number().int().nonnegative(),
  })
  .strict();
export type RuleFinding = z.infer<typeof RuleFindingSchema>;

/** Per-stage wall-clock from stage_completed.duration_ms. */
export const StageLatencySchema = z
  .object({
    stage: z.string().min(1),
    runs: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
  })
  .strict();
export type StageLatency = z.infer<typeof StageLatencySchema>;

export const SettlementStateSchema = z
  .object({
    state: z.string().min(1),
    count: z.number().int().nonnegative(),
    value_paise: z.number().int().nonnegative(),
  })
  .strict();
export type SettlementStateCount = z.infer<typeof SettlementStateSchema>;

export const SettlementSummarySchema = z
  .object({
    opened: z.number().int().nonnegative(),
    paid: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** paid / opened; null when nothing was opened in the window. */
    paid_rate_pct: z.number().nullable(),
    states: z.array(SettlementStateSchema),
  })
  .strict();
export type SettlementSummary = z.infer<typeof SettlementSummarySchema>;

export const ApprovalsSummarySchema = z
  .object({
    pending: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    /** created_at → resolved_at median, over resolved rows in the window. */
    median_decision_ms: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ApprovalsSummary = z.infer<typeof ApprovalsSummarySchema>;

/** GET /v1/admin/analytics?window=… */
export const AnalyticsResponseSchema = z
  .object({
    window: AnalyticsWindowSchema,
    bucket: z.enum(["hour", "day"]),
    from: IsoDateTime,
    generated_at: IsoDateTime,
    rules_version: RulesVersion,
    totals: AnalyticsTotalsSchema,
    volume: z.array(VolumeBucketSchema),
    outcomes: z.array(OutcomeShareSchema),
    rule_findings: z.array(RuleFindingSchema),
    stage_latency: z.array(StageLatencySchema),
    settlement: SettlementSummarySchema,
    approvals: ApprovalsSummarySchema,
  })
  .strict();
export type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>;

/* ------------------------- §7.6 transaction list -------------------------
 * The operational index the trace screen was missing: without it a tx_id can
 * only be reached by having watched it happen.
 */

export const TxListRowSchema = z
  .object({
    tx_id: TxId,
    agent_id: z.string().min(1),
    stage: z.string().min(1),
    /** null while still in flight. */
    outcome: OutcomeKindSchema.nullable(),
    /** Mandate total for APPROVED, else the settlement row's approved total. */
    value_paise: z.number().int().nonnegative().nullable(),
    /** First blocking rule id for DECLINED, first escalating rule for ESCALATED. */
    reason: z.string().nullable(),
    rules_version: RulesVersion.nullable(),
    settlement_state: z.string().nullable(),
    created_at: IsoDateTime,
    finished_at: IsoDateTime.nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type TxListRow = z.infer<typeof TxListRowSchema>;

export const TxListResponseSchema = z
  .object({
    transactions: z.array(TxListRowSchema),
    /** Total matching the filter, before the limit. */
    total: z.number().int().nonnegative(),
  })
  .strict();
export type TxListResponse = z.infer<typeof TxListResponseSchema>;
