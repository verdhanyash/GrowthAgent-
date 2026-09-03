/**
 * Completion commit (settlement.md §9, T12): PAID → COMPLETED, fully
 * idempotent. The `state='PAID'` CAS is THE idempotence latch — a retried
 * completion is a noop; a failed one leaves state PAID with holds ACTIVE and
 * the sweep re-drives it (W7). Runs OUTSIDE the webhook response budget (V9).
 */
import type { PgPool } from "../db/client.js";
import { appendAudit } from "../audit/writer.js";
import { InvariantViolationError } from "./reserve.js";

export async function completeTransaction(db: PgPool, txId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // THE idempotence latch: exactly one caller ever converts the sale.
    const cas = await client.query(
      `UPDATE transactions SET state = 'COMPLETED', completed_at = now(), updated_at = now()
        WHERE tx_id = $1 AND state = 'PAID'
        RETURNING proposal_bytes`,
      [txId],
    );
    if ((cas.rowCount ?? 0) === 0) {
      await client.query("COMMIT");
      return; // already done / raced: noop
    }
    let committedUnits = 0;
    const linesBySku = new Map<string, number>();
    for (const line of (
      (cas.rows[0] as { proposal_bytes: { lines?: { sku: string; qty: number }[] } })
        .proposal_bytes?.lines ?? []
    )) {
      // SUM, never overwrite: mintSettleable emits two sub-lines for one SKU
      // when the approved net does not divide evenly by quantity, and a plain
      // `set` would under-count expectedUnits into a false commit_shortfall.
      linesBySku.set(line.sku, (linesBySku.get(line.sku) ?? 0) + line.qty);
    }
    for (const line of (
      await client.query(
        `UPDATE stock_reservations SET status = 'COMMITTED', committed_at = now()
          WHERE tx_id = $1 AND status = 'ACTIVE'
          RETURNING sku, qty, backordered`,
        [txId],
      )
    ).rows as { sku: string; qty: number; backordered: boolean }[]) {
      if (line.backordered) {
        // Made-to-order: no hold was ever taken and there is no shelf stock to
        // draw down, so only the sales counter moves. `stock_qty - qty` would
        // drive the row negative and trip the CHECK.
        const b = await client.query(
          `UPDATE inventory SET sold = sold + $1, updated_at = now() WHERE sku = $2`,
          [line.qty, line.sku],
        );
        if ((b.rowCount ?? 0) === 0) throw new InvariantViolationError(txId, line.sku, "commit_backorder");
        committedUnits += line.qty;
        continue;
      }
      // Hold→sale move: every clause guarded; any refusal aborts the WHOLE
      // transaction (latch stays open for the sweep's retry).
      const u = await client.query(
        `UPDATE inventory
            SET reserved = reserved - $1, sold = sold + $1,
                stock_qty = stock_qty - $1, updated_at = now()
          WHERE sku = $2 AND reserved >= $1`,
        [line.qty, line.sku],
      );
      if ((u.rowCount ?? 0) === 0) throw new InvariantViolationError(txId, line.sku, "commit");
      committedUnits += line.qty;
    }
    // Frozen-bytes reconciliation: the holds that existed at PAID must sum to
    // exactly what the approved cart demanded — a vanished/short hold set must
    // never be silently recorded as a full sale.
    const expectedUnits = [...linesBySku.values()].reduce((s, q) => s + q, 0);
    if (linesBySku.size > 0 && committedUnits !== expectedUnits) {
      throw new InvariantViolationError(txId, "*", "commit_shortfall");
    }
    await client.query(`INSERT INTO completed_sales (tx_id) VALUES ($1)`, [txId]);
    await client.query("COMMIT");
    appendAudit(txId, "completion.worker", "tx.completed", {});
  } catch (e) {
    await client.query("ROLLBACK");
    appendAudit(txId, "completion.worker", "completion.retry_scheduled", {
      err: e instanceof Error ? e.message : String(e),
    });
    throw e;
  } finally {
    client.release();
  }
}
