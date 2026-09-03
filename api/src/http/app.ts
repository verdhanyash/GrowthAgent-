/**
 * api/src/http/app.ts — the M8 composition root (`buildApiApp`).
 *
 * Middleware order is load-bearing:
 *   1. requestContext()           — mint/echo X-Request-Id for every response
 *   1b. cors()                    — default OFF; allowlist via CORS_ALLOWED_ORIGINS
 *   2. webhook router (optional)  — RAW body parser, MUST precede any json()
 *   3. requireAgent on the buyer  — auth guards POST/poll (stream does its own)
 *   4. proposal routes            — POST /v1/carts/proposals + the poll
 *   5. stream routes              — POST /v1/stream-tickets + GET /v1/stream/:txId
 *   6. jsonNotFound + apiErrorRenderer — the single error envelope path (§3)
 *
 * The `enqueue`/`buildMandate` seams keep this file free of pipeline + crypto
 * wiring; `server.ts` supplies the real closures. The webhook router is reused
 * verbatim from settlement (its raw parser is why it mounts first).
 */
import express, { type Express, type Router } from "express";
import type { CartMandate, MerchantRulesConfig } from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import type { AuditChain } from "../pipeline/audit-chain.js";
import type { TraceBus } from "../pipeline/bus.js";
import type { RunInput } from "../pipeline/orchestrator.js";
import { requestContext, jsonNotFound, apiErrorRenderer } from "./errors.js";
import { cors } from "./cors.js";
import { requireAgent } from "./auth.js";
import { rateLimit, FailureLimiter } from "./rate-limit.js";
import { proposalRoutes } from "./proposals.route.js";
import { streamRoutes } from "./stream.route.js";
import { adminRoutes } from "./admin-mount.js";
import type { ChaosController } from "./chaos-controller.js";
import type { ScenarioRunner } from "./scenario-runner.js";

export interface ApiAppDeps {
  readonly db: PgPool;
  readonly bus: TraceBus;
  readonly chain: AuditChain;
  readonly nowMs: () => number;
  readonly rulesVersion: () => number;
  readonly enqueue: (input: RunInput) => void;
  readonly buildMandate: (txId: string) => Promise<CartMandate | null>;
  readonly ticketSecret: string;
  readonly merchantId?: string | undefined;
  /** Admin/demo control plane (§4.3 guard). Mounted behind the loopback +
   *  X-Admin-Token guard at the /v1/admin and /v1/demo prefixes. */
  readonly adminToken?: string | undefined;
  readonly allowInsecureAdmin?: boolean | undefined;
  /** Detached escalation resolvers for the approvals inbox (§7.2). Built in
   *  server.ts/harness from resumeAfterApproval/rejectAfterRejection. */
  readonly resumeApproval?: ((a: { approval_id: string; decided_by: string; note?: string | undefined }) => Promise<{ already: boolean }>) | undefined;
  readonly rejectApproval?: ((a: { approval_id: string; decided_by: string; note?: string | undefined }) => Promise<{ already: boolean }>) | undefined;
  /** Current rules accessor + update callback (for rules admin, §7.1). */
  readonly getCurrentRules?: (() => MerchantRulesConfig | Promise<MerchantRulesConfig>) | undefined;
  readonly onRulesUpdated?: ((newRules: MerchantRulesConfig) => void) | undefined;
  /** Pre-built webhook router (raw parser); omitted in focused HTTP tests. */
  readonly webhook?: Router | undefined;
  /** In-process chaos controller. */
  readonly chaos?: ChaosController | undefined;
  /** Custom scenario runner instance. */
  readonly runner?: ScenarioRunner | undefined;
  readonly heartbeatMs?: number | undefined;
  readonly terminalPollMs?: number | undefined;
  /** Transport-layer limiter tuning for the mutating POSTs (RATE_LIMITED_HTTP).
   *  Defaults to a generous per-agent burst so the poll/SSE paths (never
   *  limited) and normal demo traffic are unaffected. */
  readonly rateLimit?: { readonly capacity: number; readonly refillPerSec: number } | undefined;
  /** Failed-authentication budget per source IP (audit 8.2). Defaults to a
   *  10-failure burst forgiven at 0.5/s — invisible to honest clients, fatal to
   *  a key brute-forcer. */
  readonly authFailureLimit?: { readonly maxFailures: number; readonly refillPerSec: number } | undefined;
  /** Concurrent SSE ceilings (audit 9.3). */
  readonly maxStreams?: number | undefined;
  readonly maxStreamsPerAgent?: number | undefined;
  /** EXACT browser origins allowed to call this API (audit 8.4). Empty/omitted
   *  ⇒ no CORS headers at all, which is what the same-origin demo wants. */
  readonly allowedOrigins?: readonly string[] | undefined;
}

export function buildApiApp(deps: ApiAppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(requestContext());
  // Explicit (default-off) cross-origin posture, before anything that can
  // reject: a preflight must not need an X-Agent-Key.
  app.use(cors(deps.allowedOrigins ?? []));

  // Webhook FIRST — its express.raw() must see the body before any json().
  if (deps.webhook !== undefined) app.use(deps.webhook);

  // Transport-layer rate limit on the EXPENSIVE mutating POSTs only — proposal
  // create fires a pipeline, stream-ticket mint signs a credential. The cheap
  // poll GET and long-lived SSE GET are deliberately never limited.
  const rl = deps.rateLimit ?? { capacity: 30, refillPerSec: 10 };
  const limiter = rateLimit(rl);
  // Separate budget for FAILED authentications (audit 8.2). The bucket above
  // sits after requireAgent, so an unrecognized X-Agent-Key never spent a
  // token and the key space could be ground for free; and the prefix cannot be
  // limited wholesale because the poll GET shares it. Successful traffic of any
  // volume is untouched — only rejections cost the source.
  const authFailures = new FailureLimiter(deps.authFailureLimit ?? { maxFailures: 10, refillPerSec: 0.5 });

  // Buyer proposal surface is agent-authenticated; the SSE GET is NOT (browsers
  // can't set headers — it authenticates via ticket/X-Agent-Key on its own).
  app.use(
    "/v1/carts/proposals",
    authFailures.guard(),
    requireAgent(deps.db, "buyer_agent", { onFailure: (req) => authFailures.record(req) }),
  );
  app.post("/v1/carts/proposals", limiter); // after auth → keys by agent id
  app.post("/v1/stream-tickets", limiter); // before streamRoutes' own auth → keys by IP
  app.use(
    proposalRoutes({
      db: deps.db,
      nowMs: deps.nowMs,
      rulesVersion: deps.rulesVersion,
      enqueue: deps.enqueue,
      buildMandate: deps.buildMandate,
      merchantId: deps.merchantId,
    }),
  );

  app.use(
    streamRoutes({
      db: deps.db,
      bus: deps.bus,
      chain: deps.chain,
      nowMs: deps.nowMs,
      ticketSecret: deps.ticketSecret,
      heartbeatMs: deps.heartbeatMs,
      terminalPollMs: deps.terminalPollMs,
      maxStreams: deps.maxStreams,
      maxStreamsPerAgent: deps.maxStreamsPerAgent,
    }),
  );

  // Admin/demo control plane — guard scoped to /v1/admin + /v1/demo inside.
  const noResolver = (what: string) => async () => {
    console.error(`[api] ${what} invoked but no resolver was wired into buildApiApp`);
    return { already: false };
  };
  app.use(
    adminRoutes({
      db: deps.db,
      adminToken: deps.adminToken,
      allowInsecureAdmin: deps.allowInsecureAdmin,
      rulesVersion: deps.rulesVersion,
      resumeApproval: deps.resumeApproval ?? noResolver("resumeApproval"),
      rejectApproval: deps.rejectApproval ?? noResolver("rejectApproval"),
      chain: deps.chain,
      getCurrentRules: deps.getCurrentRules ?? (() => { throw new Error("getCurrentRules not wired"); }),
      onRulesUpdated: deps.onRulesUpdated ?? (() => { /* noop */ }),
      chaos: deps.chaos,
      runner: deps.runner,
      enqueue: deps.enqueue,
      nowMs: deps.nowMs,
    }),
  );

  app.use(jsonNotFound());
  app.use(apiErrorRenderer());
  return app;
}
