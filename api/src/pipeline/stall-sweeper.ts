/**
 * api/src/pipeline/stall-sweeper.ts — audit 13.1 / H3.
 *
 * `enqueue` fires `runPipeline` DETACHED. If a run dies before routing (an
 * unexpected throw, an OOM, a `kill -9`), `proposal_txs` keeps whatever stage it
 * reached with `outcome_json = NULL` — and NOTHING ever revisits it:
 *   - the buyer poll reports that stage forever (§5.2 renders NULL outcome as
 *     "still pending"),
 *   - the SSE stream's close condition is `outcome_json IS NOT NULL`, so the
 *     socket, its 15 s heartbeat and its 1 s terminal poll never stop,
 *   - the settlement sweeper only ever looked at `transactions`, and a run that
 *     died before the gate has no `transactions` row at all.
 *
 * Two closures, matching the two ways a run can die:
 *   - `failRunNow` is what the composition root's `.catch()` calls: an in-process
 *     rejection knows immediately that the run is over, so the terminal FAILED
 *     outcome lands with no delay.
 *   - `sweepStalledProposals` covers the process actually dying, where no catch
 *     ever runs. It is time-based, so the threshold must exceed the slowest
 *     legitimate stage (an LLM negotiation with retries) — hence 120 s, not 30.
 *
 * Both write through the SAME conditional UPDATE (`outcome_json IS NULL`), so a
 * run that finished between the check and the write is never overwritten, and
 * the two paths racing each other resolve to exactly one write.
 */
import type { PgPool } from "../db/client.js";
import { appendAudit } from "../audit/writer.js";

/** Slowest legitimate stage + headroom: `updated_at` is only bumped on stage
 *  transitions, so a live NIM negotiation can sit still for a while. */
export const DEFAULT_STALL_AFTER_MS = 120_000;

export interface StalledRunFailure {
  /** Terminal `failure.reason` surfaced to the buyer poll. */
  readonly reason: string;
  readonly retryable: boolean;
}

/**
 * Record a terminal FAILED outcome for a run that never routed. Returns true if
 * THIS call was the one that closed it out (0 rows ⇒ it had already finished, or
 * there is no claim row yet — either way nothing to do).
 */
export async function failRunNow(
  db: PgPool,
  txId: string,
  failure: StalledRunFailure,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE proposal_txs
        SET stage = 'TERMINAL',
            outcome_json = $2,
            updated_at = now(),
            finished_at = now()
      WHERE tx_id = $1 AND outcome_json IS NULL
      RETURNING stage`,
    [
      txId,
      JSON.stringify({
        outcome: "FAILED",
        // `stage` is filled by the poll projection from the row's own stage when
        // absent; naming it here keeps the stored bytes self-describing.
        failure: { stage: "TERMINAL", reason: failure.reason, retryable: failure.retryable },
      }),
    ],
  );
  const closed = (r.rowCount ?? 0) > 0;
  if (closed) {
    appendAudit(txId, "pipeline.stall_sweeper", "pipeline.run_failed", {
      reason: failure.reason,
      retryable: failure.retryable,
    });
  }
  return closed;
}

/**
 * Close out every run that has been sitting without an outcome for longer than
 * `staleAfterMs`. Returns the tx ids it closed.
 */
export async function sweepStalledProposals(
  db: PgPool,
  opts: { readonly now: Date; readonly staleAfterMs?: number } ,
): Promise<string[]> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALL_AFTER_MS;
  const cutoff = new Date(opts.now.getTime() - staleAfterMs);
  const r = await db.query(
    `UPDATE proposal_txs
        SET stage = 'TERMINAL',
            outcome_json = $2,
            updated_at = now(),
            finished_at = now()
      WHERE outcome_json IS NULL AND updated_at < $1
      RETURNING tx_id, stage`,
    [
      cutoff,
      JSON.stringify({
        outcome: "FAILED",
        failure: {
          stage: "TERMINAL",
          reason: "PIPELINE_STALLED",
          // The buyer may safely resubmit under a NEW idempotency key: nothing
          // was settled (a settled run has an outcome) and no money moved.
          retryable: true,
        },
      }),
    ],
  );
  const ids = (r.rows as { tx_id: string }[]).map((row) => row.tx_id);
  for (const txId of ids) {
    appendAudit(txId, "pipeline.stall_sweeper", "pipeline.run_failed", {
      reason: "PIPELINE_STALLED",
      retryable: true,
      stale_after_ms: staleAfterMs,
    });
  }
  return ids;
}
