-- V11__tx_owner_agent.sql — record the settling agent on each transaction.
--
-- Adjudication (security audit P2-full, 2026-08-27):
--  * The buyer settlement routes (POST /v1/tx/settle, GET /v1/tx/:tx_id) gain
--    real agent authentication (requireAgent) + an ownership check on read.
--    Ownership needs the tx to remember WHICH agent created it — this column.
--  * NULLABLE by design: the in-process pipeline threads the buyer's id, but a
--    NULL owner (legacy rows, unattributable callers) must stay valid rather
--    than fail the INSERT. The read route treats NULL as "not owned by caller".
--  * No FK to agent_identities: matches the repo's deferred-FK convention
--    (V7 header) — identity integrity is enforced at the auth boundary, and a
--    hard FK here would couple settlement DDL to the api-layer table's lifecycle.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS agent_id TEXT;

-- Ownership lookups filter by (tx_id, agent_id); tx_id is already the PK, so a
-- partial index on the owned rows keeps "my transactions" scans cheap without
-- indexing the NULL-owner tail.
CREATE INDEX IF NOT EXISTS t_agent_owner_idx
  ON transactions (agent_id)
  WHERE agent_id IS NOT NULL;
