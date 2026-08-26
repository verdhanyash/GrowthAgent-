/**
 * Settlement-agent wire contracts — ported VERBATIM from
 * docs/design/settlement.md §3 (names, fields, refinements). THE contract for
 * the settle request path; consumed by api AND web.
 *
 * Normalization notes (repo policy — cross-doc register in ARCHITECTURE.md):
 *  - `Paise` REUSES the canonical primitive from schemas.ts rather than
 *    re-declaring it: two star-exported `Paise`s would silently drop the name
 *    from `export *` in index.ts (ESM ambiguity rules) and break importers.
 *  - `TxId` REUSES the SSE-taxonomy primitive from events.ts — the spec's
 *    `z.string().startsWith('tx_')` sketch and events.ts's pinned ULID regex
 *    describe the same identifier; the stricter existing definition wins.
 */
import { z } from "zod";
import { Paise } from "./schemas.js";
import { TxId } from "./events.js";

/** ULID (Crockford base32, no I/L/O/U) — the tx_ suffix alphabet. */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export type Ulid = z.infer<typeof Ulid>;

export const Currency = z.literal("INR");

export const SettlementLine = z
  .object({
    sku: z.string().min(1).max(64),
    qty: z.number().int().positive().max(99),
    /** RAW merchant list price minus approved line discount — already
     *  computed & gatekeeper-checked upstream. Settlement never re-prices. */
    unit_price_paise: Paise,
  })
  .strict();
export type SettlementLine = z.infer<typeof SettlementLine>;

/** What settlement accepts. Produced ONLY by the gatekeeper (AUTO) or the
 *  approvals inbox (HUMAN). Anything else fails the parse — settlement
 *  refuses non-approved carts loudly, never conditionally. */
export const SettleableProposal = z
  .object({
    tx_id: TxId,
    proposal_id: z.string().min(1), // negotiation output id (frozen)
    proposal_sha256: z.string().length(64), // digest of the frozen proposal bytes
    lines: z.array(SettlementLine).min(1).max(20),
    total_amount_paise: Paise,
    currency: Currency,
    gatekeeper: z
      .object({
        verdict: z.literal("APPROVE"),
        ruleset_version: z.number().int().positive(),
        trace_digest: z.string().length(64), // sha256 of the full rule-trace JSON
      })
      .strict(),
    approval_source: z.enum(["GATEKEEPER_AUTO", "HUMAN_ESCALATION"]),
    /** REQUIRED iff HUMAN_ESCALATION; single-use. */
    approval_token: z.string().min(32).optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.approval_source === "HUMAN_ESCALATION"
        ? p.approval_token !== undefined
        : true,
    { message: "approval_token required for escalated proposals" },
  );
export type SettleableProposal = z.infer<typeof SettleableProposal>;

/** Layer-1 inbound request (settlement.md §8.1): the idempotency key is
 *  REQUIRED — the gate wraps every POST /v1/tx/settle. */
export const SettleRequest = z
  .object({
    idempotency_key: z.string().uuid(),
    proposal: SettleableProposal,
  })
  .strict();
export type SettleRequest = z.infer<typeof SettleRequest>;

/**
 * Digest convention (§3 proposal_sha256): the digest binds EVERY frozen byte
 * EXCEPT itself — the field participates in the shape as "" so producers and
 * verifiers hash the identical view. Every digest site MUST hash
 * canonicalJson(digestView(p)); hashing the raw object would compare a digest
 * computed over different bytes and refuse every well-formed proposal.
 */
export function digestView(p: SettleableProposal): SettleableProposal {
  return { ...p, proposal_sha256: "" };
}

/** Transaction state machine vocabulary (settlement.md §6). Happy path:
 *  PROPOSAL_APPROVED → STOCK_RESERVED → ORDER_CREATING → RZP_ORDER_CREATED →
 *  AWAITING_PAYMENT → PAID → COMPLETED; negative paths terminal. */
export type TxState =
  | "PROPOSAL_APPROVED"
  | "STOCK_RESERVED"
  | "ORDER_CREATING"
  | "RZP_ORDER_CREATED"
  | "AWAITING_PAYMENT"
  | "PAID"
  | "COMPLETED"
  | "FAILED"
  | "EXPIRED"
  | "RELEASED"
  | "REJECTED_BY_MERCHANT"
  | "MANUAL_REFUND_REQUIRED";

export const TX_STATES = [
  "PROPOSAL_APPROVED",
  "STOCK_RESERVED",
  "ORDER_CREATING",
  "RZP_ORDER_CREATED",
  "AWAITING_PAYMENT",
  "PAID",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
  "RELEASED",
  "REJECTED_BY_MERCHANT",
  "MANUAL_REFUND_REQUIRED",
] as const satisfies readonly TxState[];
