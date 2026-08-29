/**
 * settle() — the happy-path entry point (settlement.md §9). Deliberately
 * dumb: zero LLM, zero pricing math. It executes exactly what the gatekeeper
 * approved; its cheap re-checks (digest equality, stock still reservable)
 * exist because DISK state may have drifted between approve and execute,
 * not because it doubts the gatekeeper (§1.2).
 *
 * Crash-window coverage: every step is either idempotent-by-construction or
 * CAS-claimed (W1–W5 of §10.1); the sweeper resumes anything left behind.
 */
import { createHash } from "node:crypto";
import {
  type SettleableProposal,
  canonicalJson,
  digestView,
} from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { appendAudit } from "../audit/writer.js";
import { casTransition } from "./state-machine.js";
import {
  reserveCart,
  releaseHolds,
  VelocityLimitExceededError,
  InsufficientStockError,
  type VelocityInput,
} from "./reserve.js";
import { ensureOrder, receiptFor } from "./ensure-order.js";
import { SettlementRejectedError } from "./errors.js";
import { classify } from "./classify.js";
import type { Clock } from "./clock.js";
import type { SettlementProvider } from "./provider/types.js";
import type { SettlementConfig } from "./config.js";

export interface SettleDeps {
  readonly db: PgPool;
  readonly provider: SettlementProvider;
  readonly config: SettlementConfig;
  readonly clock: Clock;
  /** TB-2b authoritative velocity ceilings (merchant rules); pipeline wires
   *  the buyer identity in later — absent ⇒ no ledger increment this call. */
  readonly velocity?: VelocityInput;
  /** Single-use HUMAN_ESCALATION token consumer (§11) — lands with the
   *  approvals-inbox milestone; escalated settles REFUSE until wired. */
  readonly consumeApprovalToken?: (p: SettleableProposal) => Promise<void>;
}

/** Per-CALL settle options (deps are per-app; these are per-request). */
export interface SettleOptions {
  /**
   * Authenticated agent that owns this tx (E-11). Stamped into
   * `transactions.agent_id` so the buyer read route can enforce ownership.
   * Omitted ⇒ NULL (a settle with no attributable caller); the column is
   * nullable so in-process/legacy callers stay valid.
   */
  readonly ownerAgentId?: string;
}

export interface SettleResult {
  readonly httpStatus: number;
  readonly response: {
    tx_id: string;
    state: string;
    rzp_order_id: string | null;
    amount_paise: number;
    currency: "INR";
    lines: ReadonlyArray<{ sku: string; qty: number; unit_price_paise: number }>;
  };
}

/** Deterministic receipt fn(tx_id) lives with its only writer (ensure-order). */
export { receiptFor };

export async function settle(p: SettleableProposal, deps: SettleDeps, opts: SettleOptions = {}): Promise<SettleResult> {
  const { db, provider, config, clock } = deps;

  // -- step 1: shape-level trust checks ------------------------------------
  // Frozen-digest check (§1.2): the bytes handed to us must still hash to
  // what approval bound — over the digestView convention (digest binds all
  // bytes except itself). A mismatch means the proposal MUTATED between
  // approve and execute; refuse loudly, never settle a drifted cart.
  const digest = createHash("sha256")
    .update(canonicalJson(digestView(p)), "utf8")
    .digest("hex");
  if (digest !== p.proposal_sha256) {
    throw new SettlementRejectedError(
      "PROPOSAL_DIGEST_MISMATCH",
      "proposal bytes no longer match the approved digest",
      400,
    );
  }
  if (deps.consumeApprovalToken && p.approval_source === "HUMAN_ESCALATION") {
    await deps.consumeApprovalToken(p); // single-use; 0 rows ⇒ caller throws 409
  } else if (p.approval_source === "HUMAN_ESCALATION") {
    throw new SettlementRejectedError(
      "ESCALATION_REENTRY_NOT_WIRED",
      "human-escalation re-entry requires the approvals inbox (M7)",
      501,
    );
  }

  // -- step 2: tx row (T1) — frozen proposal bytes + digest ----------------
  const inserted = await db.query(
    `INSERT INTO transactions
       (tx_id, state, proposal_bytes, proposal_sha256, approved_total_paise,
        ruleset_version, gatekeeper_trace_digest, approval_source, provider_kind, receipt, agent_id)
     VALUES ($1,'PROPOSAL_APPROVED',$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tx_id) DO NOTHING
     RETURNING tx_id`,
    [
      p.tx_id,
      JSON.stringify(p),
      p.proposal_sha256,
      p.total_amount_paise,
      p.gatekeeper.ruleset_version,
      p.gatekeeper.trace_digest,
      p.approval_source,
      provider.kind,
      receiptFor(p.tx_id),
      opts.ownerAgentId ?? null,
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    // Same tx_id re-settled under a fresh idempotency key: never double-move.
    throw new SettlementRejectedError("TX_ALREADY_SETTLED", `${p.tx_id} already exists`, 409);
  }
  appendAudit(p.tx_id, "settlement", "settlement.started", {
    provider_kind: provider.kind,
    approval_source: p.approval_source,
    ruleset_version: p.gatekeeper.ruleset_version,
    total_amount_paise: p.total_amount_paise,
  });

  // -- step 3: reserve cart (T2 | T3) ---------------------------------------
  try {
    await reserveCart(db, p.tx_id, p.lines, config.reservationTtlMs, new Date(clock.nowMs()), deps.velocity);
  } catch (e) {
    if (e instanceof InsufficientStockError) {
      await casTransition(db, p.tx_id, "PROPOSAL_APPROVED", "RELEASED");
      appendAudit(p.tx_id, "settlement", "stock.reserve_failed", { sku: e.sku });
      throw new SettlementRejectedError(
        "STOCK_UNAVAILABLE",
        `sku ${e.sku} is no longer available`,
        409,
        { sku: e.sku },
      );
    }
    if (e instanceof VelocityLimitExceededError) {
      await casTransition(db, p.tx_id, "PROPOSAL_APPROVED", "RELEASED");
      throw new SettlementRejectedError("VELOCITY_LIMIT_EXCEEDED", "buyer velocity ceiling reached at commit time", 409);
    }
    throw e; // infra failure: tx row stays PROPOSAL_APPROVED → W1 sweep resume
  }
  const advancedToReserved = await casTransition(db, p.tx_id, "PROPOSAL_APPROVED", "STOCK_RESERVED");
  if (!advancedToReserved.advanced) {
    // Someone else moved it — treat as claim-lost; nothing further here.
    throw new SettlementRejectedError("TX_STATE_RACE", `${p.tx_id} moved during settle`, 409);
  }
  appendAudit(p.tx_id, "settlement", "stock.reserved", {});

  // -- step 4: order creation via claim-first CAS (T4a/T4b/T4/T6/T5) --------
  let rzpOrderId: string | null = null;
  try {
    const handle = await ensureOrder(provider, db, p);
    if (handle !== null) rzpOrderId = handle.rzp_order_id;
  } catch (e) {
    const kind = classify(e);
    if (kind === "RETRYABLE_EXHAUSTED" || kind === "CHAOS_FORCED") {
      // §12 / §14.14: gateway errors degrade to 503 retryable — holds stay,
      // intent row stays INTENT, the W3/W4 receipt-retry sweep resolves.
      appendAudit(p.tx_id, "settlement", "rzp.order_create_retryable", { err: String(e) });
      throw new SettlementRejectedError(
        "PROVIDER_UNAVAILABLE",
        "payment gateway temporarily unavailable",
        503,
        { retryable: true },
      );
    }
    // T5: non-duplicate, unrecoverable rejection — release holds, FAILED.
    await releaseHolds(db, p.tx_id, "RESERVE_FAILED");
    await casTransition(db, p.tx_id, "ORDER_CREATING", "FAILED");
    appendAudit(p.tx_id, "settlement", "rzp.order_create_failed", { err: String(e) });
    throw e instanceof SettlementRejectedError
      ? e
      : new SettlementRejectedError("ORDER_CREATE_FAILED", String(e), 502);
  }
  if (rzpOrderId === null) {
    // Claim lost to a concurrent worker/sweep that owns creation.
    throw new SettlementRejectedError("ORDER_CLAIM_LOST", "another worker owns order creation", 409);
  }

  return {
    httpStatus: 201,
    response: {
      tx_id: p.tx_id,
      state: "AWAITING_PAYMENT",
      rzp_order_id: rzpOrderId,
      amount_paise: p.total_amount_paise,
      currency: "INR",
      lines: p.lines.map((l) => ({ ...l })),
    },
  };
}
