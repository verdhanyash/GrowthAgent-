/**
 * payload.schema.spec.ts — audit S6: `EventEnvelopeZ` was `.strict()`.
 *
 * The module header promises "unknown extra fields are stripped silently so docs
 * drift that only ADDS fields stays green", but `.strict()` does the opposite:
 * it REJECTS them. Razorpay owns that envelope, so the first top-level key they
 * add turns every authenticated webhook into a ProviderParseError — captures
 * strand in AWAITING_PAYMENT, expire, and land in MANUAL_REFUND_REQUIRED. A P0
 * outage triggered by someone else's release note.
 *
 * These tests pin BOTH halves: additive drift passes, drift in the pinned fields
 * still fails closed.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseAuthenticatedWebhook,
  parseValidatedEnvelope,
} from "./payload.schema.js";
import { ProviderParseError, WebhookAuthenticationError } from "./types.js";
import { buildPaymentCapturedEnvelope, buildOrderPaidEnvelope } from "./webhook.builder.js";

const SECRET = "whsec_test_secret";
const NOW_SEC = 1_772_100_000;

function captured(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...buildPaymentCapturedEnvelope({
      paymentId: "pay_TESTCAPTURE01",
      rzpOrderId: "order_TESTORDER01",
      amountPaise: 69_097,
      createdAtEpochSec: NOW_SEC,
    }),
    ...extra,
  };
}

function sign(body: Buffer): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

describe("EventEnvelopeZ — forward compatibility (audit S6)", () => {
  it("ACCEPTS an envelope carrying a top-level key we have never seen", () => {
    const parsed = parseValidatedEnvelope(
      captured({ webhook_version: "2027-01-01", some_new_flag: true, nested_new: { a: 1 } }),
      "evt_new_fields",
    );
    expect(parsed.kind).toBe("payment.captured");
    if (parsed.kind === "payment.captured") {
      expect(parsed.payment.amount).toBe(69_097);
      expect(parsed.occurred_at_epoch_sec).toBe(NOW_SEC);
    }
  });

  it("STRIPS the unknown keys rather than smuggling them onward", () => {
    const parsed = parseValidatedEnvelope(captured({ surprise: "x" }), "evt_strip");
    expect(Object.keys(parsed)).not.toContain("surprise");
  });

  it("tolerates additions inside the payment entity too", () => {
    const env = captured();
    const payment = (env.payload as { payment: { entity: Record<string, unknown> } }).payment;
    payment.entity.acquirer_data = { rrn: "12345" };
    payment.entity.new_gateway_field = 7;
    const parsed = parseValidatedEnvelope(env, "evt_entity_fields");
    expect(parsed.kind).toBe("payment.captured");
  });

  it("survives the additive drift end-to-end, through the HMAC path", () => {
    const raw = Buffer.from(JSON.stringify(captured({ future_key: [1, 2, 3] })), "utf8");
    const parsed = parseAuthenticatedWebhook(raw, [SECRET], sign(raw), "evt_e2e");
    expect(parsed.kind).toBe("payment.captured");
    expect(parsed.event_id).toBe("evt_e2e");
  });

  it("still REFUSES drift in a PINNED field (fails closed, not open)", () => {
    // entity must be the literal "event".
    expect(() => parseValidatedEnvelope(captured({ entity: "not-an-event" }), "e")).toThrow(ProviderParseError);
    // created_at is the freshness anchor: no anchor, no replay protection.
    const noAnchor = captured();
    delete noAnchor.created_at;
    expect(() => parseValidatedEnvelope(noAnchor, "e")).toThrow(ProviderParseError);
    // A capture whose payment entity is missing its amount is not parseable.
    const broken = captured();
    delete (broken.payload as { payment: { entity: Record<string, unknown> } }).payment.entity.amount;
    expect(() => parseValidatedEnvelope(broken, "e")).toThrow(ProviderParseError);
  });

  it("payment.captured without a payment entity is still a parse error", () => {
    const env = captured();
    env.payload = {};
    expect(() => parseValidatedEnvelope(env, "e")).toThrow(ProviderParseError);
  });

  it("order.paid still requires BOTH entities (V11)", () => {
    const env = buildOrderPaidEnvelope({
      paymentId: "pay_TESTCAPTURE01",
      rzpOrderId: "order_TESTORDER01",
      amountPaise: 69_097,
      createdAtEpochSec: NOW_SEC,
      receipt: "ga_TESTRECEIPT",
      orderAmountPaidPaise: 69_097,
      orderAmountDuePaise: 0,
      orderAttempts: 1,
    }) as Record<string, unknown>;
    expect(parseValidatedEnvelope({ ...env, brand_new: 1 }, "e").kind).toBe("order.paid");
    delete (env.payload as Record<string, unknown>).order;
    expect(() => parseValidatedEnvelope(env, "e")).toThrow(ProviderParseError);
  });

  it("an unknown EVENT name is acknowledged and ignored, anchor intact", () => {
    const parsed = parseValidatedEnvelope(captured({ event: "refund.created" }), "evt_ignored");
    expect(parsed.kind).toBe("ignored");
    expect(parsed.occurred_at_epoch_sec).toBe(NOW_SEC);
  });

  it("authentication still precedes parsing (a bad signature never reaches zod)", () => {
    const raw = Buffer.from(JSON.stringify({ total: "garbage" }), "utf8");
    expect(() => parseAuthenticatedWebhook(raw, [SECRET], "deadbeef", null)).toThrow(WebhookAuthenticationError);
    expect(() => parseAuthenticatedWebhook(raw, [SECRET], null, null)).toThrow(WebhookAuthenticationError);
  });
});
