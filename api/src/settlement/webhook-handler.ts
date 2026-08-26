/**
 * Webhook ingress (settlement.md §8.3) — the ONLY mover of money-facts
 * (T7/T8/T10/T11). Contract: authenticate FIRST (parse nothing before the
 * HMAC line, V7), answer within Razorpay's 5-second budget (V9 — heavy work
 * like completion defers), ALWAYS 2xx once authenticated so the provider's
 * 24-h retry machine stands down.
 *
 * Mounted on a raw-body parser BEFORE the global JSON parser; the exact bytes
 * Razorpay signed are the only thing we hash.
 */
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import {
  canonicalJson,
  digestView,
  type SettleableProposal,
  type TxState,
} from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { appendAudit, auditGlobal } from "../audit/writer.js";
import {
  WebhookAuthenticationError,
  type ParsedWebhook,
  type SettlementProvider,
} from "./provider/types.js";
import { casTransition, isLegalTransition } from "./state-machine.js";
import { completeTransaction } from "./completion.js";
import { reReserveExpiredHolds, releaseHolds } from "./reserve.js";
import { nowEpochSec, type Clock } from "./clock.js";
import type { SettlementConfig } from "./config.js";

export interface RawRequest extends Request {
  rawBody?: Buffer;
}

export interface WebhookHandlerDeps {
  readonly db: PgPool;
  readonly provider: SettlementProvider;
  readonly config: SettlementConfig;
  readonly clock: Clock;
}

interface TxJoinRow {
  tx_id: string;
  state: string;
  /** Matches the SELECT alias below — a cast cannot paper over a key that
   *  isn't there at runtime (that bug signed every capture as a mismatch). */
  approved_total_paise: number;
  proposal_bytes: unknown;
  proposal_sha256: string;
  receipt: string;
  provider_kind: string;
}

export function webhookHandler(deps: WebhookHandlerDeps) {
  const { db, provider, config, clock } = deps;
  return async (req: RawRequest, res: Response): Promise<void> => {
    const rawBody = req.rawBody;
    if (!rawBody) {
      auditGlobal("settlement.webhook", "webhook.no_raw_body", {});
      res.status(400).end();
      return;
    }

    // 1) AUTHENTICATE FIRST — parse nothing before this line (V7).
    let parsed: ParsedWebhook;
    try {
      parsed = provider.verifyAndParseWebhook(
        rawBody,
        req.header("x-razorpay-signature") ?? null,
        req.header("x-razorpay-event-id") ?? null,
      );
    } catch (e) {
      if (e instanceof WebhookAuthenticationError) {
        // SECURITY event; rate-limit source. Never ACK garbage.
        auditGlobal("settlement.webhook", "webhook.signature_invalid", {});
        res.status(400).end();
        return;
      }
      throw e;
    }

    // 2) EVENT ID: header value is authoritative when present (V8) but NOT
    //    signature-covered (V7/U4) → advisory; digest of authenticated bytes
    //    is the fallback identity (already applied inside the parser).
    const eventId = parsed.event_id;

    // 3) FRESHNESS WINDOW (replay protection): signature-valid but ancient ⇒
    //    ignore politely with 2xx so the retry machine stops.
    const ageSec = nowEpochSec(clock) - parsed.occurred_at_epoch_sec;
    if (Math.abs(ageSec) > config.webhookFreshnessSec) {
      // tx unknown until lookup; order id rides in the payload.
      auditGlobal("settlement.webhook", "webhook.stale_ignored", {
        event_id: eventId,
        age_s: ageSec,
        order_id: parsed.kind === "ignored" ? null : parsed.payment.order_id,
      });
      res.status(200).json({ status: "ignored_stale" });
      return;
    }

    // 4) INSERT-FIRST DEDUPE, two-phase: crash after insert can't swallow the
    //    event (status stays RECEIVED for the sweeper).
    const payloadDigest = createHash("sha256").update(rawBody).digest("hex");
    const claim = await db.query(
      `INSERT INTO processed_webhook_events (event_id, status, payload_digest, payload)
       VALUES ($1, 'RECEIVED', $2, $3)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, payloadDigest, JSON.stringify(JSON.parse(rawBody.toString("utf8")))],
    );
    if ((claim.rowCount ?? 0) === 0) {
      // Duplicate delivery (V8: normal). Digest conflict ⇒ same claimed id,
      // different bytes — header spoof or hash collision; audit loudly, still ack.
      const stored = await db.query(
        `SELECT payload_digest FROM processed_webhook_events WHERE event_id = $1`,
        [eventId],
      );
      if (
        stored.rowCount &&
        (stored.rows[0].payload_digest as string) !== payloadDigest
      ) {
        auditGlobal("settlement.webhook", "webhook.digest_conflict", { event_id: eventId });
      } else {
        auditGlobal("settlement.webhook", "webhook.duplicate_ignored", { event_id: eventId });
      }
      res.status(200).json({ status: "duplicate_ack" });
      return;
    }

    // 5) DISPATCH — handlers are O(1)-indexed and CAS-guarded; completion is
    //    deferred out of the response budget (V9).
    try {
      await dispatchParsed(deps, parsed);
      await db.query(`UPDATE processed_webhook_events SET status='PROCESSED', processed_at=now()
                       WHERE event_id = $1`, [eventId]);
    } catch (e) {
      // Leave status='RECEIVED': sweeper re-drives rows older than 60 s (W6).
      auditGlobal("settlement.webhook", "webhook.process_error", {
        event_id: eventId,
        err: String(e),
      });
    }
    res.status(200).json({ status: "ok" }); // ALWAYS 2xx once authenticated
  };
}

/**
 * The dispatch core, shared by the HTTP ingress AND the W6 sweeper redrive
 * (rows whose bytes were HMAC-verified at first receipt). Every branch is
 * idempotent (CAS + triple-match), so at-least-once delivery has
 * effect-exactly-once.
 */
export async function dispatchParsed(
  deps: WebhookHandlerDeps,
  parsed: ParsedWebhook,
): Promise<void> {
  const { db, provider, config, clock } = deps;
  switch (parsed.kind) {
    case "payment.captured":
    case "order.paid": // V11: both entities; no ordering guarantee ⇒ first wins
      await onCapture(db, provider, config, clock, parsed);
      break;
    case "payment.failed":
      await onFailure(db, parsed);
      break;
    case "ignored":
      break; // authenticated, deduped, ACKed, ignored (§14.8)
  }
}

/* ------------------------------ dispatches ------------------------------ */

async function onCapture(
  db: PgPool,
  provider: SettlementProvider,
  config: SettlementConfig,
  clock: Clock,
  w: Extract<ParsedWebhook, { kind: "payment.captured" | "order.paid" }>,
): Promise<void> {
  const pay = w.payment;
  const ord = w.kind === "order.paid" ? w.order : null;
  const hit = await db.query(
    `SELECT t.tx_id, t.state, t.approved_total_paise, t.proposal_bytes,
            t.proposal_sha256, t.receipt, t.provider_kind
       FROM razorpay_orders o JOIN transactions t USING (tx_id)
      WHERE o.rzp_order_id = $1`,
    [pay.order_id],
  );
  if ((hit.rowCount ?? 0) === 0) {
    auditGlobal("settlement.webhook", "webhook.unknown_order", { order_id: pay.order_id });
    return;
  }
  const tx = hit.rows[0] as TxJoinRow;

  // Triple-match + frozen-bytes + armed-provider check BEFORE any state move
  // (defense-in-depth behind the gatekeeper). Never auto-complete a
  // tampered-looking match. canonicalJson re-hash over the digestView
  // convention: PG JSONB does not preserve key order, so byte-equality is
  // asserted over the CANONICAL form — the same form settle() hashed at T1.
  // NOTE: approved_total_paise is BIGINT ⇒ node-pg yields a STRING; compare
  // numerically or every honest capture reads as a mismatch.
  const expectedPaise = Number(tx.approved_total_paise);
  const frozenBytesOk =
    createHash("sha256")
      .update(canonicalJson(digestView(tx.proposal_bytes as SettleableProposal)), "utf8")
      .digest("hex") === tx.proposal_sha256;
  const providerMismatch = tx.provider_kind !== provider.kind;
  const mismatch =
    pay.amount !== expectedPaise ||
    pay.currency !== "INR" ||
    (ord !== null && ord.receipt !== tx.receipt) ||
    !frozenBytesOk ||
    providerMismatch;
  if (mismatch) {
    const from = tx.state as TxState;
    if (isLegalTransition(from, "MANUAL_REFUND_REQUIRED")) {
      await casTransition(db, tx.tx_id, from, "MANUAL_REFUND_REQUIRED");
    } // terminal states keep their state; the audits + inbox item stand either way
    appendAudit(
      tx.tx_id,
      "settlement.webhook",
      providerMismatch ? "payment.provider_mismatch" : "payment.amount_mismatch",
      { expected_paise: expectedPaise, got_paise: pay.amount },
    );
    appendAudit(tx.tx_id, "settlement.inbox", "human_review_enqueued", {
      reason: "AMOUNT_MISMATCH",
    });
    return;
  }

  if (tx.state === "AWAITING_PAYMENT") {
    const r = await casTransition(db, tx.tx_id, "AWAITING_PAYMENT", "PAID", {
      pay_id: pay.id,
    }); // T7 — webhook handler is the ONLY mover of money-facts
    if (r.advanced) {
      appendAudit(tx.tx_id, "settlement.webhook", "tx.paid", { pay_id: pay.id });
      queueCompletion(db, tx.tx_id);
    }
    // Lost CAS ⇒ duplicate-by-race (PAID/COMPLETED already): idempotent noop.
  } else if (tx.state === "EXPIRED") {
    await lateCapturePolicy(db, config, clock, tx, pay); // T10/T11 ladder, §10.3
  }
  // PAID/COMPLETED ⇒ duplicate-by-race: no-op, idempotent 200 (§12 matrix).
}

/** §10.3 deterministic ladder: within grace AND re-reserve succeeds → PAID
 *  (exceptional backward move, loudly audited); otherwise the money was
 *  taken but stock is gone → MANUAL_REFUND_REQUIRED + inbox item. */
async function lateCapturePolicy(
  db: PgPool,
  config: SettlementConfig,
  clock: Clock,
  tx: TxJoinRow & { provider_kind: string },
  pay: { id: string },
): Promise<void> {
  const expiredAt = await db.query(`SELECT expired_at FROM transactions WHERE tx_id = $1`, [
    tx.tx_id,
  ]);
  const expiredMs = expiredAt.rows[0]?.expired_at
    ? new Date(expiredAt.rows[0].expired_at as string).getTime()
    : clock.nowMs();
  const withinGrace = clock.nowMs() - expiredMs <= config.lateCaptureGraceMs;

  // Grace re-resurrection REUSES the tx's own expired holds — the (tx_id,sku)
  // UNIQUE constraint forbids a second hold row (§7.1), so this is a status
  // flip under the standard guarded UPDATE, all-or-nothing.
  const reReserved = withinGrace
    ? await reReserveExpiredHolds(db, tx.tx_id, config.reservationTtlMs, new Date(clock.nowMs()))
    : false;

  if (withinGrace && reReserved) {
    const r = await casTransition(db, tx.tx_id, "EXPIRED", "PAID", { pay_id: pay.id }); // T10
    if (r.advanced) {
      appendAudit(tx.tx_id, "settlement.webhook", "tx.grace_resurrected", { pay_id: pay.id });
      queueCompletion(db, tx.tx_id);
    }
  } else {
    await casTransition(db, tx.tx_id, "EXPIRED", "MANUAL_REFUND_REQUIRED"); // T11
    appendAudit(tx.tx_id, "settlement.webhook", "tx.manual_refund_required", {
      within_grace: withinGrace,
    });
    appendAudit(tx.tx_id, "settlement.inbox", "human_review_enqueued", {
      reason: withinGrace ? "GRACE_RERESERVE_LOST" : "LATE_CAPTURE_BEYOND_GRACE",
    });
  }
}

async function onFailure(
  db: PgPool,
  w: Extract<ParsedWebhook, { kind: "payment.failed" }>,
): Promise<void> {
  const hit = await db.query(
    `SELECT t.tx_id, t.state FROM razorpay_orders o JOIN transactions t USING (tx_id)
      WHERE o.rzp_order_id = $1`,
    [w.payment.order_id],
  );
  if ((hit.rowCount ?? 0) === 0) {
    auditGlobal("settlement.webhook", "webhook.unknown_order", { order_id: w.payment.order_id });
    return;
  }
  const row = hit.rows[0] as { tx_id: string; state: string };
  if (row.state !== "AWAITING_PAYMENT") return; // raced/expired: holds handled elsewhere
  const r = await casTransition(db, row.tx_id, "AWAITING_PAYMENT", "FAILED"); // T8
  if (r.advanced) {
    appendAudit(row.tx_id, "settlement.webhook", "tx.failed", {
      error_code: w.payment.error_code,
    });
    await releaseHolds(db, row.tx_id, "PAYMENT_FAILED"); // instantly reclaimable
  }
}

/** Deferred out of the 5-second budget: fire-and-forget; W7 sweeper re-drives
 *  any failure (CAS latch makes reruns noops). */
function queueCompletion(db: PgPool, txId: string): void {
  void completeTransaction(db, txId).catch(() => {
    /* sweep re-drives PAID rows; audited inside completeTransaction */
  });
}
