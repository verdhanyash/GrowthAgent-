/**
 * stall-sweeper.spec.ts — audit 13.1 / H3.
 *
 * `enqueue` fires the pipeline detached, so a run that dies before routing left
 * `proposal_txs` with `outcome_json = NULL` forever: the buyer poll reported the
 * stage it died in, the SSE stream's close condition never fired, and nothing
 * swept it (the settlement sweeper only reads `transactions`, and a pre-gate
 * death has no `transactions` row at all).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryAuditSink, setAuditSink } from "../../audit/writer.js";
import { DEFAULT_STALL_AFTER_MS, failRunNow, sweepStalledProposals } from "../stall-sweeper.js";
import { closeDb, db, nextTxId, truncateAll } from "./harness.js";

setAuditSink(new MemoryAuditSink());

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** An in-flight run: a claim row with a stage but no outcome yet. */
async function openRun(stage: string, ageMs: number): Promise<string> {
  const txId = nextTxId();
  await db.query(
    `INSERT INTO proposal_txs (tx_id, agent_id, agent_key_hash, request_bytes, stage, updated_at)
     VALUES ($1, 'buyer_test', repeat('a', 64), '{}'::jsonb, $2, now() - ($3 || ' milliseconds')::interval)`,
    [txId, stage, String(ageMs)],
  );
  return txId;
}

async function row(txId: string): Promise<{ stage: string; outcome_json: Record<string, unknown> | null; finished_at: string | null }> {
  const r = await db.query(`SELECT stage, outcome_json, finished_at FROM proposal_txs WHERE tx_id=$1`, [txId]);
  return r.rows[0] as { stage: string; outcome_json: Record<string, unknown> | null; finished_at: string | null };
}

describe("failRunNow — the detached-rejection path", () => {
  it("closes an open run out as terminal FAILED, retryable", async () => {
    const txId = await openRun("NEGOTIATING", 0);
    expect(await failRunNow(db, txId, { reason: "BOOM", retryable: true })).toBe(true);
    const r = await row(txId);
    expect(r.stage).toBe("TERMINAL");
    expect(r.finished_at).not.toBeNull();
    expect(r.outcome_json).toMatchObject({
      outcome: "FAILED",
      failure: { reason: "BOOM", retryable: true },
    });
  });

  it("NEVER overwrites a run that already reached an outcome", async () => {
    const txId = await openRun("SETTLING", 0);
    await db.query(
      `UPDATE proposal_txs SET outcome_json = '{"outcome":"APPROVED","rzp_order_id":"order_mock_1"}' WHERE tx_id=$1`,
      [txId],
    );
    expect(await failRunNow(db, txId, { reason: "BOOM", retryable: true })).toBe(false);
    expect((await row(txId)).outcome_json).toMatchObject({ outcome: "APPROVED" });
  });

  it("is a noop for a tx that never claimed a row", async () => {
    expect(await failRunNow(db, nextTxId(), { reason: "BOOM", retryable: false })).toBe(false);
  });

  it("two concurrent closers resolve to exactly one write", async () => {
    const txId = await openRun("GATE_CHECKING", 0);
    const [a, b] = await Promise.all([
      failRunNow(db, txId, { reason: "A", retryable: true }),
      failRunNow(db, txId, { reason: "B", retryable: true }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe("sweepStalledProposals — the process-died path", () => {
  it("closes runs older than the threshold and reports them", async () => {
    const stalled = await openRun("NEGOTIATING", DEFAULT_STALL_AFTER_MS + 60_000);
    const fresh = await openRun("NEGOTIATING", 5_000);

    const closed = await sweepStalledProposals(db, { now: new Date() });
    expect(closed).toEqual([stalled]);

    expect(await row(stalled)).toMatchObject({
      stage: "TERMINAL",
      outcome_json: { outcome: "FAILED", failure: { reason: "PIPELINE_STALLED", retryable: true } },
    });
    // A slow-but-alive run is left alone: the threshold has to clear the slowest
    // legitimate stage (a live LLM negotiation bumps updated_at only on entry).
    expect((await row(fresh)).outcome_json).toBeNull();
  });

  it("leaves finished runs untouched however old they are", async () => {
    const escalated = await openRun("AWAITING_HUMAN_APPROVAL", 86_400_000);
    await db.query(
      `UPDATE proposal_txs SET outcome_json = '{"outcome":"ESCALATED","approval_id":"apr_x"}' WHERE tx_id=$1`,
      [escalated],
    );
    const awaitingPayment = await openRun("SETTLING", 86_400_000);
    await db.query(
      `UPDATE proposal_txs SET outcome_json = '{"outcome":"APPROVED"}' WHERE tx_id=$1`,
      [awaitingPayment],
    );

    expect(await sweepStalledProposals(db, { now: new Date() })).toEqual([]);
    expect((await row(escalated)).outcome_json).toMatchObject({ outcome: "ESCALATED" });
    expect((await row(awaitingPayment)).outcome_json).toMatchObject({ outcome: "APPROVED" });
  });

  it("honours an explicit threshold", async () => {
    const txId = await openRun("CITATION_AUDIT", 2_000);
    expect(await sweepStalledProposals(db, { now: new Date(), staleAfterMs: 60_000 })).toEqual([]);
    expect(await sweepStalledProposals(db, { now: new Date(), staleAfterMs: 1_000 })).toEqual([txId]);
  });

  it("is idempotent — a second sweep finds nothing left to close", async () => {
    await openRun("NEGOTIATING", DEFAULT_STALL_AFTER_MS + 1_000);
    expect(await sweepStalledProposals(db, { now: new Date() })).toHaveLength(1);
    expect(await sweepStalledProposals(db, { now: new Date() })).toHaveLength(0);
  });
});
