/**
 * Canonical webhook payload builder (settlement.md §5): the single serializer
 * for payment/order envelopes, shared by MockProvider and test fixtures.
 * Unit tests assert the builder's output matches the documented sample shapes
 * field-for-field (V10/V11), so a docs drift breaks CI rather than the demo.
 *
 * Key order is the documented listing order — serialization must be stable,
 * because these exact bytes are what get signed (V7).
 */
import { hmacSha256Hex } from "./sign.js";

export interface PaymentEventInput {
  readonly paymentId: string; // "pay_…"
  readonly rzpOrderId: string; // "order_…"
  readonly amountPaise: number;
  readonly createdAtEpochSec: number;
  /** Docs warn not to hardcode VPA/UPI handles (V12) — mock uses a neutral label. */
  readonly method?: string;
}

export interface FailedPaymentEventInput extends PaymentEventInput {
  readonly errorCode: string;
  readonly errorDescription: string;
}

export interface OrderPaidEventInput extends PaymentEventInput {
  readonly receipt: string;
  readonly orderAmountPaidPaise: number;
  readonly orderAmountDuePaise: number;
  readonly orderAttempts: number;
}

/** V10 envelope: { entity:"event", account_id, event, contains:[…], payload, created_at }. */
export function buildPaymentCapturedEnvelope(
  i: PaymentEventInput,
  accountId = "account_mock",
): Record<string, unknown> {
  return {
    entity: "event",
    account_id: accountId,
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: i.paymentId,
          amount: i.amountPaise,
          currency: "INR",
          status: "captured",
          captured: true,
          order_id: i.rzpOrderId,
          method: i.method ?? "upi", // never a hardcoded VPA (V12)
          fee: 0,
          tax: 0,
          error_code: null,
          error_description: null,
          created_at: i.createdAtEpochSec,
        },
      },
    },
    created_at: i.createdAtEpochSec,
  };
}

export function buildPaymentFailedEnvelope(
  i: FailedPaymentEventInput,
  accountId = "account_mock",
): Record<string, unknown> {
  return {
    entity: "event",
    account_id: accountId,
    event: "payment.failed",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: i.paymentId,
          amount: i.amountPaise,
          currency: "INR",
          status: "failed",
          captured: false,
          order_id: i.rzpOrderId,
          method: i.method ?? "upi",
          fee: 0,
          tax: 0,
          error_code: i.errorCode,
          error_description: i.errorDescription,
          created_at: i.createdAtEpochSec,
        },
      },
    },
    created_at: i.createdAtEpochSec,
  };
}

/** V11: contains BOTH payment and order entities — `order.paid` fires
 *  together with `payment.captured` on capture. */
export function buildOrderPaidEnvelope(
  i: OrderPaidEventInput,
  accountId = "account_mock",
): Record<string, unknown> {
  const captured = buildPaymentCapturedEnvelope(i, accountId);
  const capturedPayload = captured.payload as Record<string, unknown>; // same builder, known shape
  return {
    ...captured,
    event: "order.paid",
    contains: ["payment", "order"],
    payload: {
      ...capturedPayload,
      order: {
        entity: {
          id: i.rzpOrderId,
          amount: i.amountPaise,
          amount_paid: i.orderAmountPaidPaise,
          amount_due: i.orderAmountDuePaise,
          currency: "INR",
          receipt: i.receipt,
          status: "paid",
          attempts: i.orderAttempts,
        },
      },
    },
  };
}

/** Serialize to the EXACT bytes that will be signed. Deterministic key order. */
export function serializeEnvelope(envelope: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

/** HMAC-SHA256(webhook secret, RAW serialized bytes) → hex (V7). */
export function signEnvelope(secret: string, rawBody: Buffer): string {
  return hmacSha256Hex(secret, rawBody);
}

/** A loopback-ready signed webhook letter: raw bytes + the two headers the
 *  real Razorpay request carries. */
export interface SignedWebhookPost {
  readonly url: string;
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<"X-Razorpay-Signature" | "x-razorpay-event-id", string>>;
}

export function buildSignedWebhook(
  secret: string,
  envelope: Record<string, unknown>,
  eventId: string,
): SignedWebhookPost {
  const rawBody = serializeEnvelope(envelope);
  return {
    url: "/webhooks/razorpay",
    rawBody,
    headers: {
      "X-Razorpay-Signature": signEnvelope(secret, rawBody),
      "x-razorpay-event-id": eventId,
    },
  };
}
