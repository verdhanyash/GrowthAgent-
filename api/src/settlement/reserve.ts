/**
 * Stock reservations — Model A "hold, don't decrement" (settlement.md §7).
 * Oversell is impossible by invariant I (∀sku: 0 ≤ reserved ≤ stock_qty,
 * sold ≥ 0): every +reserved flows through a conditional UPDATE whose WHERE
 * re-checks sellability on the post-lock row version, and the table CHECK is
 * the engine-enforced second copy. All five mutation paths live here.
 *
 * Timestamps: callers pass `now` (Clock-derived — VirtualClock in demo/tests);
 * DB now() stamps audit columns so persistence stays wall-consistent.
 */
import type { PgPool } from "../db/client.js";
import { appendAudit } from "../audit/writer.js";
import type { SettlementLine } from "@growthagent/shared";

export class InsufficientStockError extends Error {
  constructor(public readonly sku: string) {
    super(`insufficient stock for ${sku}`);
    this.name = "InsufficientStockError";
  }
}

export class VelocityLimitExceededError extends Error {
  constructor(public readonly txId: string) {
    super(`identity velocity ceiling exceeded for ${txId}`);
    this.name = "VelocityLimitExceededError";
  }
}

/** Belt-and-braces tripwire: a release/commit found no counter to move. */
export class InvariantViolationError extends Error {
  constructor(
    public readonly txId: string,
    public readonly sku: string,
    public readonly op: string,
  ) {
    super(`invariant violation (${op}) on ${sku} for ${txId}`);
    this.name = "InvariantViolationError";
  }
}

export interface VelocityInput {
  readonly identityHash: string;
  readonly amountPaise: number;
  /** Dynamic ceilings come from merchant RULES as parameters — limits live in
   *  rules, never in DDL constants (§7.1 identity_velocity notes). */
  readonly maxTxPerIdentityPerDay: number;
  readonly maxValuePerIdentityPerDayPaise: number;
}

/** The shape every hold path needs from a settlement line. */
interface HoldLine {
  readonly sku: string;
  readonly qty: number;
  /** Made-to-order line (gatekeeper's `backorder_allowed_skus` exemption).
   *  No physical stock exists to hold, so NO inventory counter moves for it —
   *  the hold row is written purely so release/commit/expiry can account for
   *  the ordered units. Without this the gate would approve a backorder that
   *  `stock_qty - reserved >= qty` then refuses at settle time. */
  readonly backordered?: boolean | undefined;
}

/**
 * Collapse a cart to ONE entry per SKU, in lexicographic order.
 *
 * Two reasons this is mandatory rather than defensive:
 *  - `stock_reservations` is UNIQUE (tx_id, sku) (§7.1), so a cart carrying the
 *    same SKU twice would raise a unique violation mid-transaction;
 *  - `mintSettleable` legitimately emits TWO sub-lines for one SKU when the
 *    approved net does not divide evenly by quantity (the paise-remainder
 *    split), and both must land as a single hold of the summed quantity.
 * The lexicographic order is the deadlock-elimination ordering (§7.2).
 */
export function aggregateHoldLines(lines: readonly HoldLine[]): { sku: string; qty: number; backordered: boolean }[] {
  const bySku = new Map<string, { sku: string; qty: number; backordered: boolean }>();
  for (const l of lines) {
    const cur = bySku.get(l.sku);
    if (cur === undefined) {
      bySku.set(l.sku, { sku: l.sku, qty: l.qty, backordered: l.backordered === true });
      continue;
    }
    cur.qty += l.qty;
    // Sub-lines of one cart line always carry the same flag; OR is the safe read.
    cur.backordered = cur.backordered || l.backordered === true;
  }
  return [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

/**
 * Atomic multi-line reservation: the ENTIRE cart inside one database
 * transaction; any failure ROLLs BACK earlier lines (§7.2). The
 * identity_velocity upsert re-verifies BOTH ceilings under the same row lock,
 * closing the gate-snapshot TOCTOU where N concurrent approvals each read
 * "under the limit" — refusals abort the SAME transaction that took the holds.
 */
export async function reserveCart(
  db: PgPool,
  txId: string,
  lines: readonly SettlementLine[] | readonly HoldLine[],
  ttlMs: number,
  now: Date,
  velocity?: VelocityInput,
): Promise<"RESERVED"> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const expiresAt = new Date(now.getTime() + ttlMs);
    // One entry per SKU, lexicographic: deadlock elimination (§7.2 /
    // data-model-audit §2.14) AND the UNIQUE (tx_id, sku) contract.
    for (const line of aggregateHoldLines(lines)) {
      if (line.backordered) {
        // Made-to-order: nothing on the shelf to hold, so no counter moves and
        // no sellability guard. Recorded so release/commit see the units.
        await client.query(
          `INSERT INTO stock_reservations (tx_id, sku, qty, expires_at, backordered)
           VALUES ($1, $2, $3, $4, true)`,
          [txId, line.sku, line.qty, expiresAt],
        );
        continue;
      }
      const r = await client.query(
        `UPDATE inventory
            SET reserved = reserved + $1, updated_at = now()
          WHERE sku = $2
            AND stock_qty - reserved >= $1     -- THE guard: sellability re-checked
          RETURNING sku`,
        [line.qty, line.sku],
      );
      if (r.rowCount === 0) throw new InsufficientStockError(line.sku);
      await client.query(
        `INSERT INTO stock_reservations (tx_id, sku, qty, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [txId, line.sku, line.qty, expiresAt],
      );
    }
    if (velocity) {
      // Positional: [idHash, day, paise, maxTx, maxPaise]; $2/$3/$4/$5 repeat.
      // The SELECT…WHERE guard covers the FIRST insert of the day too — a
      // bare VALUES insert would admit an over-ceiling FIRST approval.
      const vel = await client.query(
        `INSERT INTO identity_velocity (identity_hash, day, approved_count, approved_paise)
         SELECT $1, $2, 1, $3::bigint
          WHERE 1 <= $4::int AND $3::bigint <= $5::bigint
         ON CONFLICT (identity_hash, day) DO UPDATE
           SET approved_count = identity_velocity.approved_count + 1,
               approved_paise = identity_velocity.approved_paise + $3::bigint
         WHERE identity_velocity.approved_count + 1 <= $4::int
           AND identity_velocity.approved_paise + $3::bigint <= $5::bigint`,
        [
          velocity.identityHash,
          now.toISOString().slice(0, 10),
          velocity.amountPaise,
          velocity.maxTxPerIdentityPerDay,
          velocity.maxValuePerIdentityPerDayPaise,
        ],
      );
      if (vel.rowCount === 0) throw new VelocityLimitExceededError(txId); // aborts the SAME tx
    }
    await client.query("COMMIT");
    return "RESERVED";
  } catch (e) {
    await client.query("ROLLBACK"); // whole-cart all-or-nothing
    if (e instanceof VelocityLimitExceededError) {
      appendAudit(txId, "settlement.reserve", "velocity.limit_exceeded", {});
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * §10.3 grace re-reservation (T10): flip the tx's own EXPIRED holds back to
 * ACTIVE with a renewed TTL, guarded by the SAME conditional-UPDATE guard as
 * reserveCart. The (tx_id, sku) UNIQUE constraint forbids inserting a second
 * hold row, so resurrection MUST reuse the existing rows — whole thing in
 * one transaction: any lost stock race rolls EVERYTHING back (holds stay
 * EXPIRED, counters untouched) and the caller proceeds down the T11 ladder.
 */
export async function reReserveExpiredHolds(
  db: PgPool,
  txId: string,
  ttlMs: number,
  now: Date,
): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query(
      `UPDATE stock_reservations
          SET status='ACTIVE', released_at=NULL, expires_at=$2, reserved_at=now()
        WHERE tx_id=$1 AND status IN ('EXPIRED','ACTIVE')
        RETURNING sku, qty, backordered`,
      [txId, new Date(now.getTime() + ttlMs)],
    );
    if ((rows.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false; // nothing to resurrect
    }
    for (const row of rows.rows as { sku: string; qty: number; backordered: boolean }[]) {
      if (row.backordered) continue; // never held a counter; nothing to re-take
      const r = await client.query(
        `UPDATE inventory SET reserved = reserved + $1, updated_at = now()
          WHERE sku = $2 AND stock_qty - reserved >= $1`,
        [row.qty, row.sku],
      );
      if ((r.rowCount ?? 0) === 0) throw new InsufficientStockError(row.sku);
    }
    await client.query("COMMIT");
    return true;
  } catch {
    await client.query("ROLLBACK"); // lost the stock race: leave everything as it was
    return false;
  } finally {
    client.release();
  }
}

/**
 * Release EVERY ACTIVE hold of one tx (T3/T8/T13 paths): the status CAS admits
 * exactly one winner per row, so double-release is a noop by construction
 * (§7.3 point 4). `reason` distinguishes reserve-failure / payment-failed /
 * merchant-decline in the audit trail.
 *
 * ONE TRANSACTION, like reserveCart. The status flip and the counter
 * decrements are the same fact stated twice; splitting them across pool
 * connections (as this used to) meant a crash — or any error on a later
 * line — left rows RELEASED (so no sweeper ever revisits them: the sweep keys
 * on status='ACTIVE') while `inventory.reserved` stayed incremented. That is a
 * PERMANENT phantom reservation: stock nobody can buy and nothing reclaims.
 * Rolling back returns the holds to ACTIVE so the next release/sweep retries.
 */
export async function releaseHolds(
  db: PgPool,
  txId: string,
  reason: "RESERVE_FAILED" | "PAYMENT_FAILED" | "MERCHANT_DECLINED",
  actor = "settlement.reserve",
): Promise<number> {
  const statusByReason = {
    RESERVE_FAILED: "RELEASED",
    PAYMENT_FAILED: "RELEASED",
    MERCHANT_DECLINED: "RELEASED",
  } as const;
  const client = await db.connect();
  let released = 0;
  try {
    await client.query("BEGIN");
    const rows = await client.query(
      `UPDATE stock_reservations
          SET status = $2, released_at = now()
        WHERE tx_id = $1 AND status = 'ACTIVE'
        RETURNING sku, qty, backordered`,
      [txId, statusByReason[reason]],
    );
    for (const row of rows.rows as { sku: string; qty: number; backordered: boolean }[]) {
      if (row.backordered) {
        released += row.qty; // recorded units, but no counter ever moved
        continue;
      }
      const dec = await client.query(
        `UPDATE inventory SET reserved = reserved - $1, updated_at = now()
          WHERE sku = $2 AND reserved >= $1`,
        [row.qty, row.sku],
      );
      if (dec.rowCount === 0) {
        // Never silently corrupt counters: tripwire, then abort the WHOLE
        // release so the holds stay ACTIVE and reclaimable.
        appendAudit(txId, actor, "invariant_violation_alert", { sku: row.sku, op: "release" });
        throw new InvariantViolationError(txId, row.sku, "release");
      }
      released += row.qty;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  if (released > 0) {
    appendAudit(txId, actor, "reservation.released", { units: released, reason });
  }
  return released;
}
