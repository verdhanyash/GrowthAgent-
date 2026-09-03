/**
 * Sweeper (settlement.md §7.4 + §10.1): TTL releases and reconciliation.
 * Clock-injected so DEMO_STABLE_MODE advances it deterministically; a Redis
 * lease keeps replicas from double-running (single-process demo runs without
 * contention either way). Every action is audited with the settlement.sweeper
 * actor and surfaces on the SSE trace (§16).
 *
 * Reconciliation ladder (§10.1):
 *   1. PROPOSAL_APPROVED > 60 s        → resume reserve        (W1)
 *   2. STOCK_RESERVED  > 60 s          → resume order-create   (W2)
 *   3. razorpay_orders INTENT > 120 s  → same-receipt retry    (W3/W4)
 *   4. webhook events RECEIVED > 60 s  → re-dispatch           (W6)
 *   5. PAID > 30 s                     → drive completion      (W7)
 *   6. expired ACTIVE holds            → release               (W8, §7.4)
 */
import type { SettleableProposal } from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { appendAudit, auditGlobal } from "../audit/writer.js";
import type { Clock } from "./clock.js";
import type { SettlementConfig } from "./config.js";
import type { SettlementProvider } from "./provider/types.js";
import { parseValidatedEnvelope } from "./provider/payload.schema.js";
import { reserveCart } from "./reserve.js";
import { casTransition } from "./state-machine.js";
import { ensureOrder } from "./ensure-order.js";
import { completeTransaction } from "./completion.js";
import { dispatchParsed, type WebhookHandlerDeps } from "./webhook-handler.js";

const RESUME_RESERVE_AFTER_MS = 60_000;
const RESUME_ORDER_AFTER_MS = 60_000;
const RETRY_INTENT_AFTER_MS = 120_000;
const REDRIVE_EVENT_AFTER_MS = 60_000;
const DRIVE_COMPLETION_AFTER_MS = 30_000;

export interface SweeperDeps {
  readonly db: PgPool;
  readonly provider: SettlementProvider;
  readonly config: SettlementConfig;
  readonly clock: Clock;
}

function loadProposal(row: { proposal_bytes: unknown }): SettleableProposal {
  return row.proposal_bytes as SettleableProposal; // frozen bytes stored at T1
}

/** §7.4 — two decoupled passes: tx state flips FIRST (prompt UI), hold
 *  releases key off the reservation table ALONE so a crash between passes
 *  self-heals next round. Returns expired tx ids. */
export async function sweepExpiredReservations(db: PgPool): Promise<string[]> {
  const txs = await db.query(
    `UPDATE transactions t SET state='EXPIRED', expired_at=now(), updated_at=now()
       FROM stock_reservations r
      WHERE r.tx_id = t.tx_id AND r.status='ACTIVE' AND r.expires_at < now()
        AND t.state='AWAITING_PAYMENT'
      RETURNING t.tx_id`,
  );
  await releaseExpiredHolds(db);
  // A multi-line tx matches once per hold row — dedupe before auditing.
  const ids = [...new Set((txs.rows as { tx_id: string }[]).map((r) => r.tx_id))];
  for (const txId of ids) appendAudit(txId, "settlement.sweeper", "tx.expired", {});
  return ids;
}

/**
 * Pass 2 standalone: releases by reservation-table scan alone (W8).
 *
 * ONE statement, therefore one implicit transaction: the status flip and the
 * matching `inventory.reserved` decrements commit together or not at all. The
 * previous shape flipped every row to EXPIRED on the pool and THEN decremented
 * counters one query at a time — a crash in that window left rows the sweep
 * never revisits (it keys on status='ACTIVE') with the counters still held, a
 * permanent phantom reservation. Backordered holds never took a counter, so
 * they are excluded from the decrement but still expire.
 *
 * A SKU whose decrement guard (`reserved >= qty`) fails was ALREADY corrupt
 * before this sweep; those rows come back ok=false and raise the §7.4
 * belt-and-braces alert instead of silently moving counters negative.
 */
export async function releaseExpiredHolds(db: PgPool): Promise<number> {
  const rows = await db.query(
    `WITH claimed AS (
       UPDATE stock_reservations SET status='EXPIRED', released_at=now()
        WHERE status='ACTIVE' AND expires_at < now()
       RETURNING tx_id, sku, qty, backordered
     ), totals AS (
       SELECT sku, SUM(qty)::int AS qty FROM claimed WHERE backordered = false GROUP BY sku
     ), decremented AS (
       UPDATE inventory i SET reserved = i.reserved - t.qty, updated_at = now()
         FROM totals t
        WHERE i.sku = t.sku AND i.reserved >= t.qty
       RETURNING i.sku
     )
     SELECT c.tx_id, c.sku, c.qty, c.backordered,
            (c.backordered OR d.sku IS NOT NULL) AS ok
       FROM claimed c LEFT JOIN decremented d ON d.sku = c.sku`,
  );
  let units = 0;
  for (const row of rows.rows as { tx_id: string; sku: string; qty: number; ok: boolean }[]) {
    if (!row.ok) {
      // Belt-and-braces tripwire (§7.4): counters were already wrong — alert,
      // never throw the whole sweep away.
      appendAudit(row.tx_id, "settlement.sweeper", "invariant_violation_alert", {
        sku: row.sku,
        op: "expired_release",
      });
      continue;
    }
    units += row.qty;
  }
  if (units > 0) {
    appendAudit("-", "settlement.sweeper", "reservation.expired_released", { units });
  }
  return units;
}

/** One reconciliation sweep. `now` is Clock-derived (Virtual in demo mode). */
export async function runSweep(deps: SweeperDeps, now: Date): Promise<void> {
  const { db, provider, config, clock } = deps;
  appendAudit("-", "settlement.sweeper", "sweep.action", { kind: "begin" });

  // 6 · expired holds first — freshest signal of leaked stock (§7.4 pass order).
  await releaseExpiredHolds(db);

  // 1 · W1 resume reserve.
  const w1 = await db.query(
    `SELECT tx_id, proposal_bytes FROM transactions
      WHERE state='PROPOSAL_APPROVED' AND updated_at < $1`,
    [new Date(now.getTime() - RESUME_RESERVE_AFTER_MS)],
  );
  for (const row of w1.rows as { tx_id: string; proposal_bytes: unknown }[]) {
    const p = loadProposal(row);
    try {
      await reserveCart(db, p.tx_id, p.lines, config.reservationTtlMs, now);
      await casTransition(db, p.tx_id, "PROPOSAL_APPROVED", "STOCK_RESERVED");
      appendAudit(p.tx_id, "settlement.sweeper", "sweep.action", { kind: "resume_reserve" });
    } catch {
      // Stock gone since approval → T3 RELEASED; anything else retries next sweep.
      await casTransition(db, p.tx_id, "PROPOSAL_APPROVED", "RELEASED");
      appendAudit(p.tx_id, "settlement.sweeper", "stock.reserve_failed", { resumed_by: "sweeper" });
    }
  }

  // 2 · W2 resume order-create (claim contended normally).
  const w2 = await db.query(
    `SELECT tx_id, proposal_bytes FROM transactions
      WHERE state='STOCK_RESERVED' AND updated_at < $1`,
    [new Date(now.getTime() - RESUME_ORDER_AFTER_MS)],
  );
  for (const row of w2.rows as { tx_id: string; proposal_bytes: unknown }[]) {
    const p = loadProposal(row);
    const handle = await ensureOrder(provider, db, p);
    if (handle !== null) {
      appendAudit(p.tx_id, "settlement.sweeper", "sweep.action", { kind: "resume_order_create" });
    }
  }

  // 3 · W3/W4 receipt-retry protocol: crashed winner left ORDER_CREATING with
  // an INTENT/missing handle. Same receipt ⇒ provably at-most-one real order.
  // CREATED rows with a lagging tx state ride the same lane (W5 healing):
  // ensureOrder's reuse branch advances T4b/T6 idempotently.
  const w3 = await db.query(
    `SELECT t.tx_id, t.proposal_bytes FROM transactions t
       JOIN razorpay_orders o USING (tx_id)
      WHERE o.status IN ('INTENT','CREATED')
        AND t.state IN ('ORDER_CREATING','RZP_ORDER_CREATED')
        AND o.created_at < $1`,
    [new Date(now.getTime() - RETRY_INTENT_AFTER_MS)],
  );
  for (const row of w3.rows as { tx_id: string; proposal_bytes: unknown }[]) {
    const p = loadProposal(row);
    try {
      await ensureOrder(provider, db, p, { skipClaim: true });
      appendAudit(p.tx_id, "settlement.sweeper", "sweep.action", { kind: "receipt_retry" });
    } catch {
      // OrderAmbiguityError etc.: stays flagged (AMBIGUOUS), retried never blindly.
      appendAudit(p.tx_id, "settlement.sweeper", "rzp.order_ambiguous", { via: "sweep_retry" });
    }
  }

  // 4 · W6 redrive stranded RECEIVED events (bytes verified at ingress).
  const w4 = await db.query(
    `SELECT event_id, payload FROM processed_webhook_events
      WHERE status='RECEIVED' AND received_at < $1 AND payload IS NOT NULL`,
    [new Date(now.getTime() - REDRIVE_EVENT_AFTER_MS)],
  );
  const webhookDeps: WebhookHandlerDeps = deps;
  for (const row of w4.rows as { event_id: string; payload: unknown }[]) {
    try {
      const parsed = parseValidatedEnvelope(row.payload, row.event_id);
      if (parsed.kind !== "ignored") {
        await dispatchParsed(webhookDeps, parsed);
      }
      await db.query(
        `UPDATE processed_webhook_events SET status='PROCESSED', processed_at=now()
          WHERE event_id=$1`,
        [row.event_id],
      );
      auditGlobal("settlement.sweeper", "sweep.action", { kind: "redrive_event", event_id: row.event_id });
    } catch (e) {
      auditGlobal("settlement.sweeper", "webhook.process_error", {
        event_id: row.event_id,
        err: String(e),
      });
    }
  }

  // 5 · W7 drive completion (CAS latch makes reruns noops).
  const w5 = await db.query(
    `SELECT tx_id FROM transactions
      WHERE state='PAID' AND updated_at < $1`,
    [new Date(now.getTime() - DRIVE_COMPLETION_AFTER_MS)],
  );
  for (const row of w5.rows as { tx_id: string }[]) {
    try {
      await completeTransaction(db, row.tx_id);
    } catch {
      /* audited inside completeTransaction; latch still open for next sweep */
    }
  }

  void clock; // freshness/TTL arithmetic rides on caller-supplied `now`
}
