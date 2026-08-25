/**
 * Explainer-agent contracts (frontend-events.md ExplanationNarrative +
 * §4.4 item 6 narration constraint, api-contract.md TerminalOutcome).
 *
 * The narrative payload's `non_authoritative` field is `z.literal(true)` —
 * the TYPE forbids an authoritative-looking explanation, mirroring the FE
 * contract verbatim.
 *
 * DUAL-TRACK ZOD (§18 register): validation-only schemas v3 classic; the
 * LLM-facing NarrativeOutputZ on zod/v4 strictObject.
 */
import { z } from "zod";
import { z as z4 } from "zod/v4";

export const NarratorAudience = z.enum([
  "AUDIT_TRAIL",
  "DECLINE_EXPLAINER",
  "APPROVAL_ASSIST",
]);
export type NarratorAudience = z.infer<typeof NarratorAudience>;

/** The ONLY event types a narrative may ground on (frontend-events §4.4.6). */
export const GroundableEventType = z.enum([
  "gatekeeper_rule_result",
  "gatekeeper_decision",
  "citation_audit_result",
]);
export type GroundableEventType = z.infer<typeof GroundableEventType>;

/** One fact-skeleton entry handed to the narrator. Payload is open JSON —
 *  rendered into the prompt canonically (key-sorted) for byte stability. */
export const TimelineEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  type: GroundableEventType,
  payload: z.unknown(),
}).strict();
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

/**
 * SSE/audit payload (frontend-events.md). `degraded` exists for schema parity
 * with the FE contract; the committed degradation path ships NO narrative at
 * all when the explainer fails (gatekeeper.md: raw trace stands), so v1 code
 * never emits degraded=true.
 */
export const ExplanationNarrativeSchema = z.object({
  audience: NarratorAudience,
  title: z.string().min(1),
  body_md: z.string().min(1),
  non_authoritative: z.literal(true),
  grounded_on_events: z.array(z.number().int().nonnegative()),
  degraded: z.boolean(),
}).strict();
export type ExplanationNarrative = z.infer<typeof ExplanationNarrativeSchema>;

/* --------------------- LLM-facing output (zod/v4) ------------------------ */

/**
 * What the model controls: a title, prose, and WHICH seqs it grounded on.
 * Audience/non_authoritative/degraded are NOT the model's to choose — they
 * are pinned by the caller / the type system. Unknown keys are failures.
 */
export const NarrativeOutputZ = z4.strictObject({
  title: z4.string().min(1).max(120),
  body_md: z4.string().min(1).max(4000),
  grounded_on_events: z4.array(z4.number().int().min(0)).max(64),
});
export type NarrativeOutput = z4.output<typeof NarrativeOutputZ>;
