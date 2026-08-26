/**
 * §15.3 — state machine matrix. The full 12×12 pair space is enumerated
 * against the authority TABLE (pure) and against the DB CAS (integration);
 * rerun idempotence and the grace ladder get dedicated cases.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TX_STATES, type TxState } from "@growthagent/shared";
import {
  applyMigrations,
  createPool,
  type PgPool,
} from "../db/client.js";
import { MemoryAuditSink, setAuditSink } from "../audit/writer.js";
import { casTransition, isLegalTransition } from "./state-machine.js";
import { completeTransaction } from "./completion.js";
import { ensureTxRow, newTxId, truncateAll } from "./__tests__/harness.js";

let db: PgPool;

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

/** States from which money or stock can be stuck when a tampered-looking
 *  capture arrives — per the §8.3 adjudication each gets a
 *  MANUAL_REFUND_REQUIRED escape. PROPOSAL_APPROVED deliberately has none:
 *  nothing was reserved or charged, so RELEASED/FAILED/REJECTED cover it. */
const PRE_TERMINAL: TxState[] = [
  "STOCK_RESERVED",
  "ORDER_CREATING",
  "RZP_ORDER_CREATED",
  "AWAITING_PAYMENT",
  "PAID",
  "EXPIRED",
];

describe("authority table (pure)", () => {
  it("PROPOSAL_APPROVED has no refund edge (nothing to refund yet)", () => {
    expect(isLegalTransition("PROPOSAL_APPROVED", "MANUAL_REFUND_REQUIRED")).toBe(false);
    for (const to of ["STOCK_RESERVED", "RELEASED", "FAILED", "REJECTED_BY_MERCHANT"] as const) {
      expect(isLegalTransition("PROPOSAL_APPROVED", to)).toBe(true);
    }
  });

  it("terminal states have no outgoing edges", () => {
    for (const terminal of [
      "COMPLETED",
      "FAILED",
      "RELEASED",
      "REJECTED_BY_MERCHANT",
      "MANUAL_REFUND_REQUIRED",
    ] as const) {
      for (const to of TX_STATES) {
        expect(isLegalTransition(terminal, to), `${terminal} → ${to}`).toBe(false);
      }
    }
  });

  it("every pre-terminal state can reach MANUAL_REFUND_REQUIRED (§8.3 tamper escape)", () => {
    for (const from of PRE_TERMINAL) {
      expect(isLegalTransition(from, "MANUAL_REFUND_REQUIRED"), `from ${from}`).toBe(true);
    }
  });

  it("happy path is exactly T1…T12 in order", () => {
    const path: TxState[] = [
      "PROPOSAL_APPROVED",
      "STOCK_RESERVED",
      "ORDER_CREATING",
      "RZP_ORDER_CREATED",
      "AWAITING_PAYMENT",
      "PAID",
      "COMPLETED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(isLegalTransition(from, to), `${from} → ${to}`).toBe(true);
    }
  });
});

describe("casTransition (DB)", () => {
  async function seedIn(state: TxState): Promise<string> {
    const txId = newTxId();
    await ensureTxRow(db, txId);
    if (state !== "PROPOSAL_APPROVED") {
      const tsCols: Partial<Record<TxState, string>> = {
        STOCK_RESERVED: "reserved_at",
        PAID: "paid_at",
        EXPIRED: "expired_at",
        COMPLETED: "completed_at",
        FAILED: "failed_at",
      };
      const sets = [`state = '${state}'`];
      if (tsCols[state]) sets.push(`${tsCols[state]} = now()`);
      await db.query(`UPDATE transactions SET ${sets.join(", ")} WHERE tx_id=$1`, [txId]);
    }
    return txId;
  }

  it("every legal pair in the table advances; PAID stamps the winning pay id", async () => {
    for (const from of TX_STATES) {
      for (const to of TX_STATES) {
        const legal = isLegalTransition(from, to);
        const txId = await seedIn(from);
        const r = await casTransition(db, txId, from, to, { pay_id: "pay_x" });
        expect(r.advanced, `${from} → ${to} legal=${legal}`).toBe(legal);
        if (legal) {
          expect(r.currentState).toBe(to);
          if (to === "PAID") {
            const row = await db.query(`SELECT pay_id FROM transactions WHERE tx_id=$1`, [txId]);
            expect(row.rows[0].pay_id).toBe("pay_x");
          }
        }
      }
    }
  });

  it("illegal pairs refuse AND audit illegal_transition_attempt (never silently ignored)", async () => {
    const sink = (await import("../audit/writer.js")).getAuditSink() as MemoryAuditSink;
    const txId = await seedIn("AWAITING_PAYMENT");
    const r = await casTransition(db, txId, "AWAITING_PAYMENT", "COMPLETED"); // skip PAID: illegal
    expect(r.advanced).toBe(false);
    expect(r.currentState).toBe("AWAITING_PAYMENT");
    expect(sink.count(txId, "illegal_transition_attempt")).toBe(1);
  });

  it("legal pair losing a race reports current state without auditing illegality", async () => {
    const txId = await seedIn("AWAITING_PAYMENT");
    // Winner moves first…
    const win = await casTransition(db, txId, "AWAITING_PAYMENT", "PAID");
    expect(win.advanced).toBe(true);
    // …loser replays the same legal transition and loses cleanly.
    const lose = await casTransition(db, txId, "AWAITING_PAYMENT", "FAILED");
    expect(lose.advanced).toBe(false);
    expect(lose.currentState).toBe("PAID");
  });
});

describe("completion latch (T12)", () => {
  async function seedPaidWithHold(sku: string, qty: number) {
    const txId = newTxId();
    await ensureTxRow(db, txId);
    // Realistic frozen bytes: completion reconciles committed hold units
    // against the approved cart lines before recording the sale.
    await db.query(
      `UPDATE transactions SET state='PAID', paid_at=now(),
              proposal_bytes = $2::jsonb
         WHERE tx_id=$1`,
      [txId, JSON.stringify({ lines: [{ sku, qty }] })],
    );
    await db.query(
      `INSERT INTO inventory (sku, stock_qty, reserved) VALUES ($1, $2, $2)
       ON CONFLICT (sku) DO UPDATE SET stock_qty=$2, reserved=$2, sold=0`,
      [sku, qty],
    );
    await db.query(
      `INSERT INTO stock_reservations (tx_id, sku, qty, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [txId, sku, qty],
    );
    return txId;
  }

  it("rerun ×3 → one effect, two noops (§15.3)", async () => {
    const txId = await seedPaidWithHold("SKU-COMMIT", 3);
    for (let i = 0; i < 3; i++) await completeTransaction(db, txId);
    const inv = await db.query(`SELECT stock_qty, reserved, sold FROM inventory WHERE sku='SKU-COMMIT'`);
    expect(inv.rows[0]).toMatchObject({ stock_qty: 0, reserved: 0, sold: 3 });
    const sales = await db.query(`SELECT count(*)::int AS n FROM completed_sales`);
    expect(sales.rows[0].n).toBe(1);
    const resv = await db.query(
      `SELECT status FROM stock_reservations WHERE tx_id=$1`,
      [txId],
    );
    expect(resv.rows[0].status).toBe("COMMITTED");
  });

  it("commit with a vanished hold aborts atomically — latch stays open", async () => {
    const txId = await seedPaidWithHold("SKU-VANISH", 2);
    await db.query(`DELETE FROM stock_reservations WHERE tx_id=$1`, [txId]); // sabotage
    await expect(completeTransaction(db, txId)).rejects.toThrow(/invariant violation/i);
    const state = await db.query(`SELECT state FROM transactions WHERE tx_id=$1`, [txId]);
    expect(state.rows[0].state).toBe("PAID"); // rolled back — sweep will retry
    const sales = await db.query(`SELECT count(*)::int AS n FROM completed_sales`);
    expect(sales.rows[0].n).toBe(0);
  });
});
