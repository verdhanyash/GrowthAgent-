/**
 * SettlementProvider contract — ported VERBATIM from docs/design/settlement.md
 * §4 (names, fields, error taxonomy). THE seam: narrow and dumb on purpose,
 * two methods, no query/refund/capture verbs. Whatever cannot be expressed
 * through these two methods is out of scope for settlement by design.
 *
 * Only this subsystem imports Razorpay-facing code (ARCHITECTURE.md §8 T10).
 */
import type { Paise, TxId } from "@growthagent/shared";

export type ProviderKind = "razorpay" | "mock";

export interface SettlementOrderRequest {
  readonly tx_id: TxId;
  /** Deterministic fn(tx_id): `ga_${ulid}` → 29 chars ≤ 40-char limit (V3).
   *  Globally unique. */
  readonly receipt: string;
  readonly amount_paise: Paise;
  readonly currency: "INR";
  /** ≤15 pairs, each value ≤256 chars (V4). Values are IDs/hashes only —
   *  never prices. */
  readonly notes: Readonly<Record<string, string>>;
}

export interface SettlementOrderHandle {
  readonly provider: ProviderKind;
  /** real: "order_" prefix (V5); mock: "order_mock_…" */
  readonly rzp_order_id: string;
  readonly receipt: string;
  readonly amount_paise: Paise;
  readonly currency: "INR";
  readonly provider_status: "created";
  readonly created_at_epoch_sec?: number;
}

/** Discriminated union produced ONLY after signature authentication succeeds.
 *  Parsing before authentication is the vulnerability class V7 exists to kill. */
export type ParsedWebhook =
  | {
      kind: "payment.captured";
      event_id: string;
      occurred_at_epoch_sec: number;
      payment: PaymentEntity;
    }
  // V11: carries BOTH entities
  | {
      kind: "order.paid";
      event_id: string;
      occurred_at_epoch_sec: number;
      payment: PaymentEntity;
      order: OrderEntity;
    }
  // carries the error block
  | {
      kind: "payment.failed";
      event_id: string;
      occurred_at_epoch_sec: number;
      payment: PaymentEntity;
    }
  | {
      kind: "ignored";
      event_id: string;
      event: string;
      /** Envelope created_at rides on EVERY variant — the §8.3 freshness
       *  gate runs before the dispatch switch can discriminate. */
      occurred_at_epoch_sec: number;
    }; // unknown event: ACK, ignore

export interface PaymentEntity {
  id: string; // "pay_…"
  amount: number; // paise
  currency: string;
  status: string; // "captured" | "failed" | "authorized"
  order_id: string; // "order_…"
  method: string | null;
  captured: boolean;
  fee: number | null;
  tax: number | null;
  error_code: string | null;
  error_description: string | null;
  created_at: number;
}

export interface OrderEntity {
  id: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: string;
  attempts: number;
}

/* ----------------------------- typed errors ---------------------------- */

export class SettlementError extends Error {}

/** Timeouts / 5xx / network failures → retryable (§12 matrix). */
export class ProviderUnavailableError extends SettlementError {}

/**
 * Chaos toggle carrier (§5 `CHAOS_FORCE_GATEWAY_ERROR`, ARCHITECTURE.md §13):
 * a SUBCLASS of the gateway-error type the MockProvider raises natively, so
 * chaos exercises the identical retry/idempotency/degradation code paths real
 * failures do while remaining distinguishable for the failure taxonomy
 * (classify.ts) exactly like the sibling modules' Chaos* classes.
 */
export class ChaosForcedGatewayError extends ProviderUnavailableError {}

/** Non-duplicate, unrecoverable provider rejection (other 4xx). */
export class ProviderRejectedError extends SettlementError {
  constructor(
    public readonly providerCode: string,
    public readonly providerDescription: string,
    public readonly httpStatus: number,
  ) {
    super(`${providerCode}: ${providerDescription}`);
    this.name = "ProviderRejectedError";
  }
}

/** 400 with a receipt complaint — receipt acts as an idempotency key (V3);
 *  exact machine code unverified (U2), classification stays heuristic. */
export class DuplicateReceiptError extends ProviderRejectedError {
  constructor(description: string) {
    super("DUPLICATE_RECEIPT", description, 400);
    this.name = "DuplicateReceiptError";
  }
}

/** Bad/missing signature. SECURITY event — never retried, never parsed past. */
export class WebhookAuthenticationError extends SettlementError {}

/** Signature-valid but structurally wrong payload (JSON/schema mismatch) —
 *  the PARSE_FAILED carrier of this module's taxonomy. */
export class ProviderParseError extends SettlementError {}

/* --------------------------- THE provider seam -------------------------- */

/**
 * THE seam. Narrow and dumb on purpose: two methods, no query/refund/capture
 * verbs. Whatever cannot be expressed through these two methods is out of
 * scope for settlement by design. Only settlement talks to Razorpay — no
 * other module imports anything from this directory (ARCHITECTURE.md §8 T10).
 */
export interface SettlementProvider {
  readonly kind: ProviderKind;
  createOrder(req: SettlementOrderRequest): Promise<SettlementOrderHandle>;
  /**
   * Synchronous. Pure. Throws WebhookAuthenticationError on missing/invalid
   * signature. MUST receive the raw, unparsed body bytes (V7); parsing
   * happens only after authentication.
   */
  verifyAndParseWebhook(
    rawBody: Buffer,
    signatureHeader: string | null,
    eventIdHeader: string | null,
  ): ParsedWebhook;
}

/* ------------------------- shared request shaping ----------------------- */

const NOTES_MAX_PAIRS = 15; // V4
const NOTES_MAX_VALUE_CHARS = 256; // V4

/**
 * Both providers build their createOrder body through THIS function (§5:
 * "identical object built by same code path"). Enforces the notes budget
 * deterministically — overflow pairs are dropped / long values truncated and
 * reported so the caller audits `notes.truncated` (§14 edge case 23); budget
 * violations never fail settlement.
 */
export function buildCreateOrderBody(req: SettlementOrderRequest): {
  amount: number;
  currency: "INR";
  receipt: string;
  notes: Record<string, string>;
} & { truncated: boolean } {
  const keys = Object.keys(req.notes).sort(); // deterministic drop order
  const notes: Record<string, string> = {};
  let truncated = false;
  for (const key of keys) {
    if (Object.keys(notes).length >= NOTES_MAX_PAIRS) {
      truncated = true; // dropped silently beyond the audit flag below
      break;
    }
    const value = req.notes[key];
    if (value === undefined) continue;
    if (value.length > NOTES_MAX_VALUE_CHARS) {
      notes[key] = value.slice(0, NOTES_MAX_VALUE_CHARS);
      truncated = true;
      continue;
    }
    notes[key] = value;
  }
  return { amount: req.amount_paise, currency: req.currency, receipt: req.receipt, notes, truncated };
}
