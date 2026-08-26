/**
 * §15.1 — signature & webhook parsing units (sign.test.ts /
 * razorpay.provider.test.ts matrix). Pure: no DB, no Redis.
 */
import { describe, expect, it } from "vitest";
import { hmacSha256Hex, secureCompareHex, sha256Hex } from "./sign.js";
import {
  buildOrderPaidEnvelope,
  buildPaymentCapturedEnvelope,
  buildPaymentFailedEnvelope,
  serializeEnvelope,
  signEnvelope,
} from "./webhook.builder.js";
import {
  parseAuthenticatedWebhook,
  parseValidatedEnvelope,
} from "./payload.schema.js";
import {
  ProviderParseError,
  WebhookAuthenticationError,
} from "./types.js";

const SECRET = "unit-test-webhook-secret";
const SECRET_ROTATED = "unit-test-webhook-secret-v2";

function signedBody(envelope: Record<string, unknown>, secret = SECRET): Buffer {
  const raw = serializeEnvelope(envelope);
  // sanity: the builder's own signer must agree with the primitive
  expect(signEnvelope(secret, raw)).toBe(hmacSha256Hex(secret, raw));
  return raw;
}

function capturedEnvelope(createdAtSec: number, amountPaise = 29_900): Record<string, unknown> {
  return buildPaymentCapturedEnvelope({
    paymentId: "pay_Q5yVbNh3yebMGo",
    rzpOrderId: "order_Q5yVbNh3yebMGo",
    amountPaise,
    createdAtEpochSec: createdAtSec,
  });
}

describe("secureCompareHex", () => {
  it("accepts an exact match", () => {
    const mac = hmacSha256Hex(SECRET, Buffer.from("x"));
    expect(secureCompareHex(mac, mac)).toBe(true);
  });

  it("rejects uppercase/garbage/empty headers without throwing", () => {
    const mac = hmacSha256Hex(SECRET, Buffer.from("x"));
    expect(secureCompareHex(mac.toUpperCase(), mac)).toBe(true); // trim+lowercase discipline
    expect(secureCompareHex("DEADBEEF", mac)).toBe(false);
    expect(secureCompareHex("", mac)).toBe(false);
    expect(secureCompareHex(null, mac)).toBe(false);
    expect(secureCompareHex(undefined, mac)).toBe(false);
  });

  it("burns a comparison on length mismatch — no length oracle", () => {
    const mac = hmacSha256Hex(SECRET, Buffer.from("x"));
    expect(() => secureCompareHex("ab", mac)).not.toThrow();
    expect(secureCompareHex("ab", mac)).toBe(false);
  });
});

describe("parseAuthenticatedWebhook", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  it("parses a validly-signed payment.captured envelope into the union", () => {
    const raw = signedBody(capturedEnvelope(nowSec));
    const parsed = parseAuthenticatedWebhook(raw, [SECRET], hmacSha256Hex(SECRET, raw), "evt_1");
    expect(parsed.kind).toBe("payment.captured");
    if (parsed.kind === "payment.captured") {
      expect(parsed.event_id).toBe("evt_1");
      expect(parsed.payment.amount).toBe(29_900);
      expect(parsed.payment.captured).toBe(true);
      expect(parsed.payment.order_id).toBe("order_Q5yVbNh3yebMGo");
    }
  });

  it("falls back to sha256(rawBody) as event id when header absent (U4 advisory)", () => {
    const raw = signedBody(capturedEnvelope(nowSec));
    const parsed = parseAuthenticatedWebhook(raw, [SECRET], hmacSha256Hex(SECRET, raw), null);
    expect(parsed.event_id).toBe(sha256Hex(raw));
  });

  it("rejects a 1-byte body mutation deep in the JSON", () => {
    const raw = signedBody(capturedEnvelope(nowSec));
    const tampered = Buffer.from(raw.toString("utf8").replace("captured", "capturedX"));
    expect(() =>
      parseAuthenticatedWebhook(tampered, [SECRET], hmacSha256Hex(SECRET, raw), null),
    ).toThrow(WebhookAuthenticationError);
  });

  it("rejects missing signature header", () => {
    const raw = signedBody(capturedEnvelope(nowSec));
    expect(() => parseAuthenticatedWebhook(raw, [SECRET], null, null)).toThrow(
      WebhookAuthenticationError,
    );
  });

  it("rejects a short forged signature via the length-burn path", () => {
    const raw = signedBody(capturedEnvelope(nowSec));
    expect(() => parseAuthenticatedWebhook(raw, [SECRET], "ab", null)).toThrow(
      WebhookAuthenticationError,
    );
  });

  it("rotation: old-secret payload fails against new secret, passes with OLD_WEBHOOK_SECRET present (V7)", () => {
    const raw = signedBody(capturedEnvelope(nowSec), SECRET); // signed pre-rotation
    expect(() => parseAuthenticatedWebhook(raw, [SECRET_ROTATED], hmacSha256Hex(SECRET, raw), null)).toThrow(
      WebhookAuthenticationError,
    );
    const parsed = parseAuthenticatedWebhook(
      raw,
      [SECRET_ROTATED, SECRET],
      hmacSha256Hex(SECRET, raw),
      null,
    );
    expect(parsed.kind).toBe("payment.captured");
  });

  it("throws PARSE_FAILED (not auth failure) for signed-but-structurally-wrong bytes", () => {
    const raw = serializeEnvelope({ entity: "event", event: 42 }); // already-serialized garbage
    expect(() => parseAuthenticatedWebhook(raw, [SECRET], hmacSha256Hex(SECRET, raw), null)).toThrow(
      ProviderParseError,
    );
  });

  it("order.paid carries BOTH entities (V11)", () => {
    const env = buildOrderPaidEnvelope({
      paymentId: "pay_dual",
      rzpOrderId: "order_dual",
      amountPaise: 15_000,
      createdAtEpochSec: nowSec,
      receipt: "ga_TESTDUAL000000000000000000",
      orderAmountPaidPaise: 15_000,
      orderAmountDuePaise: 0,
      orderAttempts: 1,
    });
    const raw = signedBody(env);
    const parsed = parseAuthenticatedWebhook(raw, [SECRET], hmacSha256Hex(SECRET, raw), null);
    expect(parsed.kind).toBe("order.paid");
    if (parsed.kind === "order.paid") {
      expect(parsed.payment.status).toBe("captured");
      expect(parsed.order.receipt).toBe("ga_TESTDUAL000000000000000000");
      expect(parsed.order.status).toBe("paid");
      expect(parsed.order.amount_paid).toBe(15_000);
    }
  });

  it("payment.failed carries the error block (V10 failed shape)", () => {
    const env = buildPaymentFailedEnvelope({
      paymentId: "pay_fail",
      rzpOrderId: "order_fail",
      amountPaise: 12_300,
      createdAtEpochSec: nowSec,
      errorCode: "GATEWAY_ERROR",
      errorDescription: "Payment failed in gateway",
    });
    const raw = signedBody(env);
    const parsed = parseAuthenticatedWebhook(raw, [SECRET], hmacSha256Hex(SECRET, raw), null);
    expect(parsed.kind).toBe("payment.failed");
    if (parsed.kind === "payment.failed") {
      expect(parsed.payment.error_code).toBe("GATEWAY_ERROR");
      expect(parsed.payment.captured).toBe(false);
    }
  });

  it("unknown event types parse as ignored (ACK + ignore, §14.8)", () => {
    const env = { ...capturedEnvelope(nowSec), event: "refund.processed" };
    const raw = signedBody(env);
    const parsed = parseAuthenticatedWebhook(raw, [SECRET], hmacSha256Hex(SECRET, raw), "evt_x");
    expect(parsed).toMatchObject({ kind: "ignored", event: "refund.processed", event_id: "evt_x" });
    if (parsed.kind === "ignored") expect(parsed.occurred_at_epoch_sec).toBe(nowSec);
  });

  it("envelope conformance: builder output matches V10/V11 documented field set exactly", () => {
    // Pinned field-for-field so a docs drift breaks CI, not the demo (§5).
    const env = capturedEnvelope(1_700_000_100);
    expect(Object.keys(env)).toEqual([
      "entity",
      "account_id",
      "event",
      "contains",
      "payload",
      "created_at",
    ]);
    const pay = (env.payload as { payment: { entity: Record<string, unknown> } }).payment.entity;
    expect(Object.keys(pay)).toEqual([
      "id",
      "amount",
      "currency",
      "status",
      "captured",
      "order_id",
      "method",
      "fee",
      "tax",
      "error_code",
      "error_description",
      "created_at",
    ]);
    expect(env.contains).toEqual(["payment"]);
  });
});

describe("parseValidatedEnvelope (W6 redrive path)", () => {
  it("re-parses a stored authenticated envelope without re-signing", () => {
    const env = capturedEnvelope(Math.floor(Date.now() / 1000));
    const parsed = parseValidatedEnvelope(env, "evt_redrive");
    expect(parsed.kind).toBe("payment.captured");
    expect(parsed.event_id).toBe("evt_redrive");
  });

  it("refuses malformed stored payloads loudly", () => {
    expect(() => parseValidatedEnvelope({ broken: true }, "evt_bad")).toThrow(ProviderParseError);
  });
});
