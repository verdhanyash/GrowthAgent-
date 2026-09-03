/**
 * reserve-audit.spec.ts — the reservation-layer findings from the red-team audit
 * (review.md): S2 non-transactional release, S1's same-SKU sub-lines, and H2's
 * gatekeeper/settlement backorder mismatch. Real Postgres, same harness as
 * reserve.spec.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createPool, type PgPool } from "../db/client.js";
import { MemoryAuditSink, setAuditSink } from "../audit/writer.js";
import {
  InsufficientStockError,
  InvariantViolationError,
  aggregateHoldLines,
  reReserveExpiredHolds,
  releaseHolds,
  reserveCart,
} from "./reserve.js";
import { releaseExpiredHolds } from "./sweeper.js";
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
  const r = await db.query(`SELECT stock_qty, reserved, sold FROM inventory WHERE sku=$1`, [sku]);
  if (r.rowCount === 0) return { stock_qty: -1, reserved: -1, sold: -1 };
  return r.rows[0] as { stock_qty: number; reserved: number; sold: number };
}

async function holds(txId: string): Promise<{ sku: string; qty: number; status: string; backordered: boolean }[]> {
  const r = await db.query(
    `SELECT sku, qty, status, backordered FROM stock_reservations WHERE tx_id=$1 ORDER BY sku`,
    [txId],
  );
  return r.rows as { sku: string; qty: number; status: string; backordered: boolean }[];
}

/**
 * audit S2 — `releaseHolds` used to flip every row to RELEASED on the pool and
 * THEN decrement counters one query at a time. Any failure after the flip left
 * rows the sweeper never revisits (it keys on status='ACTIVE') with
 * `inventory.reserved` still held: a permanent phantom reservation. One
 * transaction means the flip and the decrements stand or fall together.
 */
describe("releaseHolds — atomicity (audit S2)", () => {
  it("a tripwire on ONE sku rolls back the WHOLE release, holds stay reclaimable", async () => {
    await seedStock(db, { "SKU-RA": 10, "SKU-RB": 10 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-RA", qty: 2 }, { sku: "SKU-RB", qty: 3 }], TTL, NOW);
    expect(await counters("SKU-RA")).toMatchObject({ reserved: 2 });
    expect(await counters("SKU-RB")).toMatchObject({ reserved: 3 });

    // Corrupt ONE counter so its guarded decrement (`reserved >= qty`) cannot fire.
    await db.query(`UPDATE inventory SET reserved = 0 WHERE sku = 'SKU-RB'`);

    await expect(releaseHolds(db, txId, "PAYMENT_FAILED")).rejects.toThrow(InvariantViolationError);

    // Nothing half-applied: both holds still ACTIVE, the healthy counter intact.
    expect((await holds(txId)).map((h) => h.status)).toEqual(["ACTIVE", "ACTIVE"]);
    expect(await counters("SKU-RA")).toMatchObject({ reserved: 2 });
    expect(await counters("SKU-RB")).toMatchObject({ reserved: 0 });
  });

  it("a healthy multi-line release commits every counter and every row", async () => {
    await seedStock(db, { "SKU-RC": 10, "SKU-RD": 10 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-RC", qty: 2 }, { sku: "SKU-RD", qty: 3 }], TTL, NOW);
    expect(await releaseHolds(db, txId, "PAYMENT_FAILED")).toBe(5);
    expect((await holds(txId)).map((h) => h.status)).toEqual(["RELEASED", "RELEASED"]);
    expect(await counters("SKU-RC")).toMatchObject({ reserved: 0 });
    expect(await counters("SKU-RD")).toMatchObject({ reserved: 0 });
  });

  it("a second release is still a noop (the status CAS is unchanged)", async () => {
    await seedStock(db, { "SKU-RE": 5 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-RE", qty: 2 }], TTL, NOW);
    expect(await releaseHolds(db, txId, "PAYMENT_FAILED")).toBe(2);
    expect(await releaseHolds(db, txId, "PAYMENT_FAILED")).toBe(0);
    expect(await counters("SKU-RE")).toMatchObject({ reserved: 0 });
  });

  it("the TTL sweep flips status and decrements in ONE statement", async () => {
    await seedStock(db, { "SKU-EXP": 8 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    // TTL already elapsed relative to DB now().
    await reserveCart(db, txId, [{ sku: "SKU-EXP", qty: 3 }], -1_000, new Date());
    expect(await releaseExpiredHolds(db)).toBe(3);
    expect((await holds(txId)).map((h) => h.status)).toEqual(["EXPIRED"]);
    expect(await counters("SKU-EXP")).toMatchObject({ reserved: 0 });
  });

  it("the sweep alerts instead of driving an already-corrupt counter negative", async () => {
    await seedStock(db, { "SKU-EXPBAD": 8 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-EXPBAD", qty: 3 }], -1_000, new Date());
    await db.query(`UPDATE inventory SET reserved = 0 WHERE sku = 'SKU-EXPBAD'`);
    expect(await releaseExpiredHolds(db)).toBe(0); // nothing credited back
    expect(await counters("SKU-EXPBAD")).toMatchObject({ reserved: 0 }); // never negative
  });
});

/**
 * audit S1 (settlement side) — mintSettleable emits TWO lines for one SKU when
 * the approved net does not divide by the quantity, and stock_reservations is
 * UNIQUE (tx_id, sku). The hold layer must sum them, not insert twice.
 */
describe("reserveCart — same-sku lines (audit S1)", () => {
  it("sums duplicate lines into ONE hold of the combined quantity", async () => {
    await seedStock(db, { "SKU-SPLIT": 10 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(
      db,
      txId,
      [
        { sku: "SKU-SPLIT", qty: 1, unit_price_paise: 23_033 },
        { sku: "SKU-SPLIT", qty: 2, unit_price_paise: 23_032 },
      ],
      TTL,
      NOW,
    );
    expect(await holds(txId)).toEqual([{ sku: "SKU-SPLIT", qty: 3, status: "ACTIVE", backordered: false }]);
    expect(await counters("SKU-SPLIT")).toMatchObject({ reserved: 3 });
  });

  it("the SUMMED quantity is what the sellability guard checks", async () => {
    await seedStock(db, { "SKU-TIGHT": 3 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    // 2 + 2 = 4 > 3: refuse, rather than squeeze two 2s past a 3-unit shelf.
    await expect(
      reserveCart(db, txId, [{ sku: "SKU-TIGHT", qty: 2 }, { sku: "SKU-TIGHT", qty: 2 }], TTL, NOW),
    ).rejects.toThrow(InsufficientStockError);
    expect(await counters("SKU-TIGHT")).toMatchObject({ reserved: 0 });
  });

  it("aggregateHoldLines is lexicographic (deadlock order) and OR-s the flag", () => {
    expect(
      aggregateHoldLines([
        { sku: "B", qty: 1 },
        { sku: "A", qty: 2, backordered: true },
        { sku: "A", qty: 1, backordered: true },
      ]),
    ).toEqual([
      { sku: "A", qty: 3, backordered: true },
      { sku: "B", qty: 1, backordered: false },
    ]);
  });
});

/**
 * audit H2 — GK-STOCK-AVAILABILITY exempts `backorder_allowed_skus`, but every
 * hold path enforced `stock_qty - reserved >= qty` unconditionally, so a
 * made-to-order line the gatekeeper APPROVED was refused at settle time. A
 * backordered hold records the units and moves no counter.
 */
describe("backordered holds (audit H2)", () => {
  it("reserves a zero-stock made-to-order line without touching counters", async () => {
    await seedStock(db, { "SKU-MTO": 0 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-MTO", qty: 5, backordered: true }], TTL, NOW);
    expect(await holds(txId)).toEqual([{ sku: "SKU-MTO", qty: 5, status: "ACTIVE", backordered: true }]);
    expect(await counters("SKU-MTO")).toMatchObject({ stock_qty: 0, reserved: 0, sold: 0 });
  });

  it("the SAME line without the flag is refused (the exemption stays explicit)", async () => {
    await seedStock(db, { "SKU-MTO2": 0 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await expect(reserveCart(db, txId, [{ sku: "SKU-MTO2", qty: 5 }], TTL, NOW)).rejects.toThrow(
      InsufficientStockError,
    );
  });

  it("mixes a backordered line with a held line in one transaction", async () => {
    await seedStock(db, { "SKU-MIX-A": 4, "SKU-MIX-Z": 0 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(
      db,
      txId,
      [{ sku: "SKU-MIX-A", qty: 2 }, { sku: "SKU-MIX-Z", qty: 3, backordered: true }],
      TTL,
      NOW,
    );
    expect(await counters("SKU-MIX-A")).toMatchObject({ reserved: 2 });
    expect(await counters("SKU-MIX-Z")).toMatchObject({ reserved: 0 });
  });

  it("releases a backordered hold without tripping the counter invariant", async () => {
    await seedStock(db, { "SKU-MTO3": 0 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-MTO3", qty: 5, backordered: true }], TTL, NOW);
    expect(await releaseHolds(db, txId, "PAYMENT_FAILED")).toBe(5);
    expect((await holds(txId)).map((h) => h.status)).toEqual(["RELEASED"]);
    expect(await counters("SKU-MTO3")).toMatchObject({ reserved: 0 });
  });

  it("re-reserves a backordered hold after expiry without a stock check", async () => {
    await seedStock(db, { "SKU-MTO4": 0 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-MTO4", qty: 5, backordered: true }], TTL, NOW);
    await db.query(`UPDATE stock_reservations SET status='EXPIRED' WHERE tx_id=$1`, [txId]);
    expect(await reReserveExpiredHolds(db, txId, TTL, NOW)).toBe(true);
    expect(await counters("SKU-MTO4")).toMatchObject({ reserved: 0 });
  });

  it("the TTL sweep expires a backordered hold and credits nothing back", async () => {
    await seedStock(db, { "SKU-MTO5": 0 });
    const txId = newTxId();
    await ensureTxRow(db, txId);
    await reserveCart(db, txId, [{ sku: "SKU-MTO5", qty: 4, backordered: true }], -1_000, new Date());
    expect(await releaseExpiredHolds(db)).toBe(4);
    expect(await counters("SKU-MTO5")).toMatchObject({ reserved: 0 });
  });
});
