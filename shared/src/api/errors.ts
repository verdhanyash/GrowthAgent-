/**
 * shared/src/api/errors.ts — the ONE error envelope (api-contract.md §3).
 *
 * Every non-2xx from every layer (validation, auth, throttle, handler, crash)
 * is this exact shape. Handlers never hand-write errors: they throw `HttpError`
 * and one central renderer (api/src/http/errors.ts) emits the envelope.
 */
import { z } from "zod";
import { TxId } from "./primitives.js";

export const ErrorCode = z.enum([
  // 4xx — client
  "VALIDATION_ERROR", // 400 zod issue list in details
  "UNSUPPORTED_MEDIA_TYPE", // 415
  "PAYLOAD_TOO_LARGE", // 413
  "UNAUTHORIZED", // 401 missing/garbage X-Agent-Key
  "AGENT_KEY_REVOKED", // 401 key resolved but revoked_at set
  "FORBIDDEN", // 403 authenticated, wrong role/route
  "TX_NOT_FOUND", // 404 unknown tx OR tx belonging to another agent (no existence leak)
  "APPROVAL_NOT_FOUND", // 404
  "AGENT_NOT_FOUND", // 404 revoke targeted an unknown agent_id (admin, loopback-only — no existence-leak concern)
  "SCENARIO_NOT_FOUND", // 404 unknown :name
  "IDEMPOTENCY_CONFLICT", // 409 same key, different request hash
  "APPROVAL_ALREADY_RESOLVED", // 409 second resolve attempt loses the race
  "RULES_VERSION_CONFLICT", // 409 optimistic concurrency on PUT /admin/rules
  "RULES_DRIFTED", // 409 approval attempted against a different rules_version
  "RULES_INCREASE_COOLDOWN", // 409 a raise to the same field landed <15 min ago (§7.1)
  "DEMO_RESET_BLOCKED", // 409 reset refused: live reservations / non-terminal tx (§7.4)
  "RATE_LIMITED_HTTP", // 429 transport-layer limiter (NOT business velocity)
  "CHAOS_ACTIVE", // 503 injected fault active on this request (demo only)
  // 5xx — server
  "INTERNAL_ERROR", // 500 unhandled
  "UPSTREAM_UNAVAILABLE", // 502/503 Razorpay or Anthropic unreachable after retries
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiErrorEnvelope = z
  .object({
    error: z
      .object({
        code: ErrorCode,
        message: z.string(), // human-readable, safe to render; never a stack/secret
        details: z.unknown().optional(), // e.g. zod issue list for VALIDATION_ERROR
        tx_id: TxId.optional(), // present whenever the error is bound to a known tx
        request_id: z.string(), // echo of X-Request-Id or a freshly minted req_ ULID
        retryable: z.boolean(), // client guidance: may an identical retry succeed?
        api_version: z.literal("v1"),
      })
      .strict(),
  })
  .strict();
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelope>;

export interface HttpErrorOpts {
  readonly details?: unknown;
  readonly txId?: string | undefined;
  readonly retryable?: boolean;
}

/** Thrown anywhere; the central renderer maps status→envelope. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly opts: HttpErrorOpts;
  constructor(status: number, code: ErrorCode, message: string, opts: HttpErrorOpts = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.opts = opts;
  }
}
