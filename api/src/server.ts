/**
 * GrowthAgent API entrypoint — M8 composition root.
 *
 * `greeting()` stays (M0 toolchain smoke). `buildServer()` is the real root:
 * pool → migrations → audit chain boot → rules store → TraceBus + emitter →
 * pipeline deps → the `enqueue`/`buildMandate` seams → `buildApiApp` → the
 * reconciliation sweep loop. A guarded `listen` runs it only when invoked
 * directly (never under vitest).
 *
 * The negotiation transport is live NIM when NVIDIA_API_KEY is set, else a
 * loud-reject stub (the pipeline degrades to its deterministic fallback per
 * negotiation §3) — so the server boots for demos without a key present.
 *
 * The settlement provider is chosen by `RAZORPAY_PROVIDER`, not hardcoded
 * (audit S4): TEST_MODE arms the real RazorpayProvider against the configured
 * keys, MOCK arms the local double. config.ts already refuses inconsistent
 * combinations at boot, so by the time we get here the choice is safe to obey.
 */
import {
  SHARED_PACKAGE_VERSION,
  MEERA_GT_V1,
  type CampaignPriorityPayload,
  type MerchantRulesConfig,
} from "@growthagent/shared";
import { pathToFileURL } from "node:url";
import type { Express } from "express";
import { applyMigrations, createPool, type PgPool } from "./db/client.js";
import { AuditChain } from "./pipeline/audit-chain.js";
import { TraceBus } from "./pipeline/bus.js";
import { PipelineEmitter } from "./pipeline/emitter.js";
import { runPipeline, resumeAfterApproval, rejectAfterRejection, type PipelineDeps, type RunInput, type ResolveDeps } from "./pipeline/orchestrator.js";
import { failRunNow, sweepStalledProposals } from "./pipeline/stall-sweeper.js";
import { RulesStore } from "./rules/store.js";
import { SystemClock } from "./settlement/clock.js";
import { loadSettlementConfig, type SettlementConfig } from "./settlement/config.js";
import { MockProvider } from "./settlement/provider/mock.provider.js";
import { RazorpayProvider } from "./settlement/provider/razorpay.provider.js";
import type { SettlementProvider } from "./settlement/provider/types.js";
import { runSweep, sweepExpiredReservations } from "./settlement/sweeper.js";
import { LiveNimTransport } from "./negotiation/transport.nim.live.js";
import type { NegotiationTransport } from "./negotiation/transport.types.js";
import { buildApiApp } from "./http/app.js";
import { buildCartMandate, DEFAULT_MANDATE_TTL_MS, DEV_MERCHANT_SIGNING_SECRET } from "./http/mandate-builder.js";
import { resolveAllowInsecure } from "./http/admin-guard.js";
import { parseAllowedOrigins } from "./http/cors.js";
import { webhookRoute } from "./settlement/routes.js";

const PORT = Number(process.env.API_PORT ?? 3000);
/**
 * Bind LOOPBACK by default (audit H1, exploit chain 1). The admin/demo control
 * plane is gated on "the caller connected from loopback"; binding 0.0.0.0 —
 * Express's default — is what turned that into "anything the internet can reach
 * is admin" on a staging box. Exposing the API is now an explicit act.
 */
const HOST = process.env.API_HOST ?? "127.0.0.1";
const BIND_IS_LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
const DEV_TICKET_SECRET = "ga-stream-ticket-secret-dev-only";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Effective insecure-admin posture for THIS process. Even outside production,
 * a non-loopback bind forces the escape hatch off: the guard's loopback test is
 * only meaningful while loopback is the only way in.
 */
function effectiveAllowInsecureAdmin(): boolean {
  const wanted = resolveAllowInsecure();
  if (wanted && !BIND_IS_LOOPBACK) {
    console.warn(
      `[api] ALLOW_INSECURE_ADMIN ignored: API_HOST=${HOST} is not loopback, so tokenless ` +
        `admin access is refused. Set ADMIN_TOKEN and present X-Admin-Token.`,
    );
    return false;
  }
  return wanted;
}

/**
 * Resolve a signing secret, failing CLOSED in production. The repo-committed dev
 * fallbacks exist ONLY to keep the zero-config demo booting outside production;
 * in production an unset (or dev-equal) secret refuses boot rather than silently
 * signing mandates/tickets with a value that ships in git (any reader of the
 * repo could then forge them). Non-production boots loudly with the fallback.
 */
function resolveSigningSecret(name: string, devFallback: string): string {
  const provided = process.env[name];
  if (provided !== undefined && provided.trim() !== "" && provided !== devFallback) {
    return provided;
  }
  if (IS_PRODUCTION) {
    throw new Error(
      `[api] refusing to boot: ${name} must be set to a real secret in production ` +
        `(it is unset or equal to the committed dev fallback). Set ${name} in the environment.`,
    );
  }
  console.warn(
    `[api] WARNING: ${name} is unset — using the committed dev fallback. ` +
      `Safe ONLY for local/demo; a production boot would refuse this.`,
  );
  return devFallback;
}

export function greeting(): string {
  return `growthagent api ${SHARED_PACKAGE_VERSION} — gatekeeper pending (M1)`;
}

export interface ApiServer {
  readonly app: Express;
  readonly pool: PgPool;
  close(): Promise<void>;
}

/** Live NIM when keyed, else an honest reject stub → deterministic fallback. */
function buildTransport(): NegotiationTransport {
  const key = process.env.NVIDIA_API_KEY;
  if (key !== undefined && key !== "") return new LiveNimTransport({ apiKey: key });
  return { execute: () => Promise.reject(new Error("no NVIDIA_API_KEY — negotiation degrades to fallback")) };
}

/**
 * Arm the provider the CONFIG selected (audit S4). `loadSettlementConfig` has
 * already refused TEST_MODE without pattern-valid keys and MOCK with keys
 * present, so the discriminant can be obeyed without re-validating here.
 */
export function buildProvider(config: SettlementConfig, clock: SystemClock): SettlementProvider {
  if (config.providerMode === "TEST_MODE") {
    // Non-null: TEST_MODE cannot load without both key halves (config.ts).
    return new RazorpayProvider({
      keyId: config.keyId!,
      keySecret: config.keySecret!,
      webhookSecrets: config.webhookSecrets,
      chaosForceGatewayError: config.chaosForceGatewayError,
      ...(process.env.RAZORPAY_BASE_URL !== undefined && process.env.RAZORPAY_BASE_URL !== ""
        ? { baseUrl: process.env.RAZORPAY_BASE_URL }
        : {}),
    });
  }
  return new MockProvider({ webhookSecret: config.webhookSecrets[0]!, clock });
}

export async function buildServer(): Promise<ApiServer> {
  const pool = createPool();
  await pool.query("SELECT 1");
  await applyMigrations(pool);

  const chain = new AuditChain(pool);
  await chain.boot();
  const bus = new TraceBus();

  // Rules live in Postgres and are read THROUGH on every gate entry, so a PUT on
  // another replica cannot leave this one judging carts under stale caps (H4).
  const rulesStore = new RulesStore(pool);
  const booted = await rulesStore.boot();
  // eslint-disable-next-line no-console -- boot diagnostics, same as greeting()
  console.log(`[api] active merchant rules v${booted.rules_version}`);

  const emitter = new PipelineEmitter(chain, bus, () => rulesStore.version());
  const clock = new SystemClock();
  const settleConfig = loadSettlementConfig(process.env);
  const provider = buildProvider(settleConfig, clock);
  // eslint-disable-next-line no-console -- boot diagnostics: WHICH gateway is armed
  console.log(
    `[api] settlement provider: ${provider.kind} (mode ${settleConfig.providerMode}, ` +
      `key fingerprint ${settleConfig.keyFingerprint})`,
  );

  const pipelineDeps: PipelineDeps = {
    db: pool,
    clock,
    chain,
    emitter,
    transport: buildTransport(),
    narrator: undefined,
    groundTruth: async () => MEERA_GT_V1,
    priorities: async (): Promise<readonly CampaignPriorityPayload[]> => [],
    rules: () => rulesStore.load(),
    velocity: undefined,
    provider,
    settleConfig,
    reserveVelocity: undefined,
    approvalTtlMs: DEFAULT_MANDATE_TTL_MS,
  };

  const signingSecret = resolveSigningSecret("MERCHANT_SIGNING_SECRET", DEV_MERCHANT_SIGNING_SECRET);
  const ticketSecret = resolveSigningSecret("STREAM_TICKET_SECRET", DEV_TICKET_SECRET);

  // Detached escalation resolvers for the approvals inbox (§7.2).
  const resolveDeps: ResolveDeps = { db: pool, clock, chain, emitter, provider, settleConfig };

  // Webhook ingress router (mounted with raw body parser BEFORE json parsers).
  const webhook = webhookRoute({ db: pool, provider, config: settleConfig, clock });

  const app = buildApiApp({
    db: pool,
    bus,
    chain,
    webhook,
    nowMs: () => clock.nowMs(),
    rulesVersion: () => rulesStore.version(),
    // Fire the pipeline detached. A rejection is logged AND recorded as a
    // terminal FAILED outcome, or the buyer poll and the SSE stream would hang
    // on a run that is already over (audit 13.1).
    enqueue: (input: RunInput) => {
      void runPipeline(pipelineDeps, input).catch((err) => {
        console.error(`[api] pipeline run failed for ${input.tx_id}:`, err instanceof Error ? err.stack ?? err.message : String(err));
        void failRunNow(pool, input.tx_id, {
          reason: err instanceof Error ? err.name : "PIPELINE_ERROR",
          retryable: true,
        }).catch((e2) => {
          console.error(`[api] could not record pipeline failure for ${input.tx_id}:`, e2);
        });
      });
    },
    buildMandate: (txId: string) =>
      buildCartMandate({ db: pool, groundTruth: async () => MEERA_GT_V1, nowMs: () => clock.nowMs(), signingSecret }, txId),
    ticketSecret,
    // Admin/demo control plane (§4.3). ADMIN_TOKEN gates loopback callers; the
    // insecure hatch is forced OFF in production by resolveAllowInsecure().
    adminToken: process.env.ADMIN_TOKEN,
    allowInsecureAdmin: effectiveAllowInsecureAdmin(),
    allowedOrigins: parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),
    resumeApproval: (a) => {
      return resumeAfterApproval(resolveDeps, a).catch((err) => {
        console.error(`[api] approval resume failed for ${a.approval_id}:`, err instanceof Error ? err.stack ?? err.message : String(err));
        return { already: false };
      });
    },
    rejectApproval: (a) => {
      return rejectAfterRejection(resolveDeps, a).catch((err) => {
        console.error(`[api] approval reject failed for ${a.approval_id}:`, err instanceof Error ? err.stack ?? err.message : String(err));
        return { already: false };
      });
    },
    getCurrentRules: () => rulesStore.load(),
    onRulesUpdated: (newRules: MerchantRulesConfig) => {
      rulesStore.set(newRules);
      // eslint-disable-next-line no-console -- operator-visible control-plane change
      console.log(`[api] rules updated to v${newRules.rules_version}`);
    },
  });

  // Reconciliation loop. Nothing used to run it outside tests, which meant TTL
  // hold releases (§7.4 W8), crashed-settle resumption (W1–W7) and stalled
  // pipeline runs (13.1) never happened in a live process — expired holds
  // simply leaked inventory forever.
  const sweeper = startSweepLoop({ db: pool, provider, config: settleConfig, clock });

  return {
    app,
    pool,
    close: async () => {
      sweeper.stop();
      await pool.end();
    },
  };
}

interface SweepLoopDeps {
  readonly db: PgPool;
  readonly provider: SettlementProvider;
  readonly config: SettlementConfig;
  readonly clock: SystemClock;
}

/**
 * One non-overlapping sweep every `sweepIntervalMs`. `unref()` keeps the timer
 * from holding the event loop open, and the in-flight latch keeps a slow sweep
 * from stacking on top of itself and exhausting the 10-connection pool.
 */
export function startSweepLoop(deps: SweepLoopDeps): { stop: () => void } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    const now = new Date(deps.clock.nowMs());
    try {
      await sweepExpiredReservations(deps.db);
      await runSweep(deps, now);
      const stalled = await sweepStalledProposals(deps.db, { now });
      if (stalled.length > 0) {
        console.warn(`[api] sweep closed ${stalled.length} stalled pipeline run(s): ${stalled.join(", ")}`);
      }
    } catch (err) {
      console.error("[api] sweep failed:", err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), deps.config.sweepIntervalMs);
  handle.unref();
  return { stop: () => clearInterval(handle) };
}

/**
 * Auto-start ONLY when this module IS the entry point.
 *
 * `NODE_ENV !== "test"` alone was not enough: any script that imports something
 * from here (say `buildProvider`, or the audit-verification script) booted a
 * server, opened a Postgres pool and called listen() as an import side effect,
 * which is how `npx tsx scripts/verify-vulnerabilities.ts` came to hang forever.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const asUrl = pathToFileURL(entry).href;
  // tsx/ts-node resolve the .ts source while import.meta.url may name the same
  // file; compare on the extension-stripped path so both forms agree.
  const strip = (u: string): string => u.replace(/\.(ts|js|mts|mjs|cts|cjs)$/, "");
  return strip(asUrl) === strip(import.meta.url);
}

if (isEntryPoint() && process.env.NODE_ENV !== "test") {
  // eslint-disable-next-line no-console
  console.log(greeting());
  buildServer()
    .then((srv) => {
      const server = srv.app.listen(PORT, HOST, () => {
        // eslint-disable-next-line no-console
        console.log(`[api] listening on ${HOST}:${PORT}`);
        if (!BIND_IS_LOOPBACK) {
          console.warn(
            "[api] WARNING: bound to a non-loopback interface. The admin/demo control plane " +
              "is loopback-gated and will refuse every remote or proxied request.",
          );
        }
      });
      // Without this, a port clash surfaces as an unhandled 'error' event and a
      // stack dump instead of the one line an operator actually needs.
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(`[api] cannot listen on ${HOST}:${PORT} — already in use. Set API_PORT.`);
        } else {
          console.error("[api] listen failed:", err.message);
        }
        process.exitCode = 1;
        void srv.close();
      });
    })
    .catch((err) => {

      console.error("[api] failed to start:", err instanceof Error ? err.stack ?? err.message : String(err));
      process.exitCode = 1;
    });
}
