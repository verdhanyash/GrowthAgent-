/**
 * §15.4 — idempotency layers. Layer 1 runs over real Redis + PG; layer 2's
 * crash windows run against a scripted provider; layer 3 dedupe semantics
 * ride the integration suite's HTTP path (covered there).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { applyMigrations, createPool, type PgPool } from "../db/client.js";
import { MemoryAuditSink, setAuditSink } from "../audit/writer.js";
import { PgIdempotencyStore } from "./idempotency/pg-store.js";
import { RedisIdempotencyStore } from "./idempotency/redis-store.js";
import { bodyHashOf } from "./idempotency/middleware.js";
import { ensureOrder, OrderAmbiguityError } from "./ensure-order.js";
import {
  DuplicateReceiptError,
  ProviderUnavailableError,
  type SettlementOrderHandle,
} from "./provider/types.js";
import { makeProposal, sha256HexOf, truncateAll } from "./__tests__/harness.js";

let db: PgPool;
let redis: Redis;
let pgStore: PgIdempotencyStore;
const TTL = 86_400_000;

beforeAll(async () => {
  setAuditSink(new MemoryAuditSink());
  db = createPool();
  await applyMigrations(db);
  redis = new Redis({ port: 16_379 });
  pgStore = new PgIdempotencyStore(db);
});

afterAll(async () => {
  redis.disconnect();
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
  await redis.flushdb();
});

describe("layer 1 — Redis store", () => {
  it("same key sequential ×2: acquire, finalize DONE, second get returns snapshot", async () => {
    const store = new RedisIdempotencyStore(redis, TTL);
    const key = crypto.randomUUID();
    const hash = bodyHashOf({ a: 1 });

    expect(await store.acquireInFlight(key, hash)).toBe(true);
    expect(await store.acquireInFlight(key, hash)).toBe(false); // NX holds
    expect(await store.finalizeDone(key, hash, 201, { tx_id: "tx_X" })).toBe(true);
    // Pathological re-finalize must NOT overwrite a DONE snapshot.
    expect(await store.finalizeDone(key, hash, 500, { broken: true })).toBe(false);
    const snap = await store.get(key);
    expect(snap).toMatchObject({ phase: "DONE", status: 201 });
    expect(snap?.body).toEqual({ tx_id: "tx_X" });
  });

  it("release clears a failed start so the same key can retry cleanly", async () => {
    const store = new RedisIdempotencyStore(redis, TTL);
    const key = crypto.randomUUID();
    const hash = bodyHashOf({ b: 2 });
    await store.acquireInFlight(key, hash);
    await store.release(key);
    expect(await store.acquireInFlight(key, hash)).toBe(true);
  });

  it("key reuse after TTL behaves as fresh execution (documented semantic)", async () => {
    const shortTtl = new RedisIdempotencyStore(redis, 30); // 30 ms
    const key = crypto.randomUUID();
    const hash = bodyHashOf({ c: 3 });
    await shortTtl.acquireInFlight(key, hash);
    await new Promise((r) => setTimeout(r, 80)); // past PX
    expect(await shortTtl.acquireInFlight(key, hash)).toBe(true);
  });

  it("PG twin save is first-writer-wins and lookupDone matches on request hash", async () => {
    const key = crypto.randomUUID();
    expect(await pgStore.save({ key, requestHash: "h1", txId: null, status: 201, body: { ok: 1 } })).toBe(true);
    expect(await pgStore.save({ key, requestHash: "h1", txId: null, status: 500, body: { bad: 1 } })).toBe(false);
    expect(await pgStore.lookupDone(key, "h1")).toEqual({ status: 201, body: { ok: 1 } });
    expect(await pgStore.lookupDone(key, "h2")).toBeNull(); // different body hash
  });

  it("Redis down → degraded-read replays from the durable PG row", async () => {
    // A dead port: connection refused ⇒ every command throws quickly.
    const dead = new Redis({
      port: 59_999,
      connectTimeout: 300,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      lazyConnect: false,
    });
    dead.on("error", () => {}); // expected ECONNREFUSED noise — asserted via rejections below
    try {
      const key = crypto.randomUUID();
      const hash = bodyHashOf({ d: 4 });
      await pgStore.save({ key, requestHash: hash, txId: "tx_Z", status: 201, body: { replayed: true } });
      const deadStore = new RedisIdempotencyStore(dead, TTL);
      await expect(deadStore.acquireInFlight(key, hash)).rejects.toThrow();
      // The middleware's fail-closed path consults this BEFORE refusing:
      const degraded = await pgStore.lookupDone(key, hash);
      expect(degraded).toEqual({ status: 201, body: { replayed: true } });
    } finally {
      dead.disconnect();
    }
  });
});

describe("layer 2 — receipt-guarded order creation", () => {
  class ScriptedProvider {
    readonly kind = "mock" as const;
    readonly receipts: string[] = [];
    private script: (() => never | void)[] = [];
    queue(fn: () => never | void): void {
      this.script.push(fn);
    }
    async createOrder(req: {
      tx_id: string;
      receipt: string;
      amount_paise: number;
      currency: "INR";
      notes: Record<string, string>;
    }): Promise<SettlementOrderHandle> {
      this.receipts.push(req.receipt);
      const fn = this.script.shift();
      if (fn) fn();
      return {
        provider: "mock",
        rzp_order_id: `order_mock_${this.receipts.length}`,
        receipt: req.receipt,
        amount_paise: req.amount_paise,
        currency: "INR",
        provider_status: "created",
      };
    }
    verifyAndParseWebhook(): never {
      throw new Error("not used in this suite");
    }
  }

  /** A tx parked mid-pipeline at a chosen state (ensureOrder doesn't touch
   *  inventory — only the transactions/razorpay_orders pair matters here). */
  async function seedTxIn(state: string): Promise<{ txId: string; proposal: ReturnType<typeof makeProposal> }> {
    const proposal = makeProposal();
    await db.query(
      `INSERT INTO transactions (tx_id, state, proposal_bytes, proposal_sha256,
         approved_total_paise, ruleset_version, gatekeeper_trace_digest,
         approval_source, provider_kind, receipt)
       VALUES ($1,$2,$3,$4,29900,3,$6,'GATEKEEPER_AUTO','mock',$5)`,
      [
        proposal.tx_id,
        state,
        JSON.stringify(proposal),
        proposal.proposal_sha256,
        `ga_${proposal.tx_id.slice(3)}`,
        sha256HexOf(`trace-${proposal.tx_id}`), // column CHECK demands 64 hex
      ],
    );
    return { txId: proposal.tx_id, proposal };
  }

  it("crash after intent row, retry: SAME receipt reused, exactly one provider order (W3)", async () => {
    const { txId, proposal } = await seedTxIn("STOCK_RESERVED");

    const provider = new ScriptedProvider();
    provider.queue(() => {
      throw new ProviderUnavailableError("simulated crash after intent persisted");
    });

    // Attempt 1: claims ORDER_CREATING, persists INTENT, then "crashes".
    await expect(ensureOrder(provider, db, proposal)).rejects.toThrow(ProviderUnavailableError);
    const mid = await db.query(`SELECT status FROM razorpay_orders WHERE tx_id=$1`, [txId]);
    expect(mid.rows[0].status).toBe("INTENT");

    // Sweep-style retry with skipClaim (state already ORDER_CREATING).
    const handle = await ensureOrder(provider, db, proposal, { skipClaim: true });
    expect(handle).not.toBeNull();
    expect(provider.receipts).toHaveLength(2);
    expect(provider.receipts[0]).toBe(provider.receipts[1]); // SAME receipt both times
    const orders = await db.query(`SELECT count(*)::int n FROM razorpay_orders`);
    expect(orders.rows[0].n).toBe(1); // one intent row, now CREATED
    const final = await db.query(`SELECT status, rzp_order_id FROM razorpay_orders WHERE tx_id=$1`, [txId]);
    expect(final.rows[0].status).toBe("CREATED");
    expect(final.rows[0].rzp_order_id).toMatch(/^order_mock_/);
  });

  it("provider saw the receipt but handle was lost → DuplicateReceiptError → AMBIGUOUS, never a blind third attempt", async () => {
    const { proposal } = await seedTxIn("ORDER_CREATING");
    const txId = proposal.tx_id;
    const provider = new ScriptedProvider();
    provider.queue(() => {
      throw new DuplicateReceiptError("receipt already exists for another order");
    });

    await expect(ensureOrder(provider, db, proposal, { skipClaim: true })).rejects.toThrow(
      OrderAmbiguityError,
    );
    const row = await db.query(`SELECT status FROM razorpay_orders WHERE tx_id=$1`, [txId]);
    expect(row.rows[0].status).toBe("AMBIGUOUS");
    // A further retry refuses immediately WITHOUT calling the provider again.
    const callsBefore = provider.receipts.length;
    await expect(ensureOrder(provider, db, proposal, { skipClaim: true })).rejects.toThrow(
      OrderAmbiguityError,
    );
    expect(provider.receipts.length).toBe(callsBefore); // no blind retry happened
  });

  it("claim-first CAS: concurrent creators contend, exactly one reaches the network", async () => {
    const { txId, proposal } = await seedTxIn("STOCK_RESERVED");
    const provider = new ScriptedProvider();
    const [a, b] = await Promise.all([
      ensureOrder(provider, db, proposal),
      ensureOrder(provider, db, proposal),
    ]);
    const handles = [a, b].filter((h) => h !== null);
    expect(handles).toHaveLength(1); // one creator elected…
    expect(provider.receipts).toHaveLength(1); // …exactly one network call
    const st = await db.query(`SELECT state FROM transactions WHERE tx_id=$1`, [txId]);
    expect(st.rows[0]?.state).toBe("AWAITING_PAYMENT");
  });
});
