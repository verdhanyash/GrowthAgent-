-- V7__settlement.sql — settlement-owned DDL (docs/design/settlement.md §6–§8).
--
-- Adjudications (registered in BUILD_LOG M6 / ARCHITECTURE.md §18 practice):
--  * This is the FIRST migration to land: no earlier V1–V6 exists yet, because
--    M1–M5 were pure-function modules. Numbering follows the planned corpus,
--    not history. Tables owned by other subsystems (merchants, catalog_raw,
--    proposals, …) arrive with their own milestones; where settlement.md's
--    sketch FKs into them we ship the column WITHOUT the constraint and note
--    it inline, so the demo boots today and the FK lands with the seed
--    migration instead of failing here.
--  * transactions: data-model-audit §2.11 sketches the full correlation root
--    (uuid PK, merchant/buyer FKs). Settlement owns the row's MONEY-FRONT
--    slice; V7 creates exactly what settlement touches. tx_id is TEXT
--    'tx_' + 26-char ULID — shared/src/settlement.ts is this build's
--    canonical TxId and already binds web+api.
--  * Money: BIGINT paise columns everywhere (§18 register), TS number with
--    safe-integer guards at the zod boundary.
--  * State vocabulary: TEXT + CHECK against the 12-state TX_STATES union from
--    shared/settlement.ts rather than a PG enum — states evolve by ALTER of a
--    CHECK, never a system-catalog surgery.

CREATE TABLE transactions (
  tx_id               TEXT PRIMARY KEY CHECK (tx_id ~ '^tx_[0-9A-HJKMNP-TV-Z]{26}$'),
  state               TEXT NOT NULL
                      CHECK (state IN (
                        'PROPOSAL_APPROVED','STOCK_RESERVED','ORDER_CREATING',
                        'RZP_ORDER_CREATED','AWAITING_PAYMENT','PAID','COMPLETED',
                        'FAILED','EXPIRED','RELEASED',
                        'REJECTED_BY_MERCHANT','MANUAL_REFUND_REQUIRED')),
  proposal_bytes      JSONB NOT NULL,          -- frozen proposal EXACTLY as approved (§1.2)
  proposal_sha256     TEXT NOT NULL CHECK (proposal_sha256 ~ '^[0-9a-f]{64}$'),
  approved_total_paise BIGINT NOT NULL CHECK (approved_total_paise >= 0),
  ruleset_version     INTEGER NOT NULL CHECK (ruleset_version > 0),
  gatekeeper_trace_digest TEXT NOT NULL CHECK (gatekeeper_trace_digest ~ '^[0-9a-f]{64}$'),
  approval_source     TEXT NOT NULL CHECK (approval_source IN ('GATEKEEPER_AUTO','HUMAN_ESCALATION')),
  provider_kind       TEXT NOT NULL CHECK (provider_kind IN ('mock','razorpay')),
  receipt             TEXT NOT NULL UNIQUE,    -- deterministic fn(tx_id) (V3)
  reserved_at         TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  expired_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  pay_id              TEXT,                    -- winning payment id, stamped by T7 CAS
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX t_state_sweep_idx ON transactions (state, updated_at);

-- Physical stock + Model-A hold counters (§7.1). catalog(sku) FK deferred:
-- no catalog migration exists yet (see header); SKU integrity is enforced at
-- every boundary by zod + gatekeeper GK-SKU-RESOLUTION meanwhile.
CREATE TABLE inventory (
  sku         TEXT PRIMARY KEY,
  stock_qty   INTEGER NOT NULL CHECK (stock_qty >= 0),   -- physical on-hand
  reserved    INTEGER NOT NULL DEFAULT 0
              CHECK (reserved >= 0 AND reserved <= stock_qty),
  sold        INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_reservations (
  reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id          TEXT NOT NULL REFERENCES transactions(tx_id),
  sku            TEXT NOT NULL REFERENCES inventory(sku),
  qty            INTEGER NOT NULL CHECK (qty > 0),
  status         TEXT NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','COMMITTED','RELEASED','EXPIRED')),
  reserved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,        -- reserved_at + RESERVATION_TTL
  released_at    TIMESTAMPTZ,
  committed_at   TIMESTAMPTZ,
  UNIQUE (tx_id, sku)                          -- one hold per SKU per tx (§14.4)
);
CREATE INDEX idx_resv_sweep ON stock_reservations (status, expires_at) WHERE status = 'ACTIVE';

-- Authoritative velocity ledger (TB-2b, §7.2): increments re-check BOTH
-- merchant-rule ceilings inside reserveCart's guarded ON CONFLICT DO UPDATE;
-- ceilings live in rules (parameters), never in DDL constants.
CREATE TABLE identity_velocity (
  identity_hash  TEXT NOT NULL,
  day            DATE NOT NULL,
  approved_count INT NOT NULL DEFAULT 0 CHECK (approved_count >= 0),
  approved_paise BIGINT NOT NULL DEFAULT 0 CHECK (approved_paise >= 0),
  PRIMARY KEY (identity_hash, day)
);

-- Layer-2 guard (§8.2): receipt mirrors Razorpay's own uniqueness (V3).
CREATE TABLE razorpay_orders (
  tx_id         TEXT PRIMARY KEY REFERENCES transactions(tx_id),
  receipt       TEXT NOT NULL UNIQUE,          -- = 'ga_' || ulid(tx_id); deterministic fn(tx_id)
  provider      TEXT NOT NULL,
  rzp_order_id  TEXT UNIQUE,
  amount_paise  BIGINT NOT NULL CHECK (amount_paise > 0),
  currency      TEXT NOT NULL CHECK (currency = 'INR'),
  status        TEXT NOT NULL CHECK (status IN ('INTENT','CREATED','AMBIGUOUS')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Layer-3 dedupe (§8.3): insert-first claim, two-phase RECEIVED→PROCESSED.
-- `payload` stores the AUTHENTICATED envelope so the §10.1/W6 sweeper can
-- re-drive stranded RECEIVED rows (spec DDL omits it; without it redrive
-- cannot reconstruct the event — adjudication registered in BUILD_LOG M6).
CREATE TABLE processed_webhook_events (
  event_id       TEXT PRIMARY KEY,             -- x-razorpay-event-id or sha256(rawBody)
  status         TEXT NOT NULL CHECK (status IN ('RECEIVED','PROCESSED')),
  payload_digest TEXT NOT NULL,
  payload        JSONB,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ
);
CREATE INDEX idx_webhook_redrive ON processed_webhook_events (status, received_at);

-- Completion ledger (§9): one row per COMPLETED tx; feeds future campaign mining.
CREATE TABLE completed_sales (
  tx_id        TEXT PRIMARY KEY REFERENCES transactions(tx_id),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Layer-1 durable twin (§8.1): replay source if Redis flushed; audit copy.
CREATE TABLE idempotency_keys (
  key             TEXT PRIMARY KEY,
  request_hash    TEXT NOT NULL,
  tx_id           TEXT,
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
