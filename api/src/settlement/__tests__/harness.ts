/**
 * Settlement test harness: real Postgres + Redis from docker-compose, V7
 * migrations applied once per run, tables truncated between tests, a full
 * HTTP app (MockProvider signing REAL loopback webhooks through express.raw)
 * so integration tests exercise exactly the path production does.
 */
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { Redis } from "ioredis";
import {
  canonicalJson,
  digestView,
  type SettleableProposal,
  type SettlementLine,
} from "@growthagent/shared";
import { applyMigrations, createPool, type PgPool } from "../../db/client.js";
import { MemoryAuditSink, setAuditSink } from "../../audit/writer.js";
import { MOCK_DEV_WEBHOOK_SECRET, loadSettlementConfig, type SettlementConfig } from "../config.js";
import { SystemClock, type Clock } from "../clock.js";
import { MockProvider, type WebhookDelivery } from "../provider/mock.provider.js";
import { PgIdempotencyStore } from "../idempotency/pg-store.js";
import { RedisIdempotencyStore } from "../idempotency/redis-store.js";
import { buildSettlementApp } from "../routes.js";
import { settle } from "../settle.js";

export const REDIS_PORT = 16_379; // docker-compose host port
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, no I/L/O/U

let txCounter = 0;
/** 'tx_' + 26-char Crockford ULID-shaped id, unique within the process. */
export function newTxId(): string {
  txCounter += 1;
  let n = txCounter;
  let tail = "";
  for (let i = 0; i < 10; i++) {
    tail = ALPHABET[n % 32] + tail;
    n = Math.floor(n / 32);
  }
  return `tx_0000000000000000${tail}`.slice(0, "tx_".length + 26);
}

export function sha256HexOf(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface ProposalOverrides {
  readonly lines?: SettlementLine[];
  readonly totalPaise?: number;
  readonly approvalSource?: "GATEKEEPER_AUTO" | "HUMAN_ESCALATION";
  readonly withToken?: boolean;
}

export function makeProposal(o: ProposalOverrides = {}): SettleableProposal {
  const lines =
    o.lines ?? [{ sku: "SKU-A", qty: 2, unit_price_paise: 10_000 }];
  const p = {
    tx_id: newTxId(),
    proposal_id: `prop_${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 12)}`,
    proposal_sha256: "", // filled below — digest over the FINAL object
    lines,
    total_amount_paise:
      o.totalPaise ?? lines.reduce((s, l) => s + l.unit_price_paise * l.qty, 0),
    currency: "INR" as const,
    gatekeeper: {
      verdict: "APPROVE" as const,
      ruleset_version: 3,
      trace_digest: sha256HexOf(`trace-${Math.random()}`),
    },
    approval_source: o.approvalSource ?? ("GATEKEEPER_AUTO" as const),
    ...(o.withToken ? { approval_token: `tok_${sha256HexOf(String(Math.random()))}` } : {}),
  };
  return { ...p, proposal_sha256: sha256HexOf(canonicalJson(digestView(p as SettleableProposal))) };
}

export async function seedStock(db: PgPool, stock: Record<string, number>): Promise<void> {
  for (const [sku, qty] of Object.entries(stock)) {
    await db.query(
      `INSERT INTO inventory (sku, stock_qty) VALUES ($1, $2)
       ON CONFLICT (sku) DO UPDATE SET stock_qty = $2, reserved = 0, sold = 0`,
      [sku, qty],
    );
  }
}

/** Minimal transactions row for reserve-layer-only tests (FK target). */
export async function ensureTxRow(db: PgPool, txId: string): Promise<void> {
  await db.query(
    `INSERT INTO transactions
       (tx_id, state, proposal_bytes, proposal_sha256, approved_total_paise,
        ruleset_version, gatekeeper_trace_digest, approval_source, provider_kind, receipt)
     VALUES ($1,'PROPOSAL_APPROVED','{}'::jsonb,$2,100,1,$3,'GATEKEEPER_AUTO','mock',$4)
     ON CONFLICT (tx_id) DO NOTHING`,
    [txId, sha256HexOf(txId), sha256HexOf(`${txId}-trace`), `ga_${txId.slice(3)}`],
  );
}

export async function truncateAll(db: PgPool): Promise<void> {
  // ONE statement: the settlement tables form an FK-closed set (holds → tx +
  // inventory), and TRUNCATE only accepts that when everyone is listed.
  await db.query(`TRUNCATE transactions, stock_reservations, inventory,
                           identity_velocity, razorpay_orders,
                           processed_webhook_events, completed_sales,
                           idempotency_keys CASCADE`);
}

export async function getTxState(db: PgPool, txId: string): Promise<string | null> {
  const r = await db.query(`SELECT state FROM transactions WHERE tx_id=$1`, [txId]);
  return r.rowCount === 0 ? null : (r.rows[0].state as string);
}

export async function waitForTxState(
  db: PgPool,
  txId: string,
  want: string,
  timeoutMs = 8000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await getTxState(db, txId);
    if (s === want) return s;
    if (Date.now() > deadline) throw new Error(`waitForTxState(${txId}, ${want}): last=${s}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface TestSystem {
  readonly app: Express;
  readonly db: PgPool;
  readonly redis: Redis;
  readonly provider: MockProvider;
  readonly config: SettlementConfig;
  readonly clock: Clock;
  readonly sink: MemoryAuditSink;
  readonly deliveries: WebhookDelivery[];
  /** Loopback base URL once listen() resolved. */
  readonly baseUrl: () => string;
  close(): Promise<void>;
}

export async function startSystem(): Promise<TestSystem> {
  setAuditSink(new MemoryAuditSink());
  const sink = (await import("../../audit/writer.js")).getAuditSink() as MemoryAuditSink;

  const db = createPool();
  await db.query("SELECT 1"); // fail fast if compose stack is down
  await applyMigrations(db);
  const redis = new Redis({ port: REDIS_PORT, lazyConnect: false, maxRetriesPerRequest: 20 });
  await redis.ping();

  const config = loadSettlementConfig({ RAZORPAY_PROVIDER: "MOCK" });
  const clock = new SystemClock();
  const webhookSecret = config.webhookSecrets[0];
  if (!webhookSecret) throw new Error("no webhook secret configured"); // unreachable: loader guarantees [current]

  // Deliver signed letters over REAL loopback HTTP into the mounted raw route.
  const holder: { base: string } = { base: "" };
  const deliver = (d: WebhookDelivery): void => {
    void fetch(`${holder.base}${d.url}`, {
      method: "POST",
      headers: d.headers,
      body: d.rawBody,
    }).catch(() => {}); // loopback errors surface via tx-state assertions
  };
  const provider = new MockProvider({
    webhookSecret,
    clock,
    deliver,
  });

  const stores = {
    redis: new RedisIdempotencyStore(redis, config.idempotencyTtlMs),
    pg: new PgIdempotencyStore(db),
  };
  const deps = { db, provider, config, clock };
  const app = buildSettlementApp({
    db,
    settleDeps: deps,
    webhookDeps: deps,
    stores,
  });

  // Ephemeral listener — the loopback leg of the mock webhook path.
  const server: Server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  holder.base = `http://127.0.0.1:${addr.port}`;

  return {
    app,
    db,
    redis,
    provider,
    config,
    clock,
    sink,
    deliveries: provider.outbox,
    baseUrl: () => holder.base,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      redis.disconnect();
      await db.end();
    },
  };
}

/** Direct-settle helper for tests that bypass HTTP but need full pipeline. */
export const settleDirect = settle;

export { MOCK_DEV_WEBHOOK_SECRET };
