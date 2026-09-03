/**
 * completion-audit.spec.ts — the completion-side consequences of the audit
 * fixes: the frozen-bytes shortfall check must SUM same-SKU sub-lines (S1), and
 * a backordered line must convert to a sale without drawing down shelf stock
 * that was never there (H2).
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createPool, type PgPool } from "../db/client.js";
import { MemoryAuditSink, setAuditSink } from "../audit/writer.js";
import { completeTransaction } from "./completion.js";
import { InvariantViolationError, reserveCart } from "./reserve.js";
import { newTxId, seedStock, truncateAll } from "./__tests__/harness.js";

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

interface Line {
  sku: string;
  qty: number;
  unit_price_paise: number;
  backordered?: boolean;
}

/** A PAID transaction carrying `lines` as its frozen proposal bytes. */
async function paidTx(lines: Line[]): Promise<string> {
  const txId = newTxId();
  const total = lines.reduce((s, l) => s + l.unit_price_paise * l.qty, 0);
  const sha = createHash("sha256").update(txId).digest("hex");
  await db.query(
    `INSERT INTO transactions
       (tx_id, state, proposal_bytes, proposal_sha256, approved_total_paise,
        ruleset_version, gatekeeper_trace_digest, approval_source, provider_kind, receipt, paid_at)
     VALUES ($1,'PAID',$2,$3,$4,3,$5,'GATEKEEPER_AUTO','mock',$6, now())`,
    [txId, JSON.stringify({ tx_id: txId, lines, total_amount_paise: total }), sha, total, sha, `ga_${txId.slice(3)}`],
  );
  await reserveCart(db, txId, lines, TTL, NOW);
  return txId;
}

async function counters(sku: string): Promise<{ stock_qty: number; reserved: number; sold: number }> {
  const r = await db.query(`SELECT stock_qty, reserved, sold FROM inventory WHERE sku=$1`, [sku]);
  return r.rows[0] as { stock_qty: number; reserved: number; sold: number };
}

async function stateOf(txId: string): Promise<string> {
  const r = await db.query(`SELECT state FROM transactions WHERE tx_id=$1`, [txId]);
  return (r.rows[0] as { state: string }).state;
}

describe("completeTransaction — same-sku sub-lines (audit S1)", () => {
  it("sums the frozen lines, so a split cart is not a false commit_shortfall", async () => {
    await seedStock(db, { "SKU-CS": 10 });
    // Exactly what mintSettleable emits for 3 units at an indivisible net.
    const txId = await paidTx([
      { sku: "SKU-CS", qty: 1, unit_price_paise: 23_033 },
      { sku: "SKU-CS", qty: 2, unit_price_paise: 23_032 },
    ]);
    await completeTransaction(db, txId);
    expect(await stateOf(txId)).toBe("COMPLETED");
    // 3 units left the shelf and became a sale — not 2 (the old `set` kept only
    // the LAST duplicate as the expectation and mismatched the 3 holds).
    expect(await counters("SKU-CS")).toMatchObject({ stock_qty: 7, reserved: 0, sold: 3 });
  });

  it("a genuine shortfall still aborts the whole commit", async () => {
    await seedStock(db, { "SKU-SHORT": 10 });
    const txId = await paidTx([{ sku: "SKU-SHORT", qty: 4, unit_price_paise: 1_000 }]);
    // Someone released one hold behind our back: the holds no longer satisfy the
    // approved cart, so this must NOT be recorded as a full sale.
    await db.query(`UPDATE stock_reservations SET status='RELEASED' WHERE tx_id=$1`, [txId]);
    await db.query(`UPDATE inventory SET reserved = 0 WHERE sku='SKU-SHORT'`);
    await expect(completeTransaction(db, txId)).rejects.toThrow(InvariantViolationError);
    expect(await stateOf(txId)).toBe("PAID"); // latch still open for the sweep
    expect(await counters("SKU-SHORT")).toMatchObject({ sold: 0 });
  });

  it("is idempotent: a second completion is a noop", async () => {
    await seedStock(db, { "SKU-IDEM": 6 });
    const txId = await paidTx([{ sku: "SKU-IDEM", qty: 2, unit_price_paise: 5_000 }]);
    await completeTransaction(db, txId);
    await completeTransaction(db, txId);
    expect(await counters("SKU-IDEM")).toMatchObject({ stock_qty: 4, reserved: 0, sold: 2 });
  });
});

describe("completeTransaction — backordered lines (audit H2)", () => {
  it("records the sale without drawing down stock that was never held", async () => {
    await seedStock(db, { "SKU-BOC": 0 });
    const txId = await paidTx([{ sku: "SKU-BOC", qty: 5, unit_price_paise: 15_900, backordered: true }]);
    await completeTransaction(db, txId);
    expect(await stateOf(txId)).toBe("COMPLETED");
    // sold moves; stock_qty stays 0 (a `stock_qty - 5` would trip the CHECK).
    expect(await counters("SKU-BOC")).toMatchObject({ stock_qty: 0, reserved: 0, sold: 5 });
  });

  it("commits a mixed cart: one held line, one made-to-order", async () => {
    await seedStock(db, { "SKU-BOM-A": 4, "SKU-BOM-Z": 0 });
    const txId = await paidTx([
      { sku: "SKU-BOM-A", qty: 2, unit_price_paise: 10_000 },
      { sku: "SKU-BOM-Z", qty: 3, unit_price_paise: 15_900, backordered: true },
    ]);
    await completeTransaction(db, txId);
    expect(await stateOf(txId)).toBe("COMPLETED");
    expect(await counters("SKU-BOM-A")).toMatchObject({ stock_qty: 2, reserved: 0, sold: 2 });
    expect(await counters("SKU-BOM-Z")).toMatchObject({ stock_qty: 0, reserved: 0, sold: 3 });
  });
});
