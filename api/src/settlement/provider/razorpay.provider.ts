/**
 * RazorpayProvider — real TEST-mode Orders API adapter (settlement.md §5).
 * Selected only when RAZORPAY_PROVIDER=TEST_MODE with pattern-valid keys
 * (config.ts refuses placeholders). Same narrow seam as MockProvider; the
 * createOrder BODY goes through the identical buildCreateOrderBody shaping,
 * and webhook verification delegates to the SAME parseAuthenticatedWebhook
 * HMAC path (mock mode can never mean security bypassed).
 *
 * Error mapping (§4 taxonomy): timeouts/network/5xx → ProviderUnavailableError;
 * 400 mentioning receipt → DuplicateReceiptError (U2: classification stays
 * heuristic, raw status text carried); other 4xx → ProviderRejectedError;
 * schema-invalid SUCCESS bodies → ProviderParseError.
 */
import { z } from "zod";
import type {
  ParsedWebhook,
  SettlementOrderHandle,
  SettlementOrderRequest,
  SettlementProvider,
  ProviderKind,
} from "./types.js";
import {
  buildCreateOrderBody,
  DuplicateReceiptError,
  ProviderParseError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "./types.js";
import { parseAuthenticatedWebhook } from "./payload.schema.js";

/** V5 order-response shape — pinned fields only; unknown extras stripped so
 *  docs drift that adds fields stays green (mirrors payload.schema policy). */
const OrderResponseZ = z.object({
  id: z.string().startsWith("order_"),
  entity: z.literal("order"),
  amount: z.number().int().positive(),
  currency: z.literal("INR"),
  status: z.enum(["created", "attempted", "paid"]),
  receipt: z.string(),
  created_at: z.number().int().positive(),
});

export interface RazorpayProviderOptions {
  readonly keyId: string;
  readonly keySecret: string;
  /** [current, ...rotation] — V7 rotation caveat. */
  readonly webhookSecrets: readonly string[];
  readonly baseUrl?: string; // default production; tests point at loopback stubs
  readonly timeoutMs?: number;
  readonly chaosForceGatewayError?: boolean;
}

export class RazorpayProvider implements SettlementProvider {
  readonly kind: ProviderKind = "razorpay";

  private readonly auth: string; // Basic base64(key_id:key_secret)
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly webhookSecrets: readonly string[];
  private readonly chaosForceGatewayError: boolean;

  constructor(opts: RazorpayProviderOptions) {
    this.auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`, "utf8").toString("base64")}`;
    this.baseUrl = (opts.baseUrl ?? "https://api.razorpay.com/v1").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.webhookSecrets = opts.webhookSecrets;
    this.chaosForceGatewayError = opts.chaosForceGatewayError ?? false;
  }

  async createOrder(req: SettlementOrderRequest): Promise<SettlementOrderHandle> {
    // Identical body shaping as the mock (§5: same code path).
    const body = buildCreateOrderBody(req);
    if (this.chaosForceGatewayError) {
      throw new ProviderUnavailableError("chaos: forced gateway error");
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/orders`, {
        method: "POST",
        headers: {
          Authorization: this.auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: body.amount,
          currency: body.currency,
          receipt: body.receipt,
          notes: body.notes,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Network failure OR timeout abort → retryable either way.
      throw new ProviderUnavailableError(`orders request failed: ${String(e)}`);
    }

    const rawText = await res.text();
    if (!res.ok) {
      if (res.status >= 500) {
        throw new ProviderUnavailableError(`razorpay ${res.status}: ${rawText.slice(0, 200)}`);
      }
      if (res.status === 400 && /receipt/i.test(rawText)) {
        // U2: exact machine code unverified — heuristic classification, raw
        // description preserved for the audit trail either way.
        throw new DuplicateReceiptError(rawText.slice(0, 500));
      }
      let code = `HTTP_${res.status}`;
      let description = rawText.slice(0, 200);
      try {
        const parsed = JSON.parse(rawText) as { error?: { code?: string; description?: string } };
        if (parsed.error?.code) code = parsed.error.code;
        if (parsed.error?.description) description = parsed.error.description;
      } catch {
        /* non-JSON error body: fall back to raw text */
      }
      throw new ProviderRejectedError(code, description, res.status);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new ProviderParseError("order response is not valid JSON");
    }
    const parsed = OrderResponseZ.safeParse(json);
    if (!parsed.success) {
      throw new ProviderParseError("order response failed OrderResponseZ validation");
    }
    const o = parsed.data;
    return {
      provider: this.kind,
      rzp_order_id: o.id,
      receipt: o.receipt,
      amount_paise: req.amount_paise,
      currency: "INR",
      provider_status: "created", // our create just succeeded; V5 status pinned
      created_at_epoch_sec: o.created_at,
    };
  }

  verifyAndParseWebhook(
    rawBody: Buffer,
    signatureHeader: string | null,
    eventIdHeader: string | null,
  ): ParsedWebhook {
    // The SAME verification path the mock uses — one security implementation.
    return parseAuthenticatedWebhook(rawBody, this.webhookSecrets, signatureHeader, eventIdHeader);
  }
}
