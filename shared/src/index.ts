/**
 * @growthagent/shared — single source of truth for zod schemas, integer-paise
 * money math, canonical JSON, and SSE event types. Consumed by api and web;
 * NOTHING in here may import from api or web.
 */
export const SHARED_PACKAGE_VERSION = "0.1.0" as const;

/* integer-paise money primitives (gatekeeper.md §8) */
export {
  assertSafeInt,
  toBps,
  mulDivRoundHalfUp,
  allocateProportionally,
  crossMarginHolds,
  formatPaise,
  formatPct,
} from "./money.js";

/* canonical JSON (digest input everywhere) */
export { canonicalJson, type JsonValue } from "./canonical.js";

/* gatekeeper + evidence data contracts (verbatim ports) */
export * from "./schemas.js";

/* deterministic numeric-fact deriver (negotiation.md §4.3) */
export {
  deriveNumericFacts,
  FACT_UNITS,
  type FactUnit,
  type NumericFact,
} from "./evidence/facts.js";

/* deterministic evidence-ID allocation + pack hashing (negotiation.md §1.4) */
export {
  allocateIds,
  KIND_ORDER,
  packHash,
  PackInvariantViolationError,
  type EvidencePackEntryInput,
} from "./evidence/ids.js";

/* negotiation stage contracts (negotiation.md §3.3/§4) */
export {
  NegotiationProposalZ,
  ProposedItemZ,
  ClaimZ,
  ClaimKindZ,
  EvidenceIdZ,
  type NegotiationProposal,
  type ProposedItem,
  type Claim,
  type ClaimKind,
} from "./negotiation/proposal.schema.js";
export {
  auditCitations,
  DEFAULT_TOLERANCES,
  extractNumbers,
  isDiscountContext,
  type AuditOptions,
  type CitationAuditResult,
  type CitationVerdict,
  type CitationViolation,
  type Tolerances,
  type ViolationCode,
  type NumberToken,
} from "./negotiation/audit.js";
export type {
  BuyerRequestItem,
  BuyerRequestView,
  NoteHeuristicTags,
  NegotiationStageInput,
  ProvenanceEnvelope,
  ProvenancedProposal,
} from "./negotiation/context.types.js";

/* campaign-orchestrator contracts (campaign.md §4/§6/§7.1/§12.4) */
export { CAMPAIGN_CONFIG } from "./campaign/config.js";
export {
  LlmInvocationSchema,
  MetricSchema,
  OpportunitySchema,
  OpportunityType,
  PriorityAction,
  PriorityEntrySchema,
  PrioritySetSchema,
  PrioritySetStatus,
  RationaleItemZ,
  RationalesOutputZ,
  type LlmInvocation,
  type Metric,
  type Opportunity,
  type PriorityEntry,
  type PrioritySet,
  type RationaleItem,
  type RationalesOutput,
} from "./campaign/schema.js";
export type {
  CampaignAuditEvent,
  RationaleFallbackVerdict,
  SuppressionReason,
} from "./campaign/audit-events.js";

/* catalog-intelligence contracts (data-model-audit.md §2.5, negotiation §1.7) */
export { CATALOG_CONFIG } from "./catalog/config.js";
export {
  EnrichedSkuSchema,
  EnrichmentStatus,
  EnrichmentOutputZ,
  type EnrichedSku,
  type EnrichmentOutput,
} from "./catalog/schema.js";
export {
  normalizeEnrichment,
  type SanitizedEnrichment,
  type RejectedEnrichment,
  type EnrichmentWarning,
} from "./catalog/normalize.js";

/* explainer-agent contracts (frontend-events.md §4.4.6 narration constraint) */
export {
  ExplanationNarrativeSchema,
  GroundableEventType,
  NarrativeOutputZ,
  NarratorAudience,
  TimelineEventSchema,
  type ExplanationNarrative,
  type NarrativeOutput,
  type TimelineEvent,
} from "./explainer/schema.js";
export {
  BUYER_CLAIM_PREFIX,
  MIN_UNTRUSTED_LEN,
  verifyNarration,
  type NarrationRejection,
  type NarrationVerifyResult,
  type VerifyContext,
} from "./explainer/verify.js";

/* SSE audit-event envelope + taxonomy (frontend-events.md §1) */
export {
  TxId,
  AgentKind,
  AgentIdentitySchema,
  StageName,
  EVENT_NAMES,
  EPHEMERAL_EVENTS,
  isEphemeralEvent,
  EVENT_SCHEMAS,
  parseFrame,
  type EventName,
  type EphemeralEventName,
  type EventPayloadMap,
  type AnyEnvelope,
  type AuditEnvelope,
} from "./events.js";
