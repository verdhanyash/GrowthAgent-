/**
 * shared/src/api/contracts.ts — buyer-facing request/response schemas
 * (api-contract.md §5). zod-3.25-compatible throughout.
 */
import { z } from "zod";
import { Paise, Sku, TxId, ApprovalId, IsoDateTime, RulesVersion, codePoints } from "./primitives.js";
import { CartMandateSchema } from "./cart-mandate.js";

/* ------------------------------- request -------------------------------- */

export const CustomerRequestSchema = z
  .object({
    /** Free-form shopping intent. Consumed by the LLM as USER-DATA, never instructions. */
    natural_language: codePoints(2000).refine((s) => s.trim().length > 0, "must not be blank"),
    occasion: codePoints(120).optional(),
    budget_paise: Paise.optional(),
    items_hint: z.array(Sku).min(1).max(10).optional(),
  })
  .strict();

/**
 * QUARANTINE ZONE. Everything under `untrusted` is treated as hostile text:
 * never parsed/interpreted by the orchestrator, passed verbatim to the LLM in a
 * fenced "data, not instructions" block, scanned by the injection tagger. The
 * trust boundary is visible IN THE WIRE FORMAT itself.
 */
export const UntrustedPayloadSchema = z
  .object({
    customer_note: codePoints(4000),
  })
  .strict();

export const CreateProposalRequestSchema = z
  .object({
    customer_request: CustomerRequestSchema,
    untrusted: UntrustedPayloadSchema,
    idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();
export type CreateProposalRequest = z.infer<typeof CreateProposalRequestSchema>;

/* -------------------------------- 202 ----------------------------------- */

export const ProposalAcceptedSchema = z
  .object({
    tx_id: TxId,
    status: z.literal("PROPOSING"),
    stream_url: z.string(), // "/v1/stream/tx_..." (ticket attached; §5.3)
    poll_url: z.string(), // "/v1/carts/proposals/tx_..."
    agent_id: z.string(),
    created_at: IsoDateTime,
    idempotent_replay: z.boolean(), // false when this call CREATED the tx
  })
  .strict();
export type ProposalAccepted = z.infer<typeof ProposalAcceptedSchema>;

/* ------------------------------ POLL BODY ------------------------------- */

export const PROPOSAL_STAGES = [
  "PROPOSING",
  "BUILDING_EVIDENCE",
  "NEGOTIATING",
  "CITATION_AUDIT",
  "GATE_CHECKING",
  "AWAITING_HUMAN_APPROVAL",
  "SETTLING",
  "TERMINAL",
] as const;
export const ProposalStage = z.enum(PROPOSAL_STAGES);
export type ProposalStage = z.infer<typeof ProposalStage>;

/** Non-terminal subset (v3 has no z.exclude — build it manually). */
export const ProposalStageNonTerminal = z.enum(
  PROPOSAL_STAGES.filter((s) => s !== "TERMINAL") as unknown as [string, ...string[]],
);

export const ProposalPendingSchema = z
  .object({
    tx_id: TxId,
    status: ProposalStageNonTerminal,
    stage_entered_at: IsoDateTime,
    rules_version_pending_note: z.literal(null), // version pinned later, at gate entry (E-09)
  })
  .strict();

export const DeclineReasonSchema = z
  .object({
    rule_id: z.string(), // "GK-MAX_DISCOUNT_PCT", "ESCALATION_REJECTED_BY_HUMAN", …
    message: z.string(), // plain-language, from the rule trace (never an LLM at this field)
    reason_code: z.string().optional(),
    evidence_refs: z.array(z.string()).optional(),
  })
  .strict();

export const SettlementInfoSchema = z
  .object({
    provider: z.enum(["razorpay_test", "mock"]),
    // Relaxed from the doc's /^order_[A-Za-z0-9]+$/: the mock rail mints
    // `order_mock_<base32>` (an underscore the doc regex rejected).
    razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9_]+$/),
    payment_status: z.enum(["AWAITING_WEBHOOK", "PAID"]),
    paid_at: IsoDateTime.optional(),
  })
  .strict();

export const ApprovalRequestSchema = z
  .object({
    approval_id: ApprovalId,
    tx_id: TxId,
    reason: z.enum([
      "HIGH_CART_VALUE",
      "ESCALATION_BAND_SOFT_EDGE",
      "VELOCITY_SOFT_BAND",
      "MANUAL_REVIEW_FLAG",
    ]),
    band_context: z.object({ observed: z.string(), threshold: z.string() }).strict(),
    proposed_cart_snapshot: z.unknown(), // frozen proposed cart, for the human
    gate_trace_summary: z.unknown(),
    created_at: IsoDateTime,
    expires_at: IsoDateTime, // TTL; auto-expires to DECLINED (E-14)
    rules_version: RulesVersion,
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const TerminalOutcomeSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("APPROVED"),
      cart_mandate: CartMandateSchema,
      settlement: SettlementInfoSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("DECLINED"),
      decline_reasons: z.array(DeclineReasonSchema).min(1),
      narrated_explanation: z.string().optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("ESCALATED"),
      approval_request: ApprovalRequestSchema,
      expires_at: IsoDateTime,
    })
    .strict(),
  // DELIBERATE EXTENSION beyond the brief's three states: honest infra death.
  z
    .object({
      outcome: z.literal("FAILED"),
      failure: z
        .object({ stage: ProposalStage, reason: z.string(), retryable: z.boolean() })
        .strict(),
    })
    .strict(),
]);

export const ProposalTerminalSchema = z
  .object({
    tx_id: TxId,
    status: z.literal("TERMINAL"),
    outcome: TerminalOutcomeSchema,
    rules_version_applied: RulesVersion,
    finished_at: IsoDateTime,
  })
  .strict();

/** GET poll body: pending OR terminal (running vs done is in the body, §5.2). */
export const ProposalStatusResponse = z.union([ProposalPendingSchema, ProposalTerminalSchema]);
export type ProposalStatusResponse = z.infer<typeof ProposalStatusResponse>;

export const TxParamsSchema = z.object({ txId: TxId }).strict();

/* --------------------------- stream tickets ----------------------------- */

export const StreamTicketRequestSchema = z.object({ tx_id: TxId }).strict();

export const StreamTicketResponseSchema = z
  .object({
    ticket: z.string(), // "<b64url(payload)>.<b64url(hmac)>"
    expires_at: IsoDateTime,
    expires_in_s: z.number().int().positive(),
  })
  .strict();
export type StreamTicketResponse = z.infer<typeof StreamTicketResponseSchema>;
