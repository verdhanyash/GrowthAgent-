-- V8 — pipeline milestone tables: hash-chained audit log, proposal tracking,
-- approvals inbox (settlement.md §11 / api-contract.md §5.1, §7.2 /
-- frontend-events.md §1.4 envelope).
--
-- The audit log is the append-only spine of the whole demo: every durable SSE
-- frame IS one row here (seq == SSE id), and the admin replay endpoint reads
-- ONLY this table. Hash chain: hash_n = sha256(prev_hash ?? 'GENESIS' || '\n'
-- || canonicalJson(body_n)); the single-writer pipeline emitter serializes
-- appends so links cannot interleave.

CREATE TABLE audit_log (
  seq            BIGINT PRIMARY KEY,           -- global, monotonic, assigned by the single writer
  tx_id          TEXT NOT NULL,                -- '-' for global/system events
  ts             TIMESTAMPTZ NOT NULL,
  actor_id       TEXT NOT NULL,
  actor_kind     TEXT NOT NULL,
  actor_key_hash TEXT NOT NULL,
  rules_version  INTEGER NOT NULL,
  event          TEXT NOT NULL,
  payload        JSONB NOT NULL,
  prev_hash      TEXT,                         -- NULL only at genesis (seq 1)
  hash           TEXT NOT NULL,
  CONSTRAINT audit_hash_hex CHECK (hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_prev_hash_hex CHECK (prev_hash IS NULL OR prev_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX audit_log_tx_idx ON audit_log (tx_id, seq);

-- Pipeline-level transaction record: stages BEFORE the settlement state
-- machine wakes up at T1. One row per buyer proposal; outcome_json carries
-- the terminal union once known.
CREATE TABLE proposal_txs (
  tx_id          TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  agent_key_hash TEXT NOT NULL,
  request_bytes  JSONB NOT NULL,               -- buyer request view + raw customer note
  stage          TEXT NOT NULL CHECK (stage IN (
                   'PROPOSING', 'BUILDING_EVIDENCE', 'NEGOTIATING', 'CITATION_AUDIT',
                   'GATE_CHECKING', 'AWAITING_HUMAN_APPROVAL', 'SETTLING', 'TERMINAL')),
  rules_version  INTEGER,
  outcome_json   JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);

-- Escalation inbox item. frozen_proposal holds the COMPLETE SettleableProposal
-- bytes minted at escalation time — approval settles EXACTLY those bytes,
-- never a re-proposal. approval_token is the single-use credential settle()
-- consumes; it never appears in any SSE frame.
CREATE TABLE approvals (
  approval_id        TEXT PRIMARY KEY,         -- apr_<ulid>
  tx_id              TEXT NOT NULL REFERENCES proposal_txs(tx_id),
  reason             TEXT NOT NULL CHECK (reason IN (
                       'HIGH_CART_VALUE', 'ESCALATION_BAND_SOFT_EDGE',
                       'VELOCITY_SOFT_BAND', 'MANUAL_REVIEW_FLAG')),
  band_context       JSONB NOT NULL,
  frozen_proposal    JSONB NOT NULL,
  gate_trace_summary JSONB NOT NULL,
  approval_token     TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('PENDING', 'RESOLVED')),
  decision           TEXT CHECK (decision IN ('APPROVED', 'REJECTED')),
  decided_by         TEXT,
  note               TEXT,
  consumed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  resolved_at        TIMESTAMPTZ,
  CONSTRAINT resolved_shape CHECK (
    (status = 'PENDING' AND decision IS NULL AND resolved_at IS NULL)
    OR (status = 'RESOLVED' AND decision IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT consumed_requires_approval CHECK (
    consumed_at IS NULL OR (status = 'RESOLVED' AND decision = 'APPROVED')
  )
);
