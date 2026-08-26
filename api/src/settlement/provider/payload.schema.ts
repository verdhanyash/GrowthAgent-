/**
 * Webhook envelope schemas + the shared verify-and-parse path (settlement.md
 * §4/§8.3). Zod parsing happens ONLY after HMAC authentication succeeds (V7:
 * "Do Not Parse or Cast the Webhook Request Body" before hashing) — both the
 * real RazorpayProvider and the MockProvider delegate here, so mock mode can
 * never mean security bypassed.
 *
 * Envelope shapes mirror the documented samples field-for-field (V10/V11);
 * unknown extra fields are stripped silently so docs drift that only ADDS
 * fields stays green, while drift in the pinned fields breaks CI (§5).
 */
import { z } from "zod";
import {
  ProviderParseError,
  WebhookAuthenticationError,
  type OrderEntity,
  type ParsedWebhook,
  type PaymentEntity,
} from "./types.js";
import { hmacSha256Hex, secureCompareHex, sha256Hex } from "./sign.js";

export const PaymentEntityZ = z.object({
  id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(1),
  status: z.string().min(1),
  order_id: z.string().min(1),
  method: z.string().nullable(),
  captured: z.boolean(),
  fee: z.number().nullable(),
  tax: z.number().nullable(),
  error_code: z.string().nullable(),
  error_description: z.string().nullable(),
  created_at: z.number().int().positive(),
});

export const OrderEntityZ = z.object({
  id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  amount_paid: z.number().int().nonnegative(),
  amount_due: z.number().int().nonnegative(),
  currency: z.string().min(1),
  receipt: z.string(),
  status: z.string().min(1),
  attempts: z.number().int().nonnegative(),
});

export const EventEnvelopeZ = z
  .object({
    entity: z.literal("event"),
    account_id: z.string().optional(),
    event: z.string().min(1),
    contains: z.array(z.string()),
    payload: z.object({
      payment: z.object({ entity: PaymentEntityZ }).optional(),
      order: z.object({ entity: OrderEntityZ }).optional(),
    }),
    created_at: z.number().int().positive(), // unix seconds — freshness anchor
  })
  .strict();

/**
 * THE single verification path. `secrets` is [current, ...rotation] (V7:
 * after a rotation old payloads validate only against the old secret).
 * Throws WebhookAuthenticationError on missing/invalid signature; throws
 * ProviderParseError when authenticated bytes are structurally wrong.
 * `eventIdHeader` is advisory (U4: not signature-covered); falls back to a
 * self-computed digest of the authenticated bytes.
 */
export function parseAuthenticatedWebhook(
  rawBody: Buffer,
  secrets: readonly string[],
  signatureHeader: string | null,
  eventIdHeader: string | null,
): ParsedWebhook {
  if (secrets.length === 0 || !signatureHeader) {
    throw new WebhookAuthenticationError(
      secrets.length === 0 ? "no webhook secret configured" : "missing signature header",
    );
  }
  let authenticated = false;
  for (const secret of secrets) {
    if (secureCompareHex(signatureHeader, hmacSha256Hex(secret, rawBody))) {
      authenticated = true;
      break;
    }
  }
  if (!authenticated) {
    throw new WebhookAuthenticationError("signature does not match any configured secret");
  }

  let envelopeJson: unknown;
  try {
    envelopeJson = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new ProviderParseError("authenticated webhook body is not valid JSON");
  }

  // Header value is authoritative when present (V8) but NOT covered by the
  // signature (V7/U4) → advisory; body digest is the fallback identity.
  const eventId =
    eventIdHeader !== null && eventIdHeader.trim() !== ""
      ? eventIdHeader.trim()
      : sha256Hex(rawBody);

  return parseValidatedEnvelope(envelopeJson, eventId);
}

/**
 * Schema-validate an ALREADY-AUTHENTICATED envelope into the discriminated
 * union. Shared by the ingress path (after HMAC) and the §10.1/W6 sweeper
 * redrive (rows whose bytes were verified at first receipt).
 */
export function parseValidatedEnvelope(envelopeJson: unknown, eventId: string): ParsedWebhook {
  const envelope = EventEnvelopeZ.safeParse(envelopeJson);
  if (!envelope.success) {
    throw new ProviderParseError("authenticated webhook body failed EventEnvelopeZ validation");
  }

  const env = envelope.data;
  const occurredAt = env.created_at;
  switch (env.event) {
    case "payment.captured": {
      if (!env.payload.payment) throw new ProviderParseError("payment.captured without payment entity");
      return {
        kind: "payment.captured",
        event_id: eventId,
        occurred_at_epoch_sec: occurredAt,
        payment: env.payload.payment.entity as PaymentEntity,
      };
    }
    case "order.paid": {
      if (!env.payload.payment || !env.payload.order) {
        throw new ProviderParseError("order.paid must carry BOTH payment and order entities (V11)");
      }
      return {
        kind: "order.paid",
        event_id: eventId,
        occurred_at_epoch_sec: occurredAt,
        payment: env.payload.payment.entity as PaymentEntity,
        order: env.payload.order.entity as OrderEntity,
      };
    }
    case "payment.failed": {
      if (!env.payload.payment) throw new ProviderParseError("payment.failed without payment entity");
      return {
        kind: "payment.failed",
        event_id: eventId,
        occurred_at_epoch_sec: occurredAt,
        payment: env.payload.payment.entity as PaymentEntity,
      };
    }
    default:
      // ACK, ignore — but the freshness anchor still rides along (§8.3 step 3).
      return { kind: "ignored", event_id: eventId, event: env.event, occurred_at_epoch_sec: occurredAt };
  }
}
