-- V13__audit_fixes.sql — remediation of the red-team audit (review.md).
--
-- Three unrelated-but-small changes, batched so the demo needs one migration:
--
-- 1. stock_reservations.backordered (audit H2 — gatekeeper/settlement policy
--    mismatch). GK-STOCK-AVAILABILITY exempts SKUs listed in
--    rules.stock_policy.backorder_allowed_skus (made-to-order items), but every
--    settlement hold path enforced `stock_qty - reserved >= qty` and the table
--    CHECK (reserved <= stock_qty) unconditionally — so a zero-stock backorder
--    PASSED the gate and FAILED at settle time. Model A ("hold, don't
--    decrement") has nothing to hold for a made-to-order line, so the honest
--    representation is a hold row that moves NO counter. The flag is what
--    reserve/release/expire/commit key off; invariant I
--    (0 <= reserved <= stock_qty) is untouched because backordered rows never
--    touch `reserved`.
--
-- 2. proposal_idempotency(tx_id) (audit 10.2 — missing index). The buyer poll
--    and the SSE ownership check both filter `WHERE tx_id=$1 AND agent_id=$2`;
--    the PK is (agent_id, key), so neither predicate was indexed on tx_id and
--    both degraded to a sequential scan as the ledger grows.
--
-- 3. proposal_txs sweep index (audit 13.1 — stalled pipeline runs). The new
--    pipeline stall sweeper scans for unfinished runs by (stage, updated_at)
--    among rows with no outcome yet; a partial index keeps that scan off the
--    finished tail, which is the overwhelming majority of the table.

ALTER TABLE stock_reservations
  ADD COLUMN IF NOT EXISTS backordered BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_proposal_idem_tx
  ON proposal_idempotency (tx_id);

CREATE INDEX IF NOT EXISTS idx_proposal_txs_open
  ON proposal_txs (updated_at)
  WHERE outcome_json IS NULL;
