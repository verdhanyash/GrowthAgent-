-- V9__api.sql — buyer-facing HTTP layer (api-contract.md §4.1, §5.1.1, §6).
--
-- Three tables the M8 surface owns, all distinct from settlement's:
--  * agent_identities   — hashed API keys + role, revocation, snapshot source
--                         for the tx's identity (E-11); admin routes never use
--                         these (they use the loopback + X-Admin-Token guard).
--  * proposal_idempotency — the buyer POST's dedupe ledger, scoped per agent
--                         (unique (agent_id, key)); DISTINCT from settlement's
--                         `idempotency_keys` (that one dedupes the settle call,
--                         keyed on the header alone). Both may coexist.
--  * cart_mandates      — the lazily-minted, merchant-signed CartMandate,
--                         persisted once per tx so expires_at/nonce stay stable
--                         across repeated polls (§6.2 provenance).

CREATE TABLE agent_identities (
  agent_id       TEXT PRIMARY KEY,             -- 'buyer_adversarial'
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('buyer_agent','system')),
  api_key_hash   TEXT NOT NULL UNIQUE CHECK (api_key_hash ~ '^[0-9a-f]{64}$'),
  api_key_prefix TEXT NOT NULL,                -- first 12 chars, UI display only
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT
);

-- Buyer proposal dedupe. request_hash = sha256(canonicalJson(body)); a replay
-- with the SAME hash returns the original tx_id, a DIFFERENT hash under the same
-- (agent_id,key) is a 409 IDEMPOTENCY_CONFLICT. The row is claimed in the SAME
-- Postgres tx that mints tx_id, so a double-submit race resolves atomically —
-- both callers converge on one tx_id and exactly one pipeline run.
CREATE TABLE proposal_idempotency (
  agent_id     TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  tx_id        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, key)
);

-- The signed artifact. mandate_json is the COMPLETE CartMandate (schema-valid,
-- merchant_sig included); we persist the whole object so the exact bytes the
-- buyer verified are reproducible and immutable once minted.
CREATE TABLE cart_mandates (
  tx_id        TEXT PRIMARY KEY,
  mandate_id   TEXT NOT NULL UNIQUE,
  mandate_json JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
