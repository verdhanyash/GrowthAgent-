/**
 * Transaction state machine (settlement.md §6). The transition authority
 * table IS data; every mutation of transactions.state goes through
 * casTransition(), which refuses any pair not listed. Illegal attempts are
 * AUDITED, never silently ignored (§6); legal pairs that lose a CAS race are
 * ordinary concurrency (§14 edge 5) and reported distinctly so callers and
 * the trace screen can tell sabotage apart from scheduling.
 */
import type { PgPool } from "../db/client.js";
import { appendAudit } from "../audit/writer.js";
import type { TxState } from "@growthagent/shared";

/** Transition authority table — T1…T13 of settlement.md §6, encoded as data.
 *  Terminal states (COMPLETED/FAILED/RELEASED/REJECTED_BY_MERCHANT/
 *  MANUAL_REFUND_REQUIRED) have no outgoing edges by construction.
 *
 *  ADJUDICATION (BUILD_LOG M6): §8.3's onCapture sends ANY tampered-looking
 *  match to MANUAL_REFUND_REQUIRED ("never auto-complete"), while the §6
 *  table only lists EXPIRED→MANUAL_REFUND_REQUIRED (T11). The money-fact
 *  wins: every state holding STOCK or a CAPTURED PAYMENT gains a
 *  MANUAL_REFUND_REQUIRED edge — value we cannot honestly fulfil must always
 *  have somewhere to go. PROPOSAL_APPROVED deliberately has none: nothing is
 *  reserved or charged there, so RELEASED/FAILED/REJECTED_BY_MERCHANT cover it.
 */
const TRANSITIONS: Readonly<Record<TxState, readonly TxState[]>> = {
  PROPOSAL_APPROVED: ["STOCK_RESERVED", "RELEASED", "FAILED", "REJECTED_BY_MERCHANT"], // T2/T3/T13
  STOCK_RESERVED: ["ORDER_CREATING", "RZP_ORDER_CREATED", "FAILED", "MANUAL_REFUND_REQUIRED"],
  ORDER_CREATING: ["RZP_ORDER_CREATED", "FAILED", "MANUAL_REFUND_REQUIRED"], // T4b/T5
  RZP_ORDER_CREATED: ["AWAITING_PAYMENT", "FAILED", "MANUAL_REFUND_REQUIRED"], // T6/T5
  AWAITING_PAYMENT: ["PAID", "FAILED", "EXPIRED", "MANUAL_REFUND_REQUIRED"], // T7/T8/T9
  PAID: ["COMPLETED", "MANUAL_REFUND_REQUIRED"], // T12 / post-payment tamper
  EXPIRED: ["PAID", "MANUAL_REFUND_REQUIRED"], // T10 grace / T11
  COMPLETED: [],
  FAILED: [],
  RELEASED: [],
  REJECTED_BY_MERCHANT: [],
  MANUAL_REFUND_REQUIRED: [],
};

export function isLegalTransition(from: TxState, to: TxState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly txId: string,
    public readonly from: TxState,
    public readonly to: TxState,
  ) {
    super(`illegal transition ${from} → ${to} for ${txId}`);
    this.name = "IllegalTransitionError";
  }
}

/** Which timestamp column each arrival state stamps — keeps the CAS to one
 *  statement so the latch stays race-free. */
const ARRIVAL_TS_COLUMN: Partial<Record<TxState, string>> = {
  STOCK_RESERVED: "reserved_at",
  PAID: "paid_at",
  EXPIRED: "expired_at",
  COMPLETED: "completed_at",
  FAILED: "failed_at",
};

export interface CasResult {
  /** true ⇒ THIS statement moved the row (the winner speaks). */
  advanced: boolean;
  /** Current DB state when the CAS refused; null when the row is gone. */
  currentState: TxState | null;
}

/**
 * THE only writer of transactions.state outside completion's own latched
 * transaction. `extra` binds additional columns into the SAME guarded UPDATE
 * (e.g. pay_id on T7), never as a second write.
 */
export async function casTransition(
  db: PgPool,
  txId: string,
  from: TxState,
  to: TxState,
  extra: { pay_id?: string } = {},
): Promise<CasResult> {
  if (!isLegalTransition(from, to)) {
    appendAudit(txId, "settlement.state-machine", "illegal_transition_attempt", { from, to });
    const current = await currentStateOf(db, txId);
    return { advanced: false, currentState: current };
  }

  const sets = ["state = $2", "updated_at = now()"];
  const vals: unknown[] = [txId, to];
  const tsCol = ARRIVAL_TS_COLUMN[to];
  if (tsCol) sets.push(`${tsCol} = now()`);
  if (extra.pay_id !== undefined) {
    vals.push(extra.pay_id);
    sets.push(`pay_id = $${vals.length}`);
  }
  vals.push(from);
  const fromParam = `$${vals.length}`;
  const r = await db.query(
    `UPDATE transactions SET ${sets.join(", ")} WHERE tx_id = $1 AND state = ${fromParam}`,
    vals,
  );
  if (r.rowCount === 1) return { advanced: true, currentState: to };

  // Legal pair, lost race — the row already moved on (§14 edge 5).
  return { advanced: false, currentState: await currentStateOf(db, txId) };
}

async function currentStateOf(db: PgPool, txId: string): Promise<TxState | null> {
  const r = await db.query("SELECT state FROM transactions WHERE tx_id = $1", [txId]);
  return r.rowCount === 0 ? null : (r.rows[0].state as TxState);
}
