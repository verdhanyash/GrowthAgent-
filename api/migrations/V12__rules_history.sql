-- V12__rules_history.sql — admin rules persistence (api-contract.md §7.1).
--
-- The rules are INSERT-ONLY: each PUT creates a new version row. The current
-- rules are always the highest-versioned row. This gives a complete, immutable
-- history that the admin rules history endpoint reads directly.
--
-- The initial MEERA_RULES_V3 seed is NOT inserted here — the composition root
-- seeds it on first boot when the table is empty, keeping fixture data in code
-- rather than SQL.

CREATE TABLE merchant_rules (
  rules_version  INTEGER PRIMARY KEY,             -- monotonically increasing
  rules_json     JSONB NOT NULL,                  -- full MerchantRulesConfig
  actor          TEXT NOT NULL DEFAULT 'system',   -- who changed it
  note           TEXT,                             -- optional changelog note
  increase       BOOLEAN NOT NULL DEFAULT false,   -- true if any guarded limit was raised
  diff           JSONB,                            -- { before: partial, after: partial } advisory
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast "current rules" (ORDER BY rules_version DESC LIMIT 1).
CREATE INDEX merchant_rules_latest_idx ON merchant_rules (rules_version DESC);
