-- V10__tx_amount_positive.sql — tighten the transactions money-front invariant.
--
-- Adjudication (security audit P10, 2026-08-27):
--  * V7 shipped `approved_total_paise BIGINT NOT NULL CHECK (>= 0)`. A settled
--    money row of exactly 0 paise is nonsensical — every real settlement moves
--    a strictly positive amount. The gatekeeper's ZERO_NET_REVENUE rule already
--    blocks a 0 upstream; this is DB-level defence-in-depth so the invariant
--    holds even if a future writer bypasses the pipeline.
--  * The V7 CHECK is an inline unnamed constraint → Postgres auto-names it
--    `transactions_approved_total_paise_check`. We DROP IF EXISTS (tolerant of
--    a hand-renamed constraint or a re-run) then re-add the tightened form.
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_approved_total_paise_check;
ALTER TABLE transactions
  ADD  CONSTRAINT transactions_approved_total_paise_check
  CHECK (approved_total_paise > 0);
