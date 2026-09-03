/**
 * api/src/http/__tests__/harness.ts — real-stack HTTP harness.
 *
 * Boots the ACTUAL buyer API (buildApiApp) over a real Postgres + the real
 * pipeline, listening on an ephemeral port; tests drive it with loopback fetch
 * (supertest is not a dep). The only faked seam is the negotiation transport —
 * exactly where LLM determinism ends — so POST→pipeline→poll exercises every
 * real stage, gatekeeper, and settlement write.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness deals in loosely-typed JSON response bodies */
import { MEERA_GT_V1, type CampaignPriorityPayload, type MerchantRulesConfig } from "@growthagent/shared";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { applyMigrations, createPool, type PgPool } from "../../db/client.js";
import { AuditChain } from "../../pipeline/audit-chain.js";
import { TraceBus } from "../../pipeline/bus.js";
import { PipelineEmitter } from "../../pipeline/emitter.js";
import { runPipeline, resumeAfterApproval, rejectAfterRejection, type PipelineDeps, type RunInput, type ResolveDeps } from "../../pipeline/orchestrator.js";
import { failRunNow } from "../../pipeline/stall-sweeper.js";
import { RulesStore } from "../../rules/store.js";
import { SystemClock } from "../../settlement/clock.js";
import { loadSettlementConfig } from "../../settlement/config.js";
import { MockProvider } from "../../settlement/provider/mock.provider.js";
import type { NegotiationTransport } from "../../negotiation/transport.types.js";
import { buildApiApp } from "../app.js";
import { buildCartMandate, DEV_MERCHANT_SIGNING_SECRET } from "../mandate-builder.js";
import { sha256Hex } from "../crypto.js";
import { ChaosController } from "../chaos-controller.js";

export const TICKET_SECRET = "ga-stream-ticket-secret-test";
export const RULES_VERSION = 3;
export const ADMIN_TOKEN = "ga-admin-token-test";

export const BUYER_KEY = "gak_buyer_test_key_0001";
export const BUYER_AGENT_ID = "buyer_test";
export const OTHER_KEY = "gak_buyer_test_key_0002";
export const OTHER_AGENT_ID = "buyer_other";

export interface ApiHarness {
  readonly base: string;
  readonly db: PgPool;
  readonly bus: TraceBus;
  readonly chain: AuditChain;
  readonly chaos: ChaosController;
  close(): Promise<void>;
}

async function seedAgents(db: PgPool): Promise<void> {
  for (const [id, key] of [[BUYER_AGENT_ID, BUYER_KEY], [OTHER_AGENT_ID, OTHER_KEY]] as const) {
    await db.query(
      `INSERT INTO agent_identities (agent_id, display_name, role, api_key_hash, api_key_prefix)
       VALUES ($1,$2,'buyer_agent',$3,$4)
       ON CONFLICT (agent_id) DO UPDATE SET api_key_hash=$3, revoked_at=NULL`,
      [id, id, sha256Hex(key), key.slice(0, 12)],
    );
  }
}

async function seedInventory(db: PgPool): Promise<void> {
  for (const it of MEERA_GT_V1.items) {
    await db.query(
      `INSERT INTO inventory (sku, stock_qty) VALUES ($1,$2)
       ON CONFLICT (sku) DO UPDATE SET stock_qty=$2, reserved=0, sold=0`,
      [it.sku_id, it.stock_on_hand],
    );
  }
}

async function truncate(db: PgPool): Promise<void> {
  await db.query(`TRUNCATE audit_log, proposal_txs, approvals, proposal_idempotency, cart_mandates,
                           transactions, stock_reservations, inventory, identity_velocity,
                           razorpay_orders, processed_webhook_events, completed_sales,
                           idempotency_keys, agent_identities, merchant_rules CASCADE`);
}

export interface ApiOverrides {
  readonly transport: NegotiationTransport;
  readonly velocity?: PipelineDeps["velocity"];
  readonly heartbeatMs?: number;
  readonly terminalPollMs?: number;
  /** Transport-layer knobs the audit-remediation specs drive (H5, 9.3, 8.4). */
  readonly rateLimit?: { readonly capacity: number; readonly refillPerSec: number };
  readonly authFailureLimit?: { readonly maxFailures: number; readonly refillPerSec: number };
  readonly maxStreams?: number;
  readonly maxStreamsPerAgent?: number;
  readonly allowedOrigins?: readonly string[];
}

export async function startApi(overrides: ApiOverrides): Promise<ApiHarness> {
  const db = createPool();
  await db.query("SELECT 1");
  await applyMigrations(db);
  await truncate(db);
  await seedAgents(db);
  await seedInventory(db);

  // Rules read THROUGH Postgres, same as server.ts. ttlMs:0 makes every gate
  // entry re-read, so a test that PUTs rules sees the change on the next run
  // without sleeping past a cache window.
  const rulesStore = new RulesStore(db, { ttlMs: 0 });
  await rulesStore.boot();

  const chain = new AuditChain(db);
  await chain.boot();
  const bus = new TraceBus();
  const emitter = new PipelineEmitter(chain, bus, () => rulesStore.version());
  const clock = new SystemClock();
  const chaos = new ChaosController(() => clock.nowMs());
  const settleConfig = loadSettlementConfig({ RAZORPAY_PROVIDER: "MOCK" });
  const provider = new MockProvider({ webhookSecret: settleConfig.webhookSecrets[0]!, clock });

  const pipelineDeps: PipelineDeps = {
    db,
    clock,
    chain,
    emitter,
    transport: overrides.transport,
    narrator: undefined,
    groundTruth: async () => MEERA_GT_V1,
    priorities: async (): Promise<readonly CampaignPriorityPayload[]> => [],
    rules: () => rulesStore.load(),
    velocity: overrides.velocity,
    provider,
    settleConfig,
    reserveVelocity: undefined,
    approvalTtlMs: 60_000,
  };

  const resolveDeps: ResolveDeps = { db, clock, chain, emitter, provider, settleConfig };

  const app = buildApiApp({
    db,
    bus,
    chain,
    nowMs: () => clock.nowMs(),
    rulesVersion: () => rulesStore.version(),
    enqueue: (input: RunInput) => {
      void runPipeline(pipelineDeps, input).catch((err) => {
        console.error(`[test-api] pipeline failed for ${input.tx_id}:`, err instanceof Error ? err.message : err);
        void failRunNow(db, input.tx_id, { reason: "PIPELINE_ERROR", retryable: true }).catch(() => undefined);
      });
    },
    buildMandate: (txId: string) =>
      buildCartMandate(
        { db, groundTruth: async () => MEERA_GT_V1, nowMs: () => clock.nowMs(), signingSecret: DEV_MERCHANT_SIGNING_SECRET },
        txId,
      ),
    ticketSecret: TICKET_SECRET,
    // Admin/demo control plane: enforce the real §4.3 matrix in tests (token
    // required, insecure hatch OFF) — the harness listens on loopback so the
    // IP check passes and only the X-Admin-Token gate is exercised.
    adminToken: ADMIN_TOKEN,
    allowInsecureAdmin: false,
    resumeApproval: (a) => {
      return resumeAfterApproval(resolveDeps, a).catch((err) => {
        console.error(`[test-api] resume failed for ${a.approval_id}:`, err instanceof Error ? err.message : err);
        return { already: false };
      });
    },
    rejectApproval: (a) => {
      return rejectAfterRejection(resolveDeps, a).catch((err) => {
        console.error(`[test-api] reject failed for ${a.approval_id}:`, err instanceof Error ? err.message : err);
        return { already: false };
      });
    },
    getCurrentRules: () => rulesStore.load(),
    onRulesUpdated: (newRules: MerchantRulesConfig) => { rulesStore.set(newRules); },
    chaos,
    heartbeatMs: overrides.heartbeatMs,
    terminalPollMs: overrides.terminalPollMs ?? 100,
    rateLimit: overrides.rateLimit,
    authFailureLimit: overrides.authFailureLimit,
    maxStreams: overrides.maxStreams,
    maxStreamsPerAgent: overrides.maxStreamsPerAgent,
    allowedOrigins: overrides.allowedOrigins,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    db,
    bus,
    chain,
    chaos,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.end();
    },
  };
}

/** POST a proposal; returns the parsed 202 body (or the error body + status). */
export async function postProposal(
  base: string,
  key: string | null,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (key !== null) headers["X-Agent-Key"] = key;
  const res = await fetch(`${base}/v1/carts/proposals`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

export async function poll(
  base: string,
  key: string,
  txId: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/v1/carts/proposals/${txId}`, { headers: { "X-Agent-Key": key } });
  return { status: res.status, json: await res.json() };
}

/** Poll until the tx reaches a TERMINAL status body, or throw after timeout. */
export async function pollUntilTerminal(
  base: string,
  key: string,
  txId: string,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await poll(base, key, txId);
    if (json?.status === "TERMINAL") return json;
    if (Date.now() > deadline) throw new Error(`tx ${txId} never went terminal (last=${JSON.stringify(json)})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A minimal valid CreateProposalRequest body. */
export function proposalBody(idempotencyKey: string, note = "Please put together a nice birthday cake order."): unknown {
  return {
    idempotency_key: idempotencyKey,
    customer_request: {
      natural_language: "A birthday cake for this weekend",
      occasion: "birthday",
      budget_paise: 500_000,
    },
    untrusted: { customer_note: note },
  };
}

/** Admin GET with an (optional) X-Admin-Token. Omit `token` to send none. */
export async function adminGet(
  base: string,
  path: string,
  token: string | null = ADMIN_TOKEN,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (token !== null) headers["X-Admin-Token"] = token;
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, json: await res.json() };
}

/** Admin POST with a JSON body and an (optional) X-Admin-Token. */
export async function adminPost(
  base: string,
  path: string,
  body: unknown = {},
  token: string | null = ADMIN_TOKEN,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["X-Admin-Token"] = token;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** Admin PUT with a JSON body and an (optional) X-Admin-Token. */
export async function adminPut(
  base: string,
  path: string,
  body: unknown = {},
  token: string | null = ADMIN_TOKEN,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["X-Admin-Token"] = token;
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** Admin DELETE with an (optional) X-Admin-Token. */
export async function adminDelete(
  base: string,
  path: string,
  token: string | null = ADMIN_TOKEN,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (token !== null) headers["X-Admin-Token"] = token;
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers,
  });
  return { status: res.status, json: await res.json() };
}
