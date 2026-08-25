/**
 * Campaign domain schemas (campaign.md §6.2) + the LLM-facing rationales
 * output schema (§7.1).
 *
 * DUAL-TRACK ZOD (ARCHITECTURE.md §18, M2): validation-only schemas stay on
 * zod v3 classic; anything handed to `zodOutputFormat` MUST be zod/v4 — the
 * Anthropic SDK helper imports zod/v4 and serializes via its `toJSONSchema`,
 * which rejects v3-classic schema objects at runtime. Here that is exactly
 * one schema: RationalesOutputZ.
 */
import { z } from "zod";
import { z as z4 } from "zod/v4";

/* ----------------------------- opportunities ---------------------------- */

export const OpportunityType = z.enum([
  "UNDERSELLING",
  "EXPIRY_RISK",
  "ATTACH_BUNDLE",
  "TIMING",
]);
export type OpportunityType = z.infer<typeof OpportunityType>;

export const MetricSchema = z.object({
  key: z.string(), // stable identifier, e.g. "velocity_ratio"
  label: z.string(), // human label, e.g. "Velocity vs category-peer median"
  // NORMALIZATION (§18 register): widened from the doc's bare number to admit
  // string-typed CONTEXT metrics (dow_label -> "Sundays", occ_label ->
  // "birthday") that templates quote verbatim. Numeric metrics keep numeric
  // values; nothing money-bearing ever lands in a string metric.
  value: z.union([z.number(), z.string()]), // raw value at full precision
  display: z.string(), // canonical formatted string — THE auditable token
}).strict();
export type Metric = z.infer<typeof MetricSchema>;

export const OpportunitySchema = z.object({
  opportunity_id: z.string().regex(/^opp_[a-z_]+_[0-9a-f]{10}$/),
  type: OpportunityType,
  skus: z.array(z.string()).min(1).max(2),
  metrics: z.array(MetricSchema).min(2),
  weight: z.number().min(0).max(1),
  analytics_run_id: z.string(),
  generated_at_sim: z.string(), // ISO timestamp = as_of
}).strict();
export type Opportunity = z.infer<typeof OpportunitySchema>;

/* ----------------------------- priority entries ------------------------- */

export const PriorityAction = z.enum([
  "PRIORITIZE_IN_BUNDLES",
  "CLEAR_NEAR_EXPIRY",
  "PROMOTE_PAIR",
]);
export type PriorityAction = z.infer<typeof PriorityAction>;

export const PriorityEntrySchema = z.object({
  entry_id: z.string().regex(/^pe_[0-9a-f]{10}$/),
  opportunity_id: z.string(), // traceability back to analytics
  action: PriorityAction,
  skus: z.array(z.string()).min(1).max(2),
  weight: z.number().min(0).max(1),
  rationale_nl: z.string().min(20),
  rationale_provenance: z.enum(["VERIFIED_LLM", "TEMPLATE_FALLBACK"]),
}).strict();
export type PriorityEntry = z.infer<typeof PriorityEntrySchema>;

export const PrioritySetStatus = z.enum([
  "FRESH",
  "EMPTY",
  "TEMPLATE_ONLY",
  "PARTIAL_TEMPLATE",
]);
export type PrioritySetStatus = z.infer<typeof PrioritySetStatus>;

export const LlmInvocationSchema = z.object({
  model: z.string(),
  request_hash: z.string(), // sha256 of canonical request body
  latency_ms: z.number().int().nonnegative(),
  entries_verified: z.number().int().nonnegative(),
  entries_template_fallback: z.number().int().nonnegative(),
  from_cache: z.boolean(), // DEMO_STABLE_MODE replay hit
}).strict();
export type LlmInvocation = z.infer<typeof LlmInvocationSchema>;

export const PrioritySetSchema = z.object({
  set_id: z.string().regex(/^ps_v\d+_[0-9a-f]{8}$/),
  priority_set_version: z.number().int().nonnegative(),
  // §6.2 keeps this nullable for forward-compat even though a run always
  // exists today ("null for EMPTY published without a run? never").
  analytics_run_id: z.string().nullable(),
  status: PrioritySetStatus,
  entries: z.array(PriorityEntrySchema),
  generated_at_sim: z.string(),
  ttl_seconds: z.number().int().positive(),
  valid_until_sim: z.string(), // generated_at_sim + ttl
  llm_invocation: LlmInvocationSchema.nullable(),
}).strict();
export type PrioritySet = z.infer<typeof PrioritySetSchema>;

/* -------------------- LLM-facing output (zod/v4 ONLY) ------------------- */

/**
 * The model's ENTIRE semantic surface (campaign.md §7.1): one rationale per
 * ENTRY INDEX and nothing else. There is deliberately no field here the model
 * could use to mutate actions/SKUs/weights — deterministic code attaches each
 * returned string to `entries[entry_index]`; missing/out-of-range indices fall
 * back to templates.
 *
 * z4.strictObject: unknown keys are a parse failure, not silently dropped.
 */
export const RationaleItemZ = z4.strictObject({
  entry_index: z4.number().int().min(0),
  rationale_nl: z4.string().min(40).max(600),
});
export type RationaleItem = z4.output<typeof RationaleItemZ>;

export const RationalesOutputZ = z4.strictObject({
  rationales: z4.array(RationaleItemZ),
});
export type RationalesOutput = z4.output<typeof RationalesOutputZ>;
