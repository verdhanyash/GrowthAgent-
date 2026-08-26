/**
 * §15.2 — reservation core. Real Postgres; includes the 20-worker last-unit
 * race, the fast-check invariant property over randomized
 * reserve/commit/release interleavings, TTL expiry reclaim, and the velocity
 * ceiling upsert (TB-2b).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyMigrations,
  createPool,
  type PgPool,
} from "../db/client.js";
import { MemoryAuditSink, setAuditSink } from "../audit/writer.js";
import {
  InsufficientStockError,
  VelocityLimitExceededError,
  reReserveExpiredHolds,
  releaseHolds,
  reserveCart,
} from "./reserve.js";
import { ensureTxRow, newTxId, seedStock, truncateAll } from "./__tests__/harness.js";

let db: PgPool;
const NOW = new Date("2026-08-26T10:00:00Z");
const TTL = 900_000;

beforeAll(async () => {
  setAuditSink(new MemoryAuditSink());
  db = createPool();
  await applyMigrations(db);
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function counters(sku: string): Promise<{ stock_qty: number; reserved: number; sold: number }> {
  const r = await db.query(
    `SELECT stock_qty, reserved, sold FROM inventory WHERE sku=$1`,
    [sku],
  );
  if (r.rowCount === 0) return { stock_qty: -1, reserved: -1, sold: -1 };
  return r.rows[0];
}

describe("reserveCart", () => {
  it("plain success: stock 10, buy 3 → reserved 3, available 7", async () => {
    await seedStock(db, { "SKU-A": 10 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-A", qty: 3 }], TTL, NOW);
    expect(await counters("SKU-A")).toMatchObject({ stock_qty: 10, reserved: 3, sold: 0 });
  });

  it("exactly-at-limit boundary: stock 3, buy 3 succeeds with available 0 (§14.1)", async () => {
    await seedStock(db, { "SKU-B": 3 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-B", qty: 3 }], TTL, NOW);
    expect(await counters("SKU-B")).toMatchObject({ reserved: 3 }); // available 0
  });

  it("one-past-limit: stock 3, buy 4 refuses, reserved untouched", async () => {
    await seedStock(db, { "SKU-C": 3 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await expect(
      reserveCart(db, txId, [{ sku: "SKU-C", qty: 4 }], TTL, NOW),
    ).rejects.toThrow(InsufficientStockError);
    expect(await counters("SKU-C")).toMatchObject({ stock_qty: 3, reserved: 0 });
  });

  it("multi-line partial failure: line 3 of 4 unreservable rolls back lines 1–2 atomically (§14.3)", async () => {
    await seedStock(db, { "SKU-D1": 5, "SKU-D2": 5, "SKU-D3": 1 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await expect(
      reserveCart(
        db,
        txId,
        [
          { sku: "SKU-D1", qty: 2 },
          { sku: "SKU-D2", qty: 5 },
          { sku: "SKU-D3", qty: 999 }, // larger than ever produced (§14.2)
        ],
        TTL,
        NOW,
      ),
    ).rejects.toThrow(InsufficientStockError);
    expect(await counters("SKU-D1").then((c) => c.reserved)).toBe(0);
    expect(await counters("SKU-D2").then((c) => c.reserved)).toBe(0);
    expect(await counters("SKU-D3").then((c) => c.reserved)).toBe(0);
    const holds = await db.query(`SELECT count(*)::int n FROM stock_reservations WHERE tx_id=$1`, [txId]);
    expect(holds.rows[0].n).toBe(0); // rolled back rows too
  });

  it("concurrent last-unit race: exactly 1 winner of 20, invariant intact, no deadlock (§15.2)", async () => {
    await seedStock(db, { "SKU-RACE": 1 });
    const contenders = Array.from({ length: 20 }, () => newTxId());
    for (const txId of contenders) await ensureTxRow(db, txId);
    const results = await Promise.allSettled(
      contenders.map((txId) =>
        reserveCart(db, txId, [{ sku: "SKU-RACE", qty: 1 }], TTL, NOW),
      ),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(await counters("SKU-RACE")).toMatchObject({ stock_qty: 1, reserved: 1 });
  });

  it("velocity ceilings: N racing approvals cannot jointly exceed count/day or value/day (TB-2b)", async () => {
    await seedStock(db, { "SKU-VEL": 100 });
    const contenders = Array.from({ length: 6 }, () => newTxId());
    for (const txId of contenders) await ensureTxRow(db, txId);
    const identity = "hash-vel-1";
    const results = await Promise.allSettled(
      contenders.map((txId) =>
        reserveCart(db, txId, [{ sku: "SKU-VEL", qty: 1 }], TTL, NOW, {
          identityHash: identity,
          amountPaise: 10_000,
          maxTxPerIdentityPerDay: 4,
          maxValuePerIdentityPerDayPaise: 50_000,
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(4); // ceiling = maxTx 4
    const vel = await db.query(`SELECT approved_count, approved_paise FROM identity_velocity WHERE identity_hash=$1`, [identity]);
    expect(vel.rows[0]?.approved_count).toBe(4);
    expect(Number(vel.rows[0]?.approved_paise)).toBe(40_000); // BIGINT → string over the wire
  });

  it("velocity value-ceiling refusal audits velocity.limit_exceeded", async () => {
    const sink = (await import("../audit/writer.js")).getAuditSink() as MemoryAuditSink;
    await seedStock(db, { "SKU-VEL2": 10 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await expect(
      reserveCart(db, txId, [{ sku: "SKU-VEL2", qty: 1 }], TTL, NOW, {
        identityHash: "hash-vel-2",
        amountPaise: 99_000,
        maxTxPerIdentityPerDay: 10,
        maxValuePerIdentityPerDayPaise: 50_000,
      }),
    ).rejects.toThrow(VelocityLimitExceededError);
    expect(await counters("SKU-VEL2").then((c) => c.reserved)).toBe(0); // whole cart rolled back
    expect(sink.count(txId, "velocity.limit_exceeded")).toBe(1);
  });
});

describe("release + expiry", () => {
  it("double release is a noop (status CAS admits one winner)", async () => {
    await seedStock(db, { "SKU-REL": 4 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-REL", qty: 2 }], TTL, NOW);
    const first = await releaseHolds(db, txId, "PAYMENT_FAILED");
    const second = await releaseHolds(db, txId, "PAYMENT_FAILED");
    expect(first).toBe(2);
    expect(second).toBe(0);
    expect(await counters("SKU-REL")).toMatchObject({ stock_qty: 4, reserved: 0 });
  });

  it("TTL expiry reclaim restores reserved exactly (sweeper pass 2)", async () => {
    await seedStock(db, { "SKU-TTL": 6 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-TTL", qty: 4 }], TTL, NOW);
    // Expiry pass 1 only flips txs awaiting payment — park it there first.
    await db.query(`UPDATE transactions SET state='AWAITING_PAYMENT' WHERE tx_id=$1`, [txId]);
    const { sweepExpiredReservations } = await import("./sweeper.js");
    // Backdate the hold past its TTL relative to the DB's real clock (a fixed
    // test NOW collides with today), then sweep.
    await db.query(
      `UPDATE stock_reservations SET expires_at = now() - interval '1 ms' WHERE tx_id=$1`,
      [txId],
    );
    const expired = await sweepExpiredReservations(db);
    expect(expired).toContain(txId);
    expect(await counters("SKU-TTL")).toMatchObject({ reserved: 0, stock_qty: 6 });
    const state = await db.query(`SELECT state FROM transactions WHERE tx_id=$1`, [txId]);
    expect(state.rows[0].state).toBe("EXPIRED"); // pass 1 flipped the tx promptly
  });

  it("grace re-resurrection reuses the SAME hold row (UNIQUE tx_id,sku) under the guarded UPDATE", async () => {
    await seedStock(db, { "SKU-GRACE": 2 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-GRACE", qty: 2 }], TTL, NOW);
    await db.query(`UPDATE stock_reservations SET status='EXPIRED', released_at=now() WHERE tx_id=$1`, [txId]);
    await db.query(`UPDATE inventory SET reserved=0 WHERE sku='SKU-GRACE'`); // expiry released the counters

    const ok = await reReserveExpiredHolds(db, txId, TTL, NOW);
    expect(ok).toBe(true);
    expect(await counters("SKU-GRACE")).toMatchObject({ stock_qty: 2, reserved: 2 });
    const status = await db.query(`SELECT status FROM stock_reservations WHERE tx_id=$1`, [txId]);
    expect(status.rows[0].status).toBe("ACTIVE"); // same row resurrected — not a second one
  });

  it("grace resurrection loses the stock race cleanly: everything stays expired", async () => {
    await seedStock(db, { "SKU-GRACE2": 2 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-GRACE2", qty: 2 }], TTL, NOW);
    await db.query(`UPDATE stock_reservations SET status='EXPIRED', released_at=now() WHERE tx_id=$1`, [txId]);
    await db.query(`UPDATE inventory SET reserved=0`);
    // A competing buyer took the stock in between:
    const rival = newTxId();
    await ensureTxRow(db, rival);
    await db.query(`UPDATE inventory SET stock_qty=0 WHERE sku='SKU-GRACE2'`);

    const ok = await reReserveExpiredHolds(db, txId, TTL, NOW);
    expect(ok).toBe(false);
    const status = await db.query(`SELECT status FROM stock_reservations WHERE tx_id=$1`, [txId]);
    expect(status.rows[0].status).toBe("EXPIRED"); // rollback left it expired
    expect(await counters("SKU-GRACE2")).toMatchObject({ reserved: 0 });
  });
});

describe("invariant I property (§7.3): randomized reserve/release interleavings", () => {
  it("reserved ≤ stock_qty ∧ reserved ≥ 0 ∧ sold ≥ 0 always", async () => {
    await seedStock(db, { "SKU-PROP": 8, "SKU-PROPB": 3 });

    // Model: ops are interpreted against LIVE holds — a release targets a
    // previously-successful reservation, exactly like the real negative paths.
    type Op =
      | { t: "reserve"; skuIdx: number; qty: number }
      | { t: "release"; liveIdx: number };

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              t: fc.constant("reserve"),
              skuIdx: fc.integer({ min: 0, max: 1 }),
              qty: fc.integer({ min: 1, max: 4 }),
            }),
            fc.record({ t: fc.constant("release"), liveIdx: fc.integer({ min: 0, max: 5 }) }),
          ),
          { minLength: 1, maxLength: 14 },
        ),
        async (rawOps) => {
          const live: string[] = []; // tx ids currently holding stock
          for (const raw of rawOps as Op[]) {
            if (raw.t === "reserve") {
              const txId = newTxId();
              await ensureTxRow(db, txId);
              try {
                await reserveCart(
                  db,
                  txId,
                  [{ sku: raw.skuIdx === 0 ? "SKU-PROP" : "SKU-PROPB", qty: raw.qty }],
                  TTL,
                  NOW,
                );
                live.push(txId);
              } catch {
                /* refusal is part of the model */
              }
            } else {
              const victim = live[raw.liveIdx];
              if (victim !== undefined) {
                await releaseHolds(db, victim, "PAYMENT_FAILED");
                live.splice(live.indexOf(victim), 1);
              }
            }
            for (const sku of ["SKU-PROP", "SKU-PROPB"]) {
              const c = await counters(sku);
              expect(c.reserved).toBeGreaterThanOrEqual(0);
              expect(c.reserved).toBeLessThanOrEqual(c.stock_qty);
              expect(c.sold).toBeGreaterThanOrEqual(0);
            }
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
