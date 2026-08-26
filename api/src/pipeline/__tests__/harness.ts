/**
 * Pipeline test harness: real Postgres from docker-compose (same instance the
 * settlement suites use), migrations V1..V8 applied once per run, pipeline +
 * settlement tables truncated between tests. The negotiation transport is a
 * stub the tests control — the stage boundary is exactly where LLM
 * determinism ends, so that is the only thing faked.
 */
import {
  MEERA_GT_V1,
  MEERA_RULES_V3,
  type AgentVelocitySnapshot,
  type EvidencePackContainer,
  type GroundTruthSnapshot,
} from "@growthagent/shared";
import { applyMigrations, createPool, type PgPool } from "../../db/client.js";
import { AuditChain, type ChainActor } from "../audit-chain.js";
import { systemActor } from "../emitter.js";
import type { Clock } from "../../settlement/clock.js";
import { SystemClock } from "../../settlement/clock.js";
import { loadSettlementConfig, type SettlementConfig } from "../../settlement/config.js";
import { MockProvider } from "../../settlement/provider/mock.provider.js";
import type { NegotiationTransport } from "../../negotiation/transport.types.js";
import type { NegotiationProposal } from "@growthagent/shared";
import { TraceBus, txChannel, type BusFrame } from "../bus.js";
import { PipelineEmitter } from "../emitter.js";
import type { PipelineDeps } from "../orchestrator.js";
import { buildEvidencePack } from "../evidence.js";

export const SIM_TODAY = "2026-08-26";
export const NOW_ISO = "2026-08-26T10:00:00.000Z";

let txCounter = 0;
/** Unique per-test tx id (pipeline PK claim makes replays of the same id fail).
 *  Must be a valid ULID-shaped id — settlement's `transactions.tx_id` carries a
 *  CHECK (`^tx_[0-9A-HJKMNP-TV-Z]{26}$`, V7), so a lax id passes the pipeline's
 *  own `proposal_txs` claim but explodes at the settlement INSERT. The buyer
 *  route (M8) mints the real ULID; here the counter drives a deterministic
 *  Crockford-base32 suffix so ids stay unique AND constraint-legal. */
export function nextTxId(): string {
  txCounter += 1;
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, no I/L/O/U
  let n = txCounter;
  let suffix = "";
  for (let i = 0; i < 26; i++) {
    suffix = ALPHABET[n % 32] + suffix;
    n = Math.floor(n / 32);
  }
  return `tx_${suffix}`;
}

export async function truncateAll(db: PgPool): Promise<void> {
  await db.query(`TRUNCATE audit_log, proposal_txs, approvals,
                           transactions, stock_reservations, inventory,
                           identity_velocity, razorpay_orders,
                           processed_webhook_events, completed_sales,
                           idempotency_keys CASCADE`);
}

/** Inventory rows for every GT sku so settlement can reserve. */
export async function seedInventory(db: PgPool): Promise<void> {
  for (const it of MEERA_GT_V1.items) {
    await db.query(
      `INSERT INTO inventory (sku, stock_qty) VALUES ($1, $2)
       ON CONFLICT (sku) DO UPDATE SET stock_qty = $2, reserved = 0, sold = 0`,
      [it.sku_id, it.stock_on_hand],
    );
  }
}

/** Deterministic pack over the fixture GT — the same builder INTAKE uses, so
 *  tests can look up evidence ids to cite in stub proposals. */
export function packFor(priorities: Parameters<typeof buildEvidencePack>[0]["priorities"] = []): EvidencePackContainer {
  return buildEvidencePack({ gt: MEERA_GT_V1, priorities, simToday: SIM_TODAY, nowIso: NOW_ISO });
}

export function emptyVelocity(agentId = "agent_test"): AgentVelocitySnapshot {
  const win = (seconds: 3600 | 86400) => ({
    window_seconds: seconds,
    window_end_iso: NOW_ISO,
    request_count: 0,
    approved_value_paise: 0,
  });
  return {
    status: "AVAILABLE",
    agent_identity_id: agentId,
    hour_window: win(3600),
    day_window: win(86400),
    prior_escalations_24h: 0,
    prior_declines_24h: 0,
    injection_flags_24h: 0,
    source: "redis_sliding_window_v1",
  };
}

/** A minimal honest proposal over GT items; claims cite real PRICE entries. */
export function makeProposal(items: { sku: string; qty: number }[], discountPct = 0): NegotiationProposal {
  const pack = packFor();
  const priceIdOf = (sku: string) =>
    `E${String(pack.entries.findIndex((e) => e.kind === "PRICE" && e.sku === sku) + 1).padStart(3, "0")}`;
  return {
    proposed_items: items.map((i) => ({ sku: i.sku, qty: i.qty })),
    bundle_discount_pct: discountPct,
    // The statement cites the SKU (stripped as a SKU-like token by the auditor)
    // so the ONLY numeric token is the rupee price — a human name like
    // "…500g" would leak a phantom COUNT token and fail an honest claim.
    claims: items.map((i) => ({
      statement: `${i.sku} is priced at ₹${(MEERA_GT_V1.items.find((g) => g.sku_id === i.sku)?.list_price_paise ?? 0) / 100}.`,
      evidence_ids: [priceIdOf(i.sku)],
      kind: "PRICE",
    })),
    customer_pitch:
      "A fresh chocolate truffle cake and a brownie box — a solid birthday combo at full menu price.",
    upsell_reasoning_summary:
      "Both items are in stock with healthy margin; no concession was needed to close this basket.",
    used_campaign_priority: false,
    campaign_priority_ids: [],
  };
}

export function okTransport(proposal: NegotiationProposal): NegotiationTransport {
  return {
    execute: async () => ({
      parsed_output: proposal,
      raw_text: JSON.stringify(proposal),
      thinking_summary: "",
      usage: null,
      stop_reason: "stop",
      latency_ms: 1,
      attempts: [],
    }),
  };
}

/** Model spoke but produced nothing parseable → PARSE_FAILED → fallback. */
export function unparseableTransport(): NegotiationTransport {
  return {
    execute: async () => ({
      parsed_output: null,
      raw_text: "<not json>",
      thinking_summary: "",
      usage: null,
      stop_reason: "stop",
      latency_ms: 1,
      attempts: [],
    }),
  };
}

export interface PipelineSystem {
  readonly db: PgPool;
  readonly chain: AuditChain;
  readonly bus: TraceBus;
  readonly emitter: PipelineEmitter;
  readonly provider: MockProvider;
  readonly config: SettlementConfig;
  readonly clock: Clock;
  /** Full deps object with per-test overrides applied. */
  readonly deps: PipelineDeps;
  close(): Promise<void>;
}

export async function startPipeline(
  overrides: Partial<PipelineDeps> & { groundTruth?: () => Promise<GroundTruthSnapshot> } = {},
): Promise<PipelineSystem> {
  const db = createPool();
  await db.query("SELECT 1"); // fail fast if compose stack is down
  await applyMigrations(db);

  const chain = new AuditChain(db);
  await chain.boot();
  const bus = new TraceBus();
  const emitter = new PipelineEmitter(chain, bus, 3);
  const clock = new SystemClock();
  const config = loadSettlementConfig({ RAZORPAY_PROVIDER: "MOCK" });
  const provider = new MockProvider({ webhookSecret: config.webhookSecrets[0]!, clock });

  const deps: PipelineDeps = {
    db,
    clock,
    chain,
    emitter,
    // Tests override this; a missing stub must fail loudly, not silently.
    transport: { execute: () => Promise.reject(new Error("no transport configured in test")) },
    groundTruth: async () => MEERA_GT_V1,
    priorities: async () => [],
    rules: () => MEERA_RULES_V3,
    velocity: undefined,
    provider,
    settleConfig: config,
    reserveVelocity: undefined,
    approvalTtlMs: 60_000,
    ...overrides,
  };

  return {
    db,
    chain,
    bus,
    emitter,
    provider,
    config,
    clock,
    deps,
    close: async () => {
      await db.end();
    },
  };
}

/** Subscribe before running a tx; returns the durable envelopes in arrival
 *  order (the SSE stream's view of the run). */
export function collectFrames(
  bus: TraceBus,
  txId: string,
): { envelopes: () => BusFrame[]; unsubscribe: () => void } {
  const got: BusFrame[] = [];
  const off = bus.subscribe(txChannel(txId), (f) => got.push(f));
  return { envelopes: () => got, unsubscribe: off };
}

/* -------------------- shared singleton pool for DB specs ------------------ */

/** One pool for all DB-backed specs in this directory (vitest runs files
 *  sequentially — see vitest.config.ts). pg.Pool connects lazily, so merely
 *  importing this file opens nothing. */
export const db: PgPool = createPool();

export async function closeDb(): Promise<void> {
  await db.end();
}

export function mkAppend(
  txId: string,
  event: string,
  actor: ChainActor = testActor(),
  payload: Record<string, unknown> = {},
): Parameters<AuditChain["append"]>[0] {
  return {
    tx_id: txId,
    ts: NOW_ISO,
    actor,
    rules_version: 3,
    event,
    payload,
  };
}

export const testActor = (): ChainActor => systemActor("test", "SYSTEM");
