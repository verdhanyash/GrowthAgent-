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
