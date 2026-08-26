/**
 * GrowthAgent API entrypoint — M8 composition root.
 *
 * `greeting()` stays (M0 toolchain smoke). `buildServer()` is the real root:
 * pool → migrations → audit chain boot → TraceBus + emitter → pipeline deps →
 * the `enqueue`/`buildMandate` seams → `buildApiApp`. A guarded `listen` runs
 * it only when invoked directly (never under vitest).
 *
 * The negotiation transport is live NIM when NVIDIA_API_KEY is set, else a
 * loud-reject stub (the pipeline degrades to its deterministic fallback per
 * negotiation §3) — so the server boots for demos without a key present.
 */
import {
  SHARED_PACKAGE_VERSION,
  MEERA_GT_V1,
  MEERA_RULES_V3,
  type CampaignPriorityPayload,
} from "@growthagent/shared";
import type { Express } from "express";
import { applyMigrations, createPool, type PgPool } from "./db/client.js";
import { AuditChain } from "./pipeline/audit-chain.js";
import { TraceBus } from "./pipeline/bus.js";
import { PipelineEmitter } from "./pipeline/emitter.js";
import { runPipeline, type PipelineDeps, type RunInput } from "./pipeline/orchestrator.js";
import { SystemClock } from "./settlement/clock.js";
import { loadSettlementConfig } from "./settlement/config.js";
import { MockProvider } from "./settlement/provider/mock.provider.js";
import { LiveNimTransport } from "./negotiation/transport.nim.live.js";
import type { NegotiationTransport } from "./negotiation/transport.types.js";
import { buildApiApp } from "./http/app.js";
import { buildCartMandate, DEFAULT_MANDATE_TTL_MS, DEV_MERCHANT_SIGNING_SECRET } from "./http/mandate-builder.js";

const PORT = Number(process.env.API_PORT ?? 3000);
const RULES_VERSION = 3; // matches the emitter/audit rules_version stamped this build
const DEV_TICKET_SECRET = "ga-stream-ticket-secret-dev-only";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

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

export async function buildServer(): Promise<ApiServer> {
  const pool = createPool();
  await pool.query("SELECT 1");
  await applyMigrations(pool);

  const chain = new AuditChain(pool);
  await chain.boot();
  const bus = new TraceBus();
  const emitter = new PipelineEmitter(chain, bus, () => RULES_VERSION);
  const clock = new SystemClock();
  const settleConfig = loadSettlementConfig(process.env);
  const provider = new MockProvider({ webhookSecret: settleConfig.webhookSecrets[0]!, clock });

  const pipelineDeps: PipelineDeps = {
    db: pool,
    clock,
    chain,
    emitter,
    transport: buildTransport(),
    narrator: undefined,
    groundTruth: async () => MEERA_GT_V1,
    priorities: async (): Promise<readonly CampaignPriorityPayload[]> => [],
    rules: () => MEERA_RULES_V3,
    velocity: undefined,
    provider,
    settleConfig,
    reserveVelocity: undefined,
    approvalTtlMs: DEFAULT_MANDATE_TTL_MS,
  };

  const signingSecret = resolveSigningSecret("MERCHANT_SIGNING_SECRET", DEV_MERCHANT_SIGNING_SECRET);
  const ticketSecret = resolveSigningSecret("STREAM_TICKET_SECRET", DEV_TICKET_SECRET);

  const app = buildApiApp({
    db: pool,
    bus,
    chain,
    nowMs: () => clock.nowMs(),
    rulesVersion: () => RULES_VERSION,
    // Fire the pipeline detached; a crash is logged, never unhandled (§5.1).
    enqueue: (input: RunInput) => {
      void runPipeline(pipelineDeps, input).catch((err) => {
         
        console.error(`[api] pipeline run failed for ${input.tx_id}:`, err instanceof Error ? err.stack ?? err.message : String(err));
      });
    },
    buildMandate: (txId: string) =>
      buildCartMandate({ db: pool, groundTruth: async () => MEERA_GT_V1, nowMs: () => clock.nowMs(), signingSecret }, txId),
    ticketSecret,
  });

  return {
    app,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

if (process.env.NODE_ENV !== "test" && process.env.API_START === "1") {
  // eslint-disable-next-line no-console
  console.log(greeting());
  buildServer()
    .then((srv) => {
      srv.app.listen(PORT, () => {
        // eslint-disable-next-line no-console
        console.log(`[api] listening on :${PORT}`);
      });
    })
    .catch((err) => {
       
      console.error("[api] failed to start:", err instanceof Error ? err.stack ?? err.message : String(err));
      process.exitCode = 1;
    });
}
