/**
 * MockProvider — faithful local double (settlement.md §5). It is NOT a
 * security bypass: it signs byte-for-byte V10/V11 envelopes with
 * RAZORPAY_WEBHOOK_SECRET through the shared webhook.builder, and the signed
 * letter is verified by the SAME parseAuthenticatedWebhook HMAC path the real
 * Razorpay request hits (dogfooding our own security code).
 *
 * Determinism: rzp_order_id = 'order_mock_' + base32(sha256(receipt))[..10];
 * ~20 ms simulated latency rides the injected Clock; chaos toggles throw the
 * SAME typed gateway error a natural failure raises (ARCHITECTURE.md §13).
 */
import { createHash } from "node:crypto";
import type { Clock } from "../clock.js";
import {
  buildCreateOrderBody,
  ChaosForcedGatewayError,
  type ParsedWebhook,
  type ProviderKind,
  type SettlementOrderHandle,
  type SettlementOrderRequest,
  type SettlementProvider,
} from "./types.js";
import {
  buildOrderPaidEnvelope,
  buildPaymentCapturedEnvelope,
  buildPaymentFailedEnvelope,
  buildSignedWebhook,
  type SignedWebhookPost,
} from "./webhook.builder.js";
import { parseAuthenticatedWebhook } from "./payload.schema.js";

export const MOCK_CREATE_LATENCY_MS = 20; // §5: ~20 ms simulated latency

/** RFC4648 base32, uppercase — deterministic id derivation from a receipt. */
function base32Upper(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The payment outcome a demo driver schedules for one tx (§5). */
export type MockPaymentOutcome = "captured" | "failed" | "delay" | "duplicate" | "never";

export type WebhookDelivery = SignedWebhookPost;

/** Sink for signed letters: tests collect into an outbox and drive them
 *  through processWebhook; M6 wires this to a real loopback HTTP POST. */
export type WebhookDeliverer = (delivery: WebhookDelivery) => void;

interface MockOrder {
  readonly txId: string;
  readonly rzpOrderId: string;
  readonly receipt: string;
  readonly amountPaise: number;
}

export interface MockProviderOptions {
  readonly webhookSecret: string;
  readonly clock: Clock;
  readonly deliver?: WebhookDeliverer;
  readonly accountId?: string;
  /** Env-seeded default; the instance's `chaos` object stays mutable so the
   *  demo driver can arm/disarm at runtime (ARM_FOR_NEXT_TX lands M6). */
  readonly chaosForceGatewayError?: boolean;
}

export class MockProvider implements SettlementProvider {
  readonly kind: ProviderKind = "mock";

  /** Runtime-armed chaos toggle (CHAOS_FORCE_GATEWAY_ERROR). */
  readonly chaos: { forceGatewayError: boolean };

  /** Default sink when no deliverer was injected. */
  readonly outbox: WebhookDelivery[] = [];

  private readonly webhookSecret: string;
  private readonly clock: Clock;
  private readonly deliver: WebhookDeliverer;
  private readonly accountId: string;
  private readonly ordersByTx = new Map<string, MockOrder>();
  private eventSeq = 0;

  constructor(opts: MockProviderOptions) {
    this.webhookSecret = opts.webhookSecret;
    this.clock = opts.clock;
    this.accountId = opts.accountId ?? "account_mock";
    this.chaos = { forceGatewayError: opts.chaosForceGatewayError ?? false };
    this.deliver =
      opts.deliver ??
      ((delivery) => {
        this.outbox.push(delivery);
      });
  }

  async createOrder(req: SettlementOrderRequest): Promise<SettlementOrderHandle> {
    // Identical body shaping as the live adapter (§5: same code path).
    buildCreateOrderBody(req); // budget enforcement + audit flag parity
    if (this.chaos.forceGatewayError) {
      throw new ChaosForcedGatewayError("chaos: forced mock gateway error");
    }
    await this.clock.sleep(MOCK_CREATE_LATENCY_MS);
    const digest = createHash("sha256").update(req.receipt, "utf8").digest();
    const rzpOrderId = `order_mock_${base32Upper(digest).slice(0, 10)}`;
    const order: MockOrder = {
      txId: req.tx_id,
      rzpOrderId,
      receipt: req.receipt,
      amountPaise: req.amount_paise,
    };
    this.ordersByTx.set(req.tx_id, order);
    return {
      provider: this.kind,
      rzp_order_id: rzpOrderId,
      receipt: req.receipt,
      amount_paise: req.amount_paise,
      currency: req.currency,
      provider_status: "created",
    };
  }

  verifyAndParseWebhook(
    rawBody: Buffer,
    signatureHeader: string | null,
    eventIdHeader: string | null,
  ): ParsedWebhook {
    // The SAME verification path the real provider uses — no mock bypass.
    return parseAuthenticatedWebhook(rawBody, [this.webhookSecret], signatureHeader, eventIdHeader);
  }

  /**
   * Mail a correctly-signed letter through the front door (§6): the simulator
   * NEVER mutates transaction state directly.
   */
  async schedulePaymentOutcome(
    txId: string,
    outcome: MockPaymentOutcome,
    opts: { delayMs?: number } = {},
  ): Promise<number> {
    const order = this.ordersByTx.get(txId);
    if (!order) {
      throw new Error(`schedulePaymentOutcome: unknown tx ${txId} — create the order first`);
    }
    const nowSec = Math.floor(this.clock.nowMs() / 1000);
    const eventId = `evt_mock_${createHash("sha256")
      .update(`${txId}:${outcome}:${++this.eventSeq}`)
      .digest("hex")
      .slice(0, 12)}`;
    const paymentInput = {
      paymentId: `pay_mock_${eventId.slice("evt_mock_".length)}`,
      rzpOrderId: order.rzpOrderId,
      amountPaise: order.amountPaise,
      createdAtEpochSec: nowSec,
    };

    if (outcome === "never") return 0;
    if (outcome === "delay") {
      await this.clock.sleep(opts.delayMs ?? 250);
      this.deliver(this.signed(buildPaymentCapturedEnvelope(paymentInput, this.accountId), eventId));
      return 1;
    }
    if (outcome === "failed") {
      const post = this.signed(
        buildPaymentFailedEnvelope(
          { ...paymentInput, errorCode: "PAYMENT_FAILED", errorDescription: "Simulated failure (mock)" },
          this.accountId,
        ),
        eventId,
      );
      this.deliver(post);
      return 1;
    }
    const envelope = buildOrderPaidEnvelope(
      {
        ...paymentInput,
        receipt: order.receipt,
        orderAmountPaidPaise: order.amountPaise,
        orderAmountDuePaise: 0,
        orderAttempts: 1,
      },
      this.accountId,
    );
    // captured and duplicate both carry a full capture; duplicate sends the
    // SAME signed bytes twice under the SAME event id (V8).
    const post = this.signed(envelope, eventId);
    this.deliver(post);
    if (outcome === "duplicate") this.deliver(post);
    return outcome === "duplicate" ? 2 : 1;
  }

  private signed(envelope: Record<string, unknown>, eventId: string): SignedWebhookPost {
    return buildSignedWebhook(this.webhookSecret, envelope, eventId);
  }
}
