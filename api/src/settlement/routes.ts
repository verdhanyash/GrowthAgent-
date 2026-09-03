/**
 * Settlement HTTP surface (settlement.md §2 routes.ts + §12 behavior matrix).
 *
 * Route ordering is load-bearing (§8.3): the webhook mounts with a RAW parser
 * and must never see the JSON parser first. buildSettlementApp() is the
 * module's composition root — the pipeline orchestrator (M7) reuses it as-is.
 *
 * Idempotency protocol follows §8.1 verbatim: ANY settle failure releases
 * the in-flight key so a clean retry is possible; deterministic outcomes
 * that SUCCEED at the HTTP layer are finalized as DONE snapshots.
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import { HttpError, SettleRequest } from "@growthagent/shared";
import { auditGlobal } from "../audit/writer.js";
import type { PgPool } from "../db/client.js";
import { requireAgent } from "../http/auth.js";
import { settle } from "./settle.js";
import type { SettleDeps } from "./settle.js";
import { SettlementRejectedError } from "./errors.js";
import { OrderAmbiguityError } from "./ensure-order.js";
import {
  abortIdempotency,
  finalizeIdempotency,
  idempotencyGate,
} from "./idempotency/middleware.js";
import type { PgIdempotencyStore } from "./idempotency/pg-store.js";
import type { RedisIdempotencyStore } from "./idempotency/redis-store.js";
import { webhookHandler, type WebhookHandlerDeps } from "./webhook-handler.js";

export interface SettlementStores {
  readonly redis: RedisIdempotencyStore;
  readonly pg: PgIdempotencyStore;
}

export interface SettlementRoutesDeps {
  readonly db: PgPool;
  readonly settleDeps: SettleDeps;
  readonly webhookDeps: WebhookHandlerDeps;
  readonly stores: SettlementStores;
  /**
   * The buyer routes (`POST /v1/tx/settle`, `GET /v1/tx/:tx_id`) now require a
   * valid buyer-agent key (`requireAgent`) and the read route enforces tx
   * OWNERSHIP — closing the unauthenticated hole. What auth still CANNOT prove
   * is that the gatekeeper actually approved: `settle()` trusts a self-asserted
   * `GATEKEEPER_AUTO` verdict + amount on the request body, and in production
   * approval is established by calling `settle()` in-process (never over this
   * HTTP surface) — `buildApiApp` deliberately does NOT mount this app. So even
   * authenticated, this composition root stays test-harness / in-process only;
   * `buildSettlementApp` refuses to build under NODE_ENV=production unless this
   * flag is set true to acknowledge the residual self-asserted-verdict risk.
   */
  readonly allowSelfAssertedVerdictInProd?: boolean;
}

/** The webhook route — raw-body capture BEFORE any JSON parsing (V7). */
export function webhookRoute(deps: WebhookHandlerDeps): Router {
  const router = express.Router();
  router.post(
    ["/webhooks/razorpay", "/v1/webhooks/razorpay"],
    express.raw({
      type: () => true, // accept whatever content-type arrives; we parse ourselves
      limit: "256kb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf; // stash exact bytes
      },
    }),
    webhookHandler(deps),
  );
  return router;
}

/** POST /v1/tx/settle + GET /v1/tx/:tx_id — buyer-agent facing. */
export function buyerRoutes(deps: SettlementRoutesDeps): Router {
  const router = express.Router();
  const gate = idempotencyGate(deps.stores.redis, deps.stores.pg);
  const auth = requireAgent(deps.db, "buyer_agent");

  router.post("/v1/tx/settle", auth, express.json({ limit: "256kb" }), gate, async (req, res, next) => {
    try {
      const parsed = SettleRequest.safeParse(req.body);
      if (!parsed.success) {
        throw new SettlementRejectedError("INVALID_SETTLE_REQUEST", "proposal failed schema", 400);
      }
      let result;
      try {
        // Stamp the authenticated caller as the tx owner (E-11) so the read
        // route can enforce ownership. requireAgent guarantees req.agent here.
        result = await settle(parsed.data.proposal, deps.settleDeps, { ownerAgentId: req.agent!.agentId });
      } catch (e) {
        // Failed start: release the key so the same id can retry cleanly (§8.1).
        await abortIdempotency(res, deps.stores.redis);
        throw e;
      }
      await finalizeIdempotency(res, deps.stores, result.response.tx_id, result.httpStatus, result.response);
      res.status(result.httpStatus).json(result.response);
    } catch (e) {
      next(e);
    }
  });

  router.get("/v1/tx/:tx_id", auth, async (req, res, next) => {
    try {
      const row = await deps.db.query(
        `SELECT t.tx_id, t.state, t.approved_total_paise, t.proposal_bytes, t.provider_kind,
                t.pay_id, t.created_at, t.paid_at, t.expired_at, t.completed_at, t.failed_at,
                t.agent_id, o.rzp_order_id
           FROM transactions t
       LEFT JOIN razorpay_orders o USING (tx_id)
          WHERE t.tx_id = $1`,
        [req.params.tx_id],
      );
      // Uniform 404 for both "no such tx" AND "not your tx" — never leak the
      // existence of another agent's transaction via a distinguishable 403.
      if ((row.rowCount ?? 0) === 0) {
        res.status(404).json({ code: "TX_NOT_FOUND" });
        return;
      }
      const t = row.rows[0] as Record<string, unknown>;
      if (t.agent_id !== req.agent!.agentId) {
        res.status(404).json({ code: "TX_NOT_FOUND" });
        return;
      }
      const proposal = t.proposal_bytes as { lines?: unknown[] };
      res.status(200).json({
        tx_id: t.tx_id,
        state: t.state,
        rzp_order_id: t.rzp_order_id,
        amount_paise: t.approved_total_paise,
        currency: "INR",
        lines: proposal.lines ?? [],
        provider_kind: t.provider_kind,
        pay_id: t.pay_id,
        timestamps: {
          created_at: t.created_at,
          paid_at: t.paid_at,
          expired_at: t.expired_at,
          completed_at: t.completed_at,
          failed_at: t.failed_at,
        },
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/** Typed-error → status/code mapping; unknown errors stay 500 with audit. */
export function settlementErrorMiddleware(): (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (err, _req, res, _next) => {
    if (res.headersSent) return;
    // Auth/authorization rejections arrive as shared `HttpError` from
    // `requireAgent` (401 UNAUTHORIZED / 401 AGENT_KEY_REVOKED / 403 FORBIDDEN).
    // They are rendered in THIS surface's flat `{code, description}` shape — the
    // settlement routes predate the M8 `{error:{...}}` envelope and every
    // settlement client/test reads `code` at the top level. Without this branch
    // an unauthenticated request fell through to the catch-all below and
    // surfaced as a misleading 500 INTERNAL.
    if (err instanceof HttpError) {
      res.status(err.status).json({ code: err.code, description: err.message });
      return;
    }
    if (err instanceof SettlementRejectedError) {
      res.status(err.httpStatus).json({ code: err.code, description: err.description, ...err.extra });
      return;
    }
    if (err instanceof OrderAmbiguityError) {
      res.status(409).json({
        code: "ORDER_AMBIGUOUS",
        description: "a prior attempt created an unverifiable order; ops review queued",
      });
      auditGlobal("settlement.order", "rzp.order_ambiguous", { surfaced_to_buyer: true });
      return;
    }
    auditGlobal("settlement.http", "unhandled_error", { err: String(err) });
    // Parity with `apiErrorRenderer` (http/errors.ts): the audit row keeps only
    // String(err), which drops the stack — log it once so an unexpected 500 on
    // this surface is diagnosable without re-instrumenting the middleware.
    console.error("[settlement] unhandled error:", err instanceof Error ? err.stack ?? err.message : String(err));
    res.status(500).json({ code: "INTERNAL", retryable: false });
  };
}

/** Module composition root: raw-body webhook FIRST, then JSON-parsed buyer
 *  routes, then the typed error mapper last. */
export function buildSettlementApp(deps: SettlementRoutesDeps): Express {
  if (process.env.NODE_ENV === "production" && deps.allowSelfAssertedVerdictInProd !== true) {
    throw new Error(
      "[settlement] refusing to build in production: /v1/tx/settle is now " +
        "authenticated, but it still trusts a self-asserted GATEKEEPER_AUTO " +
        "verdict + amount on the request body — any valid buyer key could settle " +
        "an amount the gatekeeper never approved. This composition root is for the " +
        "test harness / in-process pipeline only (buildApiApp does not mount it). " +
        "Move approval proof onto the request (or keep settle() in-process), then " +
        "set allowSelfAssertedVerdictInProd:true to acknowledge.",
    );
  }
  const app = express();
  app.disable("x-powered-by");
  app.use(webhookRoute(deps.webhookDeps)); // raw parser — MUST precede json()
  app.use(buyerRoutes(deps));
  app.use(settlementErrorMiddleware());
  return app;
}
