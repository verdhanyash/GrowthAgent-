/**
 * Layer-2 order creation (settlement.md §8.2): claim-first CAS, intent row
 * persisted BEFORE the network call, receipt uniqueness as the provider-side
 * idempotency mirror (V3). Crash windows W3/W4 resolve through the SAME
 * receipt: a retry the provider never saw simply creates; one it DID see
 * comes back DuplicateReceiptError → AMBIGUOUS + ops event — never a blind
 * third attempt. Also owns the T4b + T6 advances on success.
 */
import type { SettleableProposal } from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { auditGlobal, appendAudit } from "../audit/writer.js";
import { casTransition } from "./state-machine.js";
import {
  DuplicateReceiptError,
  type SettlementOrderHandle,
  type SettlementProvider,
} from "./provider/types.js";

export class OrderAmbiguityError extends Error {
  constructor(public readonly txId: string) {
    super(`order ambiguity for ${txId}: orphan provider order exists`);
    this.name = "OrderAmbiguityError";
  }
}

/** Deterministic receipt fn(tx_id): 'ga_' + 26-char ULID = 29 chars ≤ 40 (V3,
 *  §14.24 keeps an env-prefix extension open). */
export function receiptFor(txId: string): string {
  return `ga_${txId.slice("tx_".length)}`;
}

/**
 * `skipClaim` is the W3/W4 sweeper entry: the crashed winner already holds
 * ORDER_CREATING, so the sweep retries creation WITHOUT re-contending the
 * CAS. Direct callers always contend.
 */
export async function ensureOrder(
  provider: SettlementProvider,
  db: PgPool,
  p: SettleableProposal,
  opts: { skipClaim?: boolean; identityHash?: string } = {},
): Promise<SettlementOrderHandle | null> {
  if (!opts.skipClaim) {
    const claim = await casTransition(db, p.tx_id, "STOCK_RESERVED", "ORDER_CREATING"); // T4a
    if (!claim.advanced) {
      // Another worker owns creation — return WITHOUT touching the network.
      auditGlobal("settlement.order", "order.claim_lost", { tx_id: p.tx_id });
      return null;
    }
  }

  const receipt = receiptFor(p.tx_id);
  const ins = await db.query(
    `INSERT INTO razorpay_orders (tx_id, receipt, provider, amount_paise, currency, status)
     VALUES ($1, $2, $3, $4, 'INR', 'INTENT')
     ON CONFLICT (tx_id) DO NOTHING
     RETURNING rzp_order_id`,
    [p.tx_id, receipt, provider.kind, p.total_amount_paise],
  );
  if ((ins.rowCount ?? 0) === 0) {
    const existing = await db.query(
      `SELECT rzp_order_id, status FROM razorpay_orders WHERE tx_id = $1`,
      [p.tx_id],
    );
    const row = existing.rows[0] as { rzp_order_id: string | null; status: string } | undefined;
    if (row?.rzp_order_id) {
      // Already created by a prior attempt: REUSE — advance any lagging
      // state (W5) and hand back the durable handle. Lagging CAS pairs no-op
      // when the tx is already ahead.
      await casTransition(db, p.tx_id, "ORDER_CREATING", "RZP_ORDER_CREATED"); // T4b (W5)
      await casTransition(db, p.tx_id, "RZP_ORDER_CREATED", "AWAITING_PAYMENT"); // T6
      return {
        provider: provider.kind,
        rzp_order_id: row.rzp_order_id,
        receipt,
        amount_paise: p.total_amount_paise,
        currency: "INR",
        provider_status: "created",
      };
    }
    if (row?.status === "AMBIGUOUS") throw new OrderAmbiguityError(p.tx_id);
    // status INTENT → a prior attempt crashed mid-step; fall through and
    // (re)create with the SAME receipt (W3).
  }

  try {
    const handle = await provider.createOrder({
      tx_id: p.tx_id,
      receipt,
      amount_paise: p.total_amount_paise,
      currency: "INR",
      notes: buildNotes(p, provider.kind, opts.identityHash),
    });
    await db.query(
      `UPDATE razorpay_orders SET rzp_order_id = $2, status = 'CREATED'
        WHERE tx_id = $1 AND status = 'INTENT'`,
      [p.tx_id, handle.rzp_order_id],
    );
    await casTransition(db, p.tx_id, "ORDER_CREATING", "RZP_ORDER_CREATED"); // T4b
    await casTransition(db, p.tx_id, "RZP_ORDER_CREATED", "AWAITING_PAYMENT"); // T6, same tick
    appendAudit(p.tx_id, "settlement.order", "rzp.order_created", {
      rzp_order_id: handle.rzp_order_id,
    });
    return handle;
  } catch (e) {
    if (e instanceof DuplicateReceiptError) {
      // A prior attempt DID reach Razorpay but we never learned its order id.
      await db.query(`UPDATE razorpay_orders SET status = 'AMBIGUOUS' WHERE tx_id = $1`, [
        p.tx_id,
      ]);
      appendAudit(p.tx_id, "settlement.order", "rzp.order_ambiguous", {});
      // Policy: the orphan order is HARMLESS — its id was never returned to
      // any buyer, so nobody can pay it. Sweep tries adoption via
      // fetch-by-receipt if the API supports it (U1 ⚠️); otherwise ops.
      // We NEVER blind-retry.
      throw new OrderAmbiguityError(p.tx_id);
    }
    throw e;
  }
}

/** ≤15 pairs budget (V4); values are IDs/hashes only — never prices (§4).
 *  Overflow shaping/truncation lives in buildCreateOrderBody (both providers),
 *  audited there as notes.truncated. */
function buildNotes(
  p: SettleableProposal,
  kind: string,
  identityHash?: string,
): Record<string, string> {
  const notes: Record<string, string> = {
    tx_id: p.tx_id,
    proposal_id: p.proposal_id,
    gk_trace: p.gatekeeper.trace_digest,
    provider: kind,
  };
  if (identityHash) notes["agent"] = identityHash;
  return notes;
}
