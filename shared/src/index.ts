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
