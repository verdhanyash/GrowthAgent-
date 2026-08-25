# GrowthAgent — Data Model, Hash-Chained Audit Trail & Correlation Infrastructure
### Subsystem design: Postgres schema + append-only audit chain + tx correlation (data-model-audit)

Scope: everything that lives in Postgres and every guarantee the database itself enforces. Everything else (agents, prompts, Razorpay adapter internals) is referenced only where the schema must serve it. Money is **BIGINT paise everywhere**, transaction IDs are **UUIDv7**, and the audit log is the **only** component trusted enough to reconstruct reality.

---

## 0. Conventions and ground rules

| Convention | Decision |
|---|---|
| Money | `bigint` columns named `*_paise`. Never `numeric`, never floats. Node `pg` returns `bigint` as **string** — one central parser (`parsePaise(s: string): bigint`) in `shared/`; a lint rule forbids raw `Number()` on `*_paise` columns. |
| Percentages / ratios in JSON payloads | **Integer basis points (`*_bp`, 1% = 100bp)** or whole-percent ints (`*_pct`). Floats are banned from every `jsonb` column that feeds the hash chain (see §4.2 — float formatting diverges across serializers and would break reproducible hashing). |
| Timestamps | `timestamptz` (UTC storage). Daily rollup buckets use `(occurred_at AT TIME ZONE 'Asia/Kolkata')::date` — Meera's business day ends on IST midnight, not UTC. |
| Simulation clock | `merchants.sim_time_anchor` (seeded to `2026-08-25T09:00:00+05:30`). Seeded `sales_history` timestamps are computed **relative to the anchor**. Live pipeline events use real `now()`. Analytics queries take an `as_of` parameter that defaults to the anchor date during demo runs — the sim clock is a query parameter, never a fake `setsockopt(TIME)`. |
| IDs | PKs: `gen_random_uuid()` (PG13+, no extension needed). Transaction IDs: **UUIDv7 generated in the app** by the pipeline orchestrator (Postgres has no native `uuidv7()` before PG18; app-side generation also lets us stamp it into the first audit event and the pino bindings atomically). |
| Enums | Postgres `CREATE TYPE` for closed sets that both SQL and zod must agree on. A consistency vitest parses the DDL and asserts the SQL enum labels match the zod enum values exactly (see §11 matrix F). |
| Multi-tenancy | Every table carries `merchant_id` even though the demo ships one merchant. Costs nothing now; prevents a class of demo-day bugs and keeps the gatekeeper's rules lookup scoped. |
| Trust rule, enforced by schema | `catalog_enriched` physically contains **no** price/cost/margin/stock columns. Authoritative commercial numbers exist in exactly one place: `catalog_raw`. An architecture test greps the enriched table's columns against `/(price\|cost\|margin\|stock\|qty)/i` and fails if any match — enrichment literally cannot leak authority into the money path. |

Table inventory (dependency order): `merchants` → `agent_identities`, `catalog_raw` → `catalog_enriched`, `sales_history` → `sales_stats_daily`, `sku_daily_stats`, `attach_rates`, `campaign_priority_sets`, `merchant_rules`, `transactions` → `proposals`, `gatekeeper_decisions`, `stock_reservations`(+lines), `orders`, `approval_requests`, `webhook_events`, `llm_calls`, and `audit_log` (deliberately FK-free).

---

## 1. Shared zod schemas that live in `jsonb` columns

These are the DB-facing subset of `shared/schemas.ts` (single source of truth). Anything stored in a `jsonb` column validates against one of these at write time; the DB adds coarse structural `CHECK`s as a second net.

```ts
import { z } from "zod";

// ---------- merchant_rules.rules ----------
export const VelocityLimitZ = z.object({
  scope: z.enum(["GLOBAL", "IDENTITY_KIND", "IDENTITY"]),
  identity_kind: z.enum(["BUYER", "INTERNAL"]).optional(),   // required when scope=IDENTITY_KIND
  identity_id: z.string().uuid().optional(),                 // required when scope=IDENTITY
  window_seconds: z.number().int().positive(),
  max_transactions: z.number().int().positive(),
});

export const EscalationBandZ = z.object({
  above_paise: z.number().int().positive(),                  // soft-edge band lower bound
  below_paise: z.number().int().positive(),                  // upper bound (== hard threshold)
  action: z.literal("ESCALATE_TO_HUMAN"),
});

export const MerchantRulesZ = z.object({
  schema_version: z.literal(1),
  max_cart_value_paise: z.number().int().positive(),
  max_discount_pct: z.number().int().min(0).max(100),
  margin_floor_bp: z.number().int().min(0).max(10_000),      // blended basket margin floor, basis points
  category_allowlist: z.array(z.string()).min(1),
  require_approval_above_paise: z.number().int().positive(), // hard ESCALATE threshold
  escalation_bands: z.array(EscalationBandZ).default([]),    // soft edges under the threshold
  velocity_limits: z.array(VelocityLimitZ).min(1),
});
export type MerchantRules = z.infer<typeof MerchantRulesZ>;

// ---------- gatekeeper_decisions.rule_trace ----------
export const RuleTraceEntryZ = z.object({
  rule_id: z.enum(["MAX_CART_VALUE", "MAX_DISCOUNT_PCT", "MARGIN_FLOOR",
                   "CATEGORY_ALLOWLIST", "VELOCITY_LIMIT", "STOCK_AVAILABLE",
                   "HUMAN_APPROVAL_THRESHOLD", "ESC_BAND"]),
  passed: z.boolean(),
  expected: z.string(),        // deterministically rendered, e.g. "<= 150000"
  actual: z.string(),          // e.g. "162000"
  severity: z.enum(["HARD", "SOFT"]),   // SOFT = escalation-band edge, never blocks alone
  detail: z.string(),
});

// ---------- audit_log envelope (validated before INSERT) ----------
export const AuditAgentZ = z.enum(["pipeline", "buyer_sim", "negotiation", "citation_auditor",
  "campaign", "gatekeeper", "settlement", "explainer", "human_approval", "system"]);

export const AuditEventTypeZ = z.enum([
  "CHAIN_GENESIS", "PIPELINE_STARTED", "CATALOG_LOADED", "EVIDENCE_PACK_BUILT",
  "PRIORITY_SET_INJECTED", "NEGOTIATION_REQUESTED", "NEGOTIATION_COMPLETED",
  "NEGOTIATION_FALLBACK_USED", "INJECTION_HEURISTIC_FLAGGED", "CITATION_AUDIT_PASSED",
  "CITATION_AUDIT_FAILED", "GATEKEEPER_EVALUATED", "STOCK_RESERVED",
  "STOCK_RESERVATION_RELEASED", "STOCK_RESERVATION_EXPIRED", "RAZORPAY_ORDER_CREATED",
  "PAYMENT_WEBHOOK_RECEIVED", "PAYMENT_CONFIRMED", "TX_SETTLED", "TX_DECLINED",
  "ESCALATION_RAISED", "ESCALATION_APPROVED", "ESCALATION_REJECTED",
  "EXPLAINER_NARRATIVE",
  "RULES_UPDATED",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeZ>;

// ---------- citations carried by proposals.citations ----------
export const EvidenceIdZ = z.string().regex(/^EV-[a-z0-9_]+-\d{3}$/i); // e.g. EV-ATTACH-007
export const CitationZ = z.object({
  claim: z.string(),
  evidence_ids: z.array(EvidenceIdZ).min(1),
  cart_item_index: z.number().int().min(0),
});
```

---

## 2. Full DDL

One migration per logical group, executed by node-pg-migrate (§8). Shown here as plain SQL for readability.

### 2.0 Extensions and enums

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- digest() for optional server-side checks

CREATE TYPE identity_kind            AS ENUM ('BUYER', 'INTERNAL');
CREATE TYPE enrichment_status        AS ENUM ('PENDING', 'ENRICHED', 'UNENRICHED', 'FAILED');
CREATE TYPE proposal_source          AS ENUM ('LLM_NEGOTIATION', 'RULE_FALLBACK');
CREATE TYPE proposal_status          AS ENUM ('PROPOSED', 'AUDIT_FAILED', 'CONSUMED');
CREATE TYPE gate_outcome             AS ENUM ('APPROVE', 'DECLINE_WITH_REASON', 'ESCALATE_TO_HUMAN');
CREATE TYPE tx_state                 AS ENUM ('OPEN', 'NEGOTIATING', 'GATE_DECIDED', 'ESCALATED',
                                              'SETTLED', 'DECLINED', 'ABANDONED', 'FAILED');
CREATE TYPE priority_set_status      AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');
CREATE TYPE reservation_status       AS ENUM ('ACTIVE', 'CONVERTED', 'RELEASED', 'EXPIRED');
CREATE TYPE order_status             AS ENUM ('CREATED', 'ATTEMPTED', 'PAID', 'FAILED');
CREATE TYPE approval_status          AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE webhook_processing_state AS ENUM ('RECEIVED', 'VERIFIED', 'PROCESSED', 'IGNORED',
                                              'INVALID_SIGNATURE');
CREATE TYPE llm_call_outcome         AS ENUM ('OK', 'TIMEOUT', 'API_ERROR', 'RATE_LIMIT');
-- audit_event_type: mirrors AuditEventTypeZ above (25 labels); see §11 matrix F consistency test.
CREATE TYPE audit_event_type AS ENUM (
  'CHAIN_GENESIS','PIPELINE_STARTED','CATALOG_LOADED','EVIDENCE_PACK_BUILT',
  'PRIORITY_SET_INJECTED','NEGOTIATION_REQUESTED','NEGOTIATION_COMPLETED',
  'NEGOTIATION_FALLBACK_USED','INJECTION_HEURISTIC_FLAGGED','CITATION_AUDIT_PASSED',
  'CITATION_AUDIT_FAILED','GATEKEEPER_EVALUATED','STOCK_RESERVED',
  'STOCK_RESERVATION_RELEASED','STOCK_RESERVATION_EXPIRED','RAZORPAY_ORDER_CREATED',
  'PAYMENT_WEBHOOK_RECEIVED','PAYMENT_CONFIRMED','TX_SETTLED','TX_DECLINED',
  'ESCALATION_RAISED','ESCALATION_APPROVED','ESCALATION_REJECTED','EXPLAINER_NARRATIVE',
  'RULES_UPDATED');

-- Optional hygiene: reject non-v7 tx ids at the door (RFC 9562: version nibble = 7).
CREATE OR REPLACE FUNCTION is_uuid_v7(u uuid) RETURNS boolean IMMUTABLE PARALLEL SAFE
LANGUAGE sql AS $$ SELECT (get_byte(uuid_send(u), 6) >> 4) = 7 $$;
```

### 2.1 merchants

```sql
CREATE TABLE merchants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  sim_time_anchor timestamptz NOT NULL,          -- synthetic "today" for seeded history
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchants_name_len CHECK (char_length(name) BETWEEN 1 AND 120)
);
```

### 2.2 agent_identities — hashed API keys, revocable

```sql
CREATE TABLE agent_identities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id        uuid NOT NULL REFERENCES merchants(id),
  kind               identity_kind NOT NULL,          -- BUYER (external sim) | INTERNAL (our agents' calls)
  display_name       text NOT NULL,                   -- 'demo-buyer-wellbehaved', 'demo-buyer-adversarial'
  key_hash           text NOT NULL UNIQUE,            -- lowercase-hex SHA-256 of raw key; raw key NEVER stored
  key_prefix         text NOT NULL,                   -- first 10 chars for UI display only ('gab_b_9f2c…')
  scopes             text[] NOT NULL DEFAULT '{}',    -- informational; authorization is rules-based, not scope-based
  velocity_overrides jsonb,                           -- OPTIONAL tighter limits; validated against VelocityLimitZ[]
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  last_seen_at       timestamptz,
  CONSTRAINT ai_revoked_after_created CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT ai_overrides_are_array CHECK (velocity_overrides IS NULL OR jsonb_typeof(velocity_overrides) = 'array')
);
CREATE INDEX ai_active_by_merchant_idx ON agent_identities (merchant_id, kind) WHERE revoked_at IS NULL;

-- Auth lookup (constant-time compare happens app-side over the hash):
CREATE INDEX ai_key_hash_idx ON agent_identities (key_hash);
```

Design note: velocity *limits* are ground truth and therefore live **only** in `merchant_rules` (the gatekeeper evaluates nothing else). `velocity_overrides` may only tighten, is itself merchant-configured through the rules screen, and the gatekeeper merges `merchant_rules.velocity_limits` with any matching override before evaluating — an agent claiming "my override allows more" changes nothing, because the gatekeeper re-reads the configured value, never the agent's claim.

### 2.3 merchant_rules — versioned, append-mostly

```sql
CREATE TABLE merchant_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  version     int NOT NULL,
  is_active   boolean NOT NULL DEFAULT false,
  rules       jsonb NOT NULL,                     -- validates against MerchantRulesZ
  checksum    text NOT NULL,                      -- sha256 hex of canonicalJson(rules); stamped onto decisions
  created_by  text NOT NULL DEFAULT 'seed',       -- 'seed' | approval_request id | ui user label
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(), -- bumps on activation flip; version content is immutable by convention
  CONSTRAINT mr_version_positive CHECK (version >= 1),
  CONSTRAINT mr_unique_version UNIQUE (merchant_id, version),
  CONSTRAINT mr_discount_pct_range CHECK ((rules->>'max_discount_pct')::numeric BETWEEN 0 AND 100),
  CONSTRAINT mr_cart_cap_positive  CHECK ((rules->>'max_cart_value_paise')::bigint > 0),
  CONSTRAINT mr_margin_floor_range CHECK ((rules->>'margin_floor_bp')::int BETWEEN 0 AND 10000),
  CONSTRAINT mr_checksum_hex CHECK (checksum ~ '^[0-9a-f]{64}$')
);
-- Exactly one active ruleset per merchant:
CREATE UNIQUE INDEX mr_one_active_idx ON merchant_rules (merchant_id) WHERE is_active;
CREATE INDEX mr_active_lookup ON merchant_rules (merchant_id, is_active);
```

### 2.4 catalog_raw — the ONLY home of authoritative commercial numbers

```sql
CREATE TABLE catalog_raw (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      uuid NOT NULL REFERENCES merchants(id),
  sku              text NOT NULL,
  name_raw         text NOT NULL,        -- intentionally messy; see §10
  description_raw  text,                 -- may be NULL (that is the point)
  category_raw     text,
  uom_raw          text,                 -- '500gm', 'half kg', 'x12' — messiness is textual, never numeric
  cost_price_paise bigint NOT NULL CHECK (cost_price_paise > 0),
  list_price_paise bigint NOT NULL CHECK (list_price_paise >= cost_price_paise),
  stock_qty        int NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  expiry_date      date,                 -- NULL = no expiry; sweeper compares against SIM time, not now()
  is_active        boolean NOT NULL DEFAULT true,
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cr_sku_unique UNIQUE (merchant_id, sku)
);
-- Near-expiry scans (campaign agent + expiry-risk planting):
CREATE INDEX cr_expiry_idx ON catalog_raw (merchant_id, expiry_date)
  WHERE expiry_date IS NOT NULL AND is_active;
-- Atomic reservation hot path:
CREATE INDEX cr_stock_lookup_idx ON catalog_raw (merchant_id, sku) WHERE is_active;
```

### 2.5 catalog_enriched — LLM marketing data, structurally powerless

```sql
CREATE TABLE catalog_enriched (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id         uuid NOT NULL,
  sku                 text NOT NULL,
  enrichment_status   enrichment_status NOT NULL DEFAULT 'PENDING',
  updated_by_model    text,                    -- 'claude-opus-5'; NULL unless status='ENRICHED'
  updated_at          timestamptz NOT NULL DEFAULT now(),
  display_name        text,                    -- cleaned name ('Red Velvet Cake — 500 g')
  description         text,
  category            text,
  tags                text[] NOT NULL DEFAULT '{}',
  occasions           text[] NOT NULL DEFAULT '{}',  -- {'birthday','anniversary','diwali','rakhi','congrats'}
  pairing_suggestions text[] NOT NULL DEFAULT '{}',  -- SKU codes suggested as companions
  confidence          numeric(3,2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  warnings            text[] NOT NULL DEFAULT '{}',
  raw_response        jsonb,                   -- full parsed LLM output, debug only
  error_detail        text,
  CONSTRAINT ce_sku_fk FOREIGN KEY (merchant_id, sku)
    REFERENCES catalog_raw (merchant_id, sku) ON DELETE CASCADE,
  CONSTRAINT ce_sku_unique UNIQUE (merchant_id, sku),
  -- TRUST RULE, stated as a constraint: enrichment claims require a model attribution…
  CONSTRAINT ce_model_required CHECK (
    enrichment_status <> 'ENRICHED' OR (updated_by_model IS NOT NULL AND display_name IS NOT NULL)),
  -- …and failures must explain themselves (degradation contract: raw fields kept, marked UNENRICHED):
  CONSTRAINT ce_failed_has_reason CHECK (enrichment_status <> 'FAILED' OR error_detail IS NOT NULL)
);

COMMENT ON TABLE catalog_enriched IS
  'LLM-enriched MARKETING data ONLY. Contains NO price/cost/margin/stock columns BY DESIGN: '
  'authoritative commercial data lives exclusively in catalog_raw. Never feed numeric fields '
  'from this table into negotiation evidence or gatekeeper inputs.';
```

The composite FK `(merchant_id, sku) → catalog_raw(merchant_id, sku)` works because of the `UNIQUE` in §2.4 and means an enriched row cannot dangle even across SKU renames.

### 2.6 sales_history — synthetic ledger (append-only by convention, huge)

```sql
CREATE TABLE sales_history (
  id               bigserial PRIMARY KEY,          -- bigserial: 90d × 9 SKUs × N sales/day ≈ thousands of rows
  merchant_id      uuid NOT NULL REFERENCES merchants(id),
  sku              text NOT NULL,
  order_ref        text NOT NULL,                  -- synthetic grouping id ('seed-20260601-0042')
  qty              int NOT NULL CHECK (qty > 0),
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),   -- actual selling price
  discount_paise   bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  line_total_paise bigint GENERATED ALWAYS AS (qty * unit_price_paise - discount_paise) STORED,
  channel          text NOT NULL DEFAULT 'walk_in', -- walk_in | whatsapp | instagram | referral
  occurred_at      timestamptz NOT NULL,
  CONSTRAINT sh_nonnegative_total CHECK (qty * unit_price_paise >= discount_paise),
  CONSTRAINT sh_sku_fk FOREIGN KEY (merchant_id, sku) REFERENCES catalog_raw (merchant_id, sku)
);
-- Generated columns cannot appear in CHECKs at the same level, hence the duplicated expression above.
CREATE INDEX sh_sku_time_idx ON sales_history (merchant_id, sku, occurred_at DESC);
CREATE INDEX sh_time_brin    ON sales_history USING brin (occurred_at);  -- cheap range scans on append-only data
```

### 2.7 sales_stats_daily — pure rollup (ground-truth aggregates)

```sql
CREATE TABLE sales_stats_daily (
  merchant_id    uuid NOT NULL REFERENCES merchants(id),
  stat_date      date NOT NULL,                    -- IST calendar day: (occurred_at AT TIME ZONE 'Asia/Kolkata')::date
  sku            text NOT NULL,
  orders_count   int NOT NULL DEFAULT 0 CHECK (orders_count >= 0),
  units_sold     int NOT NULL DEFAULT 0 CHECK (units_sold >= 0),
  gross_paise    bigint NOT NULL DEFAULT 0 CHECK (gross_paise >= 0),
  discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  net_paise      bigint NOT NULL DEFAULT 0 CHECK (net_paise >= 0),
  refreshed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, stat_date, sku),
  FOREIGN KEY (merchant_id, sku) REFERENCES catalog_raw (merchant_id, sku)
);
```

Plain table, not a matview: the seeder and a refresh job upsert into it (`INSERT … ON CONFLICT … DO UPDATE`), enabling partial refresh of just recent days.

### 2.8 sku_daily_stats — per-SKU derived intelligence (feeds campaign mining)

```sql
CREATE TABLE sku_daily_stats (
  merchant_id             uuid NOT NULL REFERENCES merchants(id),
  stat_date               date NOT NULL,
  sku                     text NOT NULL,
  units_sold              int NOT NULL DEFAULT 0,
  net_paise               bigint NOT NULL DEFAULT 0,
  avg_selling_price_paise bigint NOT NULL DEFAULT 0,
  velocity_7d_avg         numeric(10,2) NOT NULL DEFAULT 0,   -- trailing 7-day units/day
  velocity_28d_avg        numeric(10,2) NOT NULL DEFAULT 0,
  trend_delta_bp          int NOT NULL DEFAULT 0,             // (7d−28d)/28d in basis points, signed
  days_of_cover           numeric(10,2),                      -- stock_qty / velocity_7d_avg; NULL when velocity=0
  expiry_risk_days        int,                                -- min days to expiry_date from stat_date; NULL if none
  refreshed_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, stat_date, sku),
  FOREIGN KEY (merchant_id, sku) REFERENCES catalog_raw (merchant_id, sku)
);
CREATE INDEX sds_recent_idx ON sku_daily_stats (merchant_id, stat_date DESC);
```

Deliberate split of responsibilities: `sales_stats_daily` is *what happened* (auditable rollup), `sku_daily_stats` is *what it implies* (derived, recomputable, disposable). The campaign agent mines priorities from these plus `attach_rates` — it interprets, it does not fabricate numbers.

### 2.9 attach_rates — co-purchase statistics

```sql
CREATE TABLE attach_rates (
  merchant_id          uuid NOT NULL REFERENCES merchants(id),
  antecedent_sku       text NOT NULL,
  consequent_sku       text NOT NULL,
  window_days          int NOT NULL DEFAULT 90 CHECK (window_days > 0),
  co_occurrence_orders int NOT NULL CHECK (co_occurrence_orders >= 0),
  antecedent_orders    int NOT NULL CHECK (antecedent_orders >= 0),
  confidence           numeric(6,4) NOT NULL,   -- P(consequent | antecedent)
  lift                 numeric(8,4) NOT NULL,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, antecedent_sku, consequent_sku, window_days),
  FOREIGN KEY (merchant_id, antecedent_sku) REFERENCES catalog_raw (merchant_id, sku),
  FOREIGN KEY (merchant_id, consequent_sku) REFERENCES catalog_raw (merchant_id, sku),
  CONSTRAINT ar_confidence_range CHECK (confidence BETWEEN 0 AND 1)
);
```

### 2.10 campaign_priority_sets — persisted PrioritySets (degradation anchor)

The degradation contract "campaign failure → previous PrioritySet persists" requires persistence:

```sql
CREATE TABLE campaign_priority_sets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id        uuid NOT NULL REFERENCES merchants(id),
  status             priority_set_status NOT NULL DEFAULT 'DRAFT',
  priorities         jsonb NOT NULL,       -- PrioritySet per shared schema; items carry plain-language rationale
  computed_from_date date NOT NULL,
  model_meta         jsonb,                -- NULL when produced by fallback/reuse path
  created_at         timestamptz NOT NULL DEFAULT now(),
  activated_at       timestamptz,
  superseded_at      timestamptz
);
CREATE UNIQUE INDEX cps_one_active_idx ON campaign_priority_sets (merchant_id) WHERE status = 'ACTIVE';
```

On campaign-agent failure the pipeline activates nothing new and negotiates against the row still in `ACTIVE` — persistence *is* the graceful-degradation mechanism.

### 2.11 transactions — correlation root

```sql
CREATE TABLE transactions (
  tx_id             uuid PRIMARY KEY,        -- UUIDv7, generated app-side; CHECK (is_uuid_v7(tx_id)) recommended
  merchant_id       uuid NOT NULL REFERENCES merchants(id),
  buyer_identity_id uuid NOT NULL REFERENCES agent_identities(id),
  state             tx_state NOT NULL DEFAULT 'OPEN',
  final_outcome     gate_outcome,            -- denormalized for the dashboard
  cart_value_paise  bigint,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  CONSTRAINT t_ended_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX t_merchant_started_idx ON transactions (merchant_id, started_at DESC);
```

This table is a convenience index over reality — reality is `audit_log` (§5). It exists to give `proposals`/`decisions`/`orders` a FK target and make the trace screen's first query trivial.

### 2.12 proposals — what the AI proposed (never approved)

```sql
CREATE TABLE proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id               uuid NOT NULL REFERENCES transactions(tx_id),
  attempt             int NOT NULL DEFAULT 1 CHECK (attempt >= 1),   -- LLM attempt then FALLBACK attempt
  source              proposal_source NOT NULL DEFAULT 'LLM_NEGOTIATION',
  request             jsonb NOT NULL,      -- normalized buyer request INCLUDING verbatim customer_note (injection intact)
  evidence_pack       jsonb NOT NULL,      -- Evidence Pack exactly as handed to the LLM, stable EV-* ids
  proposed_cart       jsonb NOT NULL,      -- PROPOSED cart; never mutated after write
  citations           jsonb NOT NULL,      -- CitationZ[] ; RULE_FALLBACK stores '[]'
  citation_audit      jsonb,               -- deterministic auditor verdict {valid:boolean, violations:[…]}; NULL while PROPOSED
  priority_set_id     uuid REFERENCES campaign_priority_sets(id),  -- the injected ACTIVE set
  model_meta          jsonb,               -- {model, stop_reason, usage{…}, latency_ms, stable_mode_replayed, llm_call_id}
  status              proposal_status NOT NULL DEFAULT 'PROPOSED',
  proposed_cart_hash  text NOT NULL,       -- sha256(canonicalJson(proposed_cart)); binds approvals & settlement
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT p_shapes CHECK (
    jsonb_typeof(proposed_cart) = 'object' AND jsonb_typeof(citations) = 'array'),
  CONSTRAINT p_fallback_uncited CHECK (source <> 'RULE_FALLBACK' OR citations = '[]'::jsonb),
  CONSTRAINT p_hash_hex CHECK (proposed_cart_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX p_attempt_unique_idx ON proposals (tx_id, attempt);  -- concurrent fallback can't race
CREATE INDEX p_tx_idx ON proposals (tx_id);
```

### 2.13 gatekeeper_decisions — the deterministic verdict

```sql
CREATE TABLE gatekeeper_decisions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id                      uuid NOT NULL REFERENCES transactions(tx_id),
  proposal_id                uuid NOT NULL REFERENCES proposals(id),
  outcome                    gate_outcome NOT NULL,
  rules_version              int NOT NULL,
  rules_checksum             text NOT NULL,     -- ties decision to the EXACT ruleset evaluated
  rule_trace                 jsonb NOT NULL,    -- RuleTraceEntryZ[], rendered by the UI color-coded
  decline_reasons            text[] NOT NULL DEFAULT '{}',   -- machine-readable failed rule_ids
  blended_margin_bp          int,               -- post-discount basket margin from RAW prices
  evaluated_cart_value_paise bigint NOT NULL CHECK (evaluated_cart_value_paise >= 0),
  evaluation_ms              int NOT NULL DEFAULT 0 CHECK (evaluation_ms >= 0),
  input_hash                 text NOT NULL,     -- sha256(canonical({cart, rules_snapshot, identity_history}))
  decided_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gk_trace_is_array CHECK (jsonb_typeof(rule_trace) = 'array'),
  CONSTRAINT gk_input_hash_hex CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT gk_decline_needs_reasons CHECK (outcome <> 'DECLINE_WITH_REASON' OR cardinality(decline_reasons) > 0)
);
CREATE INDEX gk_tx_idx ON gatekeeper_decisions (tx_id);
```

`input_hash` is the tamper-evidence cross-check: the replay endpoint recomputes it from audit-log-recovered inputs and compares — if someone edited `proposals.proposed_cart` directly (they can't via grants, but belt-and-braces), hashes disagree and replay flags it.

### 2.14 stock_reservations — atomic hold + TTL release

```sql
CREATE TABLE stock_reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id          uuid NOT NULL REFERENCES transactions(tx_id),
  merchant_id    uuid NOT NULL REFERENCES merchants(id),
  status         reservation_status NOT NULL DEFAULT 'ACTIVE',
  expires_at     timestamptz NOT NULL,          -- TTL; sweeper (every 30s) releases past this
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  release_reason text,                          -- 'converted' | 'manual_decline' | 'ttl_expired' | 'payment_failed'
  CONSTRAINT sr_release_after_created CHECK (released_at IS NULL OR released_at >= created_at),
  CONSTRAINT sr_terminal_has_release CHECK (status = 'ACTIVE' OR released_at IS NOT NULL)
);
CREATE UNIQUE INDEX sr_one_active_per_tx ON stock_reservations (tx_id) WHERE status = 'ACTIVE';
CREATE INDEX sr_sweeper_idx ON stock_reservations (status, expires_at);

CREATE TABLE stock_reservation_lines (
  reservation_id uuid NOT NULL REFERENCES stock_reservations(id) ON DELETE CASCADE,
  merchant_id    uuid NOT NULL,
  sku            text NOT NULL,
  qty            int NOT NULL CHECK (qty > 0),
  PRIMARY KEY (reservation_id, sku),
  FOREIGN KEY (merchant_id, sku) REFERENCES catalog_raw (merchant_id, sku)
);
```

Atomic decrement pattern (single statement = atomic under MVCC; zero rows returned ⇒ insufficient stock ⇒ whole reservation transaction rolls back):

```sql
UPDATE catalog_raw
   SET stock_qty = stock_qty - $qty, updated_at = now()
 WHERE merchant_id = $m AND sku = $sku AND stock_qty >= $qty
RETURNING stock_qty;
```

TTL sweeper (runs in-process every 30 s):

```sql
WITH expired AS (
  UPDATE stock_reservations
     SET status = 'EXPIRED', released_at = now(), release_reason = 'ttl_expired'
   WHERE status = 'ACTIVE' AND expires_at < now()
  RETURNING id, merchant_id
)
-- restore quantities line-by-line in the same transaction, then append
-- STOCK_RESERVATION_EXPIRED audit events per tx (audit write joins the same transaction).
```

Deadlock avoidance: lines are always processed sorted by `sku`.

### 2.15 orders — settlement target (field names verified against Razorpay docs, see §12)

```sql
CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id               uuid NOT NULL REFERENCES transactions(tx_id),
  merchant_id         uuid NOT NULL REFERENCES merchants(id),
  razorpay_order_id   text UNIQUE,        -- 'order_DaZlswtdcn9UNV'-style; mock provider emits 'mock_order_…'
  receipt             text NOT NULL UNIQUE,   -- = tx_id string: 36 chars ≤ Razorpay's 40-char cap (verified)
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  currency            char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status              order_status NOT NULL DEFAULT 'CREATED',  -- mapped subset of Razorpay statuses
  provider_status     text,               -- RAW status string from provider ('created'|'attempted'|'paid'), kept verbatim
  attempts            int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  razorpay_payment_id text,
  provider            text NOT NULL DEFAULT 'razorpay_test' CHECK (provider IN ('razorpay_test','mock')),
  idempotency_key     text NOT NULL UNIQUE,   -- settlement-scoped: '<tx_id>:create_order:v1' (Redis-backed too)
  reservation_id      uuid REFERENCES stock_reservations(id),
  notes               jsonb NOT NULL DEFAULT '{}'::jsonb,  -- ≤15 pairs × ≤256 chars per Razorpay (app-side assert)
  created_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX o_tx_idx ON orders (tx_id);
```

Why `provider_status` beside the enum: Razorpay's documented order statuses are `created`/`attempted`/`paid`; if test mode ever surfaces something else, we archive the raw string instead of failing the insert, and the mapper routes unknowns to `FAILED` with the raw preserved for humans.

### 2.16 approval_requests — human-in-the-loop inbox item

```sql
CREATE TABLE approval_requests (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id                  uuid NOT NULL REFERENCES transactions(tx_id),
  proposal_id            uuid NOT NULL REFERENCES proposals(id),
  approved_proposal_hash text NOT NULL,   -- MUST equal proposals.proposed_cart_hash
  reason                 text NOT NULL,   -- 'CART_VALUE_ABOVE_AUTO_APPROVE_LIMIT' | 'ESC_BAND_SOFT_EDGE' | 'VELOCITY_LIMIT_HIT'
  rule_trace_snapshot    jsonb NOT NULL,  -- frozen trace so the inbox renders even after later activity
  requested_value_paise  bigint NOT NULL CHECK (requested_value_paise >= 0),
  status                 approval_status NOT NULL DEFAULT 'PENDING',
  expires_at             timestamptz NOT NULL,   -- pending-approval TTL (demo: 10 min)
  decided_by             text,            -- merchant user label from the UI session
  decision_note          text,
  decided_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ar_hash_hex CHECK (approved_proposal_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ar_pending_shape CHECK (
    (status = 'PENDING' AND decided_at IS NULL AND decided_by IS NULL) OR
    (status IN ('APPROVED','REJECTED') AND decided_at IS NOT NULL AND decided_by IS NOT NULL) OR
    (status = 'EXPIRED' AND decided_at IS NOT NULL))
);
CREATE INDEX ar_pending_inbox_idx ON approval_requests (status, expires_at) WHERE status = 'PENDING';

-- Same-proposal binding (the "never re-proposes" guarantee, mechanically enforced):
ALTER TABLE approval_requests
  ADD CONSTRAINT ar_hash_matches_proposal
  FOREIGN KEY (proposal_id, approved_proposal_hash)
  REFERENCES proposals (id, proposed_cart_hash);
```

The composite FK makes it *impossible* to store an approval whose hash disagrees with the proposal row. Settlement additionally re-reads the hash before executing; a mismatch aborts fail-closed and narrates.

### 2.17 webhook_events — dedupe + signature forensics

Verified mechanics (§12): the signature rides in the **`X-Razorpay-Signature` header** as `HMAC-SHA256(webhook_secret, raw_request_body)`; the docs explicitly warn to verify over the **raw body** ("Do not parse or cast the webhook request body"); dedupe uses the **`x-razorpay-event-id` header**, unique per event; delivery is at-least-once with exponential-backoff retries for 24 h, and Razorpay expects a fast 2xx.

```sql
CREATE TABLE webhook_events (
  id                  bigserial PRIMARY KEY,
  event_id            text NOT NULL UNIQUE,   -- from x-razorpay-event-id HEADER; the dedupe key
  event_type          text,                   -- body.event ('order.paid'|'payment.captured'|'payment.failed'|…); NULL if body unparseable
  signature           text NOT NULL,          -- X-Razorpay-Signature header value, archived
  signature_verified  boolean NOT NULL DEFAULT false,
  verification_error  text,
  raw_body            text,                   -- EXACT raw bytes as text — required to re-run HMAC forensics later
  payload             jsonb,                  -- parsed body (opaque jsonb; adapter reads defensively)
  provider            text NOT NULL DEFAULT 'razorpay_test' CHECK (provider IN ('razorpay_test','mock')),
  processing_state    webhook_processing_state NOT NULL DEFAULT 'RECEIVED',
  tx_id               uuid,                   -- correlated via receipt/notes; NEVER trusted for settlement decisions
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz
);
CREATE INDEX wh_tx_idx ON webhook_events (tx_id) WHERE tx_id IS NOT NULL;
CREATE INDEX wh_unprocessed_idx ON webhook_events (processing_state) WHERE processed_at IS NULL;
```

Handler contract: (1) read raw body + headers, (2) `INSERT … ON CONFLICT (event_id) DO NOTHING RETURNING id` — zero rows means duplicate delivery ⇒ respond `200` immediately (at-least-once semantics verified; Razorpay retries anything else for 24 h), (3) verify HMAC over `raw_body` **before any state mutation**, updating `signature_verified`/`processing_state`, (4) only then correlate `tx_id` and emit audit events. Events may arrive **out of order** (documented by Razorpay) — settlement waits on the specific `order.paid`/`payment.captured` for its own `razorpay_order_id`, never on sequence assumptions.

### 2.18 audit_log — the hash-chained spine

```sql
CREATE TABLE audit_log (
  seq         bigserial PRIMARY KEY,     -- GLOBAL monotonic order == SSE event id (§6)
  tx_id       uuid NOT NULL,             -- genesis row uses the zero UUID. NO FK on purpose:
                                         -- the chain must never be blocked/cascaded by
                                         -- the lifecycle of any operational table.
  merchant_id uuid,
  agent       text NOT NULL,             -- AuditAgentZ vocabulary
  event_type  audit_event_type NOT NULL,
  payload     jsonb NOT NULL,            -- integers-only numerics; canonicalizable (§4.1)
  prev_hash   char(64) NOT NULL,
  hash        char(64) NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT al_hash_hex       CHECK (hash      ~ '^[0-9a-f]{64}$'),
  CONSTRAINT al_prev_hash_hex  CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT al_hashes_differ  CHECK (hash <> prev_hash)
);
CREATE INDEX al_tx_seq_idx ON audit_log (tx_id, seq);        -- replay + SSE resume hot path
CREATE INDEX al_agent_time_idx ON audit_log (agent, created_at DESC);
```

### 2.19 llm_calls — DEMO_STABLE_MODE recordings + cost/error telemetry

Wire-shape facts baked into this design (from the bundled Claude API reference): requests omit `temperature`/`top_p`/`top_k` (removed on opus‑5 → HTTP 400) and `thinking.budget_tokens` (also removed → 400); `usage` carries `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`; errors arrive as typed `Anthropic.APIError` subclasses.

```sql
CREATE TABLE llm_calls (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id                uuid,               -- NULL for offline calls (catalog enrichment, campaign mining)
  merchant_id          uuid,
  agent                text NOT NULL,      -- 'negotiation' | 'catalog_intelligence' | 'campaign' | 'explainer' | 'buyer_sim'
  purpose              text NOT NULL,      -- 'propose_bundle' | 'enrich_sku' | 'mine_priorities' | 'narrate'
  model                text NOT NULL DEFAULT 'claude-opus-5',
  prompt_hash          char(64) NOT NULL,  -- sha256(canonicalJson(exact request params)) — replay lookup key
  request              jsonb NOT NULL,     -- exact Messages params SENT: model, max_tokens, system(+cache_control),
                                           -- messages(+cache_control last), tools, thinking:{type:"adaptive"},
                                           -- output_config.format (structured outputs). Credentials never included.
  response             jsonb,              -- raw Message: {id:"msg_…", type:"message", role, content[],
                                           -- stop_reason("end_turn"|"max_tokens"|"tool_use"|"pause_turn"|"refusal"), usage{…}}
  usage                jsonb,              -- copied top-level for cheap dashboards incl. cache_* token counts
  latency_ms           int CHECK (latency_ms IS NULL OR latency_ms >= 0),
  outcome              llm_call_outcome NOT NULL DEFAULT 'OK',
  error                jsonb,              -- typed exception serialized: {name:"RateLimitError", status, message, request_id}
  stable_mode_replayed boolean NOT NULL DEFAULT false,  -- true = served from a recording, no network
  recorded             boolean NOT NULL DEFAULT false,  -- eligible as a replay source
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lc_fail_has_error   CHECK (outcome = 'OK' OR error IS NOT NULL),
  CONSTRAINT lc_ok_has_response  CHECK (outcome <> 'OK' OR response IS NOT NULL),
  CONSTRAINT lc_prompt_hash_hex  CHECK (prompt_hash ~ '^[0-9a-f]{64}$')
);
-- At most one recording per identical request; identical request ⇒ semantically interchangeable replay:
CREATE UNIQUE INDEX lc_recording_idx ON llm_calls (prompt_hash) WHERE recorded;
CREATE INDEX lc_tx_idx   ON llm_calls (tx_id)   WHERE tx_id IS NOT NULL;
CREATE INDEX lc_agent_ts ON llm_calls (agent, created_at DESC);
```

Stable-mode wrapper (the only place agents touch the SDK):

```ts
async function stableMessagesCall(
  ctx: { txId: string | null; merchantId: string | null; agent: AgentName; purpose: string },
  params: MessageCreateParamsNonStreaming,          // built once, reused verbatim for hash + send
): Promise<Message> {
  const promptHash = sha256Hex(canonicalJson(params as unknown as Json));
  const started = Date.now();

  if (DEMO_STABLE_MODE) {
    const hit = await db.query(
      `SELECT response FROM llm_calls
        WHERE prompt_hash = $1 AND outcome = 'OK' AND stable_mode_replayed = false
        ORDER BY created_at LIMIT 1`, [promptHash]);
    if (hit.rows.length > 0) {
      await insertLlmCall(ctx, params, promptHash, hit.rows[0].response,
        { latencyMs: Date.now() - started, outcome: "OK", replayed: true });
      return MessageSchema.parse(hit.rows[0].response);   // zod-validate the recording too
    }
  }
  try {
    const msg = await anthropic.messages.parse(params);   // structured outputs via zodOutputFormat
    await insertLlmCall(ctx, params, promptHash, msg,
      { latencyMs: Date.now() - started, outcome: "OK", replayed: false, recorded: DEMO_STABLE_MODE });
    return msg;
  } catch (err) {
    const outcome: LlmCallOutcome =
      err instanceof Anthropic.RateLimitError ? "RATE_LIMIT"
      : err instanceof Anthropic.APIError    ? "API_ERROR"
      : "TIMEOUT";
    await insertLlmCall(ctx, params, promptHash, null,
      { latencyMs: Date.now() - started, outcome, error: serializeTypedError(err) });
    throw err;                                            // callers degrade per the contracts
  }
}
```

Two deliberate synergies: (1) prompt-cache discipline ("frozen system prefix first, volatile content last") is *also* replay discipline — volatile timestamps sit outside the hashed stable core only if you exclude them from `params` before hashing; the wrapper hashes exactly what is sent, and the pipeline builds `params` without wall-clock noise, so replay hits are reliable. (2) Adaptive thinking is not byte-reproducible across runs — which is precisely why DEMO_STABLE_MODE replays the recorded `response` object rather than re-generating.

---

## 3. Entity relationship summary

```
merchants ─┬─< agent_identities
           ├─< merchant_rules            (versioned; 1 active via partial unique idx)
           ├─< catalog_raw ─┬─< sales_history ─(rollup)→ sales_stats_daily
           │                ├─1:1 catalog_enriched   (composite FK, no commercial columns)
           │                ├─< sku_daily_stats, attach_rates
           │                └─< stock_reservation_lines
           ├─< campaign_priority_sets
           └─< transactions ─┬─< proposals ─────< gatekeeper_decisions
                             ├─1:1 stock_reservations ─< stock_reservation_lines
                             ├─1:1 orders ────(dedupe/correlate)─── webhook_events
                             ├─< approval_requests ─(FK on proposal_id+hash)→ proposals
                             └─< audit_log (tx_id indexed, NO FK — chain outlives everything)
llm_calls (standalone; optional tx_id link)
```

---

## 4. Hash chain specification

### 4.1 Canonical JSON serialization (one implementation, used by writer, verifier, replay, and migrations)

Rule name pinned everywhere: **`growth-canonical-json-v1`**.

1. Objects: keys sorted ascending by **Unicode code point** (equivalently: lexicographic UTF-8 byte order — not JS default array order, which sorts by UTF-16 code units and differs for astral characters; the comparator below is explicit).
2. Recursion applies to nested objects/arrays; arrays keep order (order is semantic).
3. Zero whitespace: `,` and `:` separators only.
4. Numbers: **safe integers only**; rendered as plain decimal digits (no exponent, no `.0`). Any float anywhere in an audited payload throws. This is why §0 mandates paise/basis-points.
5. Strings: `JSON.stringify` escaping (control chars escaped, quotes/backslashes escaped, other Unicode emitted as raw UTF-8 — no `\uXXXX` re-encoding).
6. `undefined` properties dropped (matches JSON round-tripping); `null` preserved.
7. Serialization is UTF-8 encoded before hashing.

```ts
import { createHash } from "node:crypto";
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export const GENESIS_PREV_HASH = "0".repeat(64);
export const CANONICALIZATION_ID = "growth-canonical-json-v1";

function cmpCodePoint(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new TypeError("audit payloads allow safe integers only (store money as paise)");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort(cmpCodePoint);
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** hash = SHA256( prev_hash_as_ascii_hex ‖ UTF8(canonicalJson(payload)) ) */
export function computeRowHash(prevHashHex: string, payload: Json): string {
  return createHash("sha256")
    .update(prevHashHex, "ascii")                                  // no separator, documented
    .update(Buffer.from(canonicalJson(payload), "utf8"))
    .digest("hex");
}
```

### 4.2 Row convention

Every row satisfies `hash = SHA256(prev_hash ‖ canonical(payload))`, with `prev_hash` = the previous row's `hash` by `seq` order. The chain is **global** (all transactions interlinked), not per-tx: any deletion/reorder/edit anywhere is detectable from any starting point, per-tx filtering stays a simple indexed `WHERE tx_id = …`, and the SSE id space stays dense.

**Genesis row** — inserted by the very first migration (which, being a JS module, imports the shared canonicalizer so the constant can never drift from the algorithm):

```ts
// migrations/0007_audit_genesis.ts (node-pg-migrate)
import { computeRowHash, GENESIS_PREV_HASH } from "../../shared/src/audit/canonical";

const payload = {
  algorithm: "sha256",
  canonicalization: CANONICALIZATION_ID,   // "growth-canonical-json-v1"
  chain: "audit_log",
  schema_version: 1,
};
exports.up = (pgi) =>
  pgi.insert("audit_log", {
    tx_id: "00000000-0000-0000-0000-000000000000",
    merchant_id: null, agent: "system", event_type: "CHAIN_GENESIS",
    payload: JSON.stringify(payload),
    prev_hash: GENESIS_PREV_HASH,
    hash: computeRowHash(GENESIS_PREV_HASH, payload),
  });
```

### 4.3 Append protocol (crash-safe, fork-proof, DB-enforced)

The DB itself refuses forks and gaps, so even buggy callers cannot corrupt linkage:

```sql
-- Linkage guard: serializes appends and pins prev_hash to the current head.
CREATE OR REPLACE FUNCTION al_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(424242);                 -- serialize concurrent appends
  IF NEW.prev_hash = repeat('0', 64) THEN
    RAISE EXCEPTION 'audit_log: genesis prev_hash reserved' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_log) THEN
    IF NEW.prev_hash IS DISTINCT FROM (SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1) THEN
      RAISE EXCEPTION 'audit_log: chain fork/gap — prev_hash % is not current head',
        NEW.prev_hash USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.prev_hash IS DISTINCT FROM repeat('0', 64) THEN
    RAISE EXCEPTION 'audit_log: first real row must chain from genesis';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER al_link_guard_trg BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION al_link_guard();
```

App-side writer (the advisory lock in the trigger already serializes; taking it in the app first merely avoids a wasted hash computation):

```ts
export async function appendAudit(
  client: PoolClient, evt: { txId: string; merchantId: string | null; agent: AuditAgent;
                              eventType: AuditEventType; payload: Json; },
): Promise<AppendedEvent> {
  AuditEventZ.parse(evt);                                 // envelope validated pre-insert
  await client.query("SELECT pg_advisory_xact_lock($1)", [424242]);
  const head = await client.query<{ hash: string }>(
    "SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1");
  const prevHash = head.rows[0]?.hash ?? GENESIS_PREV_HASH;
  const hash = computeRowHash(prevHash, evt.payload);     // same shared fn the verifier uses
  const res = await client.query<{ seq: string; created_at: Date }>(
    `INSERT INTO audit_log (tx_id, merchant_id, agent, event_type, payload, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING seq, created_at`,
    [evt.txId, evt.merchantId, evt.agent, evt.eventType, JSON.stringify(evt.payload), prevHash, hash]);
  return { seq: Number(res.rows[0].seq), createdAt: res.rows[0].created_at, hash };
}
```

The audit INSERT shares the caller's transaction wherever the caller has one (stock release, order creation), so business mutation and its audit trail commit atomically.

### 4.4 Verification algorithm (incremental, streaming)

```ts
export type ChainIssueKind = "GENESIS_INVALID" | "LINK_BREAK" | "HASH_MISMATCH" | "SEQ_GAP";
export interface ChainIssue { kind: ChainIssueKind; seq: number; detail: string; }
export interface VerifyReport {
  ok: boolean;
  rows_scanned: number;
  last_good_seq: number | null;
  head_hash: string | null;
  issues: ChainIssue[];
}

/**
 * Verifies the chain forward from `opts.fromSeq` (default: beginning).
 * Incremental mode: pass opts.fromSeq together with opts.trustedPrefixHead — the
 * previously published head hash (UI footer / ops log). Rows before fromSeq are
 * skipped; their integrity is attested by trustedPrefixHead.
 * Streams in batches of 500 ORDER BY seq ASC — O(n) time, O(1) memory.
 */
export async function verifyAuditChain(
  db: Pool, opts: { fromSeq?: number; trustedPrefixHead?: string } = {},
): Promise<VerifyReport> {
  let expectedPrev = opts.trustedPrefixHead ?? null;
  let expectNextSeq: number | "unknown" = opts.fromSeq ?? "unknown";
  let scanned = 0, lastGood: number | null = null, issues: ChainIssue[] = [];
  for await (const row of streamRows(db, /* ORDER BY seq ASC */)) {
    if (expectNextSeq !== "unknown" && row.seq !== expectNextSeq)
      issues.push({ kind: "SEQ_GAP", seq: row.seq, detail: `expected seq ${expectNextSeq}` });
    if (expectedPrev === null && row.seq === 1) {           // genesis checks
      if (row.prev_hash !== GENESIS_PREV_HASH || row.hash !== computeRowHash(GENESIS_PREV_HASH, row.payload))
        issues.push({ kind: "GENESIS_INVALID", seq: 1, detail: "genesis row does not self-verify" });
    } else if (expectedPrev !== null) {
      if (row.prev_hash !== expectedPrev)
        issues.push({ kind: "LINK_BREAK", seq: row.seq,
                      detail: `prev_hash ${row.prev_hash.slice(0,12)}… ≠ prior hash ${expectedPrev.slice(0,12)}…` });
      if (row.hash !== computeRowHash(expectedPrev, row.payload))
        issues.push({ kind: "HASH_MISMATCH", seq: row.seq, detail: "payload does not reproduce stored hash" });
    }
    if (issues.at(-1)?.seq !== row.seq) { lastGood = row.seq; }  // row survived all checks
    expectedPrev = row.hash;                               // continue chain regardless, to map ALL damage
    expectNextSeq = row.seq + 1; scanned++;
  }
  return { ok: issues.length === 0, rows_scanned: scanned, last_good_seq: lastGood,
           head_hash: expectedPrev, issues };
}
```

Verifier invariants tested in §11-A: a single flipped payload byte yields exactly one `HASH_MISMATCH` **plus** downstream `LINK_BREAK`s (damage propagates — that's the point); a deleted middle row yields `SEQ_GAP` + `LINK_BREAK`; reordering is impossible to distinguish from delete+insert and shows up identically; a fully recomputed chain from the tamper point onward is undetectable locally — see the honest limitation below.

**Limitation stated plainly:** the chain detects *post-hoc tampering by anyone who does not re-hash the tail*. An attacker with DB write access who recomputes all subsequent hashes defeats verification unless heads are anchored elsewhere. Mitigation shipped: the current head hash is displayed in the frontend footer and written to stdout on boot; comparing today's footer against yesterday's screenshot/log catches wholesale rewrites. (External anchoring — pushing heads to a second sink — is a documented stretch goal.)

---

## 5. Append-only enforcement

Three independent layers:

**(a) Least-privilege grants (primary control)** — see §8 for the full role sketch. For the audit table specifically:

```sql
GRANT  SELECT, INSERT ON audit_log TO growth_app;
GRANT  USAGE ON SEQUENCE audit_log_seq_seq TO growth_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM growth_app;  -- default-deny anyway; explicit = auditable intent
-- growth_readonly gets SELECT only; growth_migrator (owner) retains DDL rights.
```

**(b) Defense-in-depth triggers** (catch superuser/role mistakes):

```sql
CREATE OR REPLACE FUNCTION al_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % blocked (seq=%)', TG_OP, OLD.seq
    USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER al_no_update   BEFORE UPDATE   ON audit_log FOR EACH ROW      EXECUTE FUNCTION al_append_only_guard();
CREATE TRIGGER al_no_delete   BEFORE DELETE   ON audit_log FOR EACH ROW      EXECUTE FUNCTION al_append_only_guard();
CREATE TRIGGER al_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION al_append_only_guard();
```

**(c)** Nothing in the application ever issues UPDATE/DELETE against `audit_log`; a repo-layer type (`AuditLogRepo` exposes only `append`/`readRange`/`verify`) makes the forbidden operations unrepresentable in TypeScript.

---

## 6. Correlation infrastructure

### 6.1 tx_id lifecycle

Pipeline orchestrator mints `tx_id = uuidv7()` (package `uuidv7`, RFC 9562) as its first act, opens the span, inserts the `transactions` root, and appends `PIPELINE_STARTED`. UUIDv7 gives time-ordered keys → B-tree locality on `(tx_id, seq)` and free chronological sorting of the trace list.

### 6.2 seq doubles as the SSE event id

Because `audit_log.seq` is a dense global monotonic, it is the ideal SSE `id:`. The SSE stream is a *projection of audit rows*, not a parallel channel — 1:1 by construction:

```
appendAudit() COMMIT
   → AFTER INSERT trigger NOTIFYs 'audit_events' with {tx_id, seq}   (works across processes)
   → SSE bridge receives NOTIFY, SELECTs rows WHERE tx_id=$1 AND seq > cursor
   → writes frame:  id: <seq>\nevent: <event_type>\ndata: <full audit row JSON>\n\n
```

Resume is then free: `EventSource` automatically sends `Last-Event-ID: <seq>` on reconnect; the handler resumes with `WHERE tx_id = $1 AND seq > $lastEventId ORDER BY seq`. No out-of-band offset tracking, no missed/duplicated frames after redeploy.

```ts
// GET /api/v1/transactions/:txId/events  (text/event-stream)
export async function txEvents(req, res) {
  const txId = req.params.txId;
  const lastEventId = Number(req.headers["last-event-id"] ?? 0);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache",
                       connection: "keep-alive", "retry": "2000" });
  let cursor = await drainHistory(res, txId, lastEventId);   // replay backlog first
  const listener = onNotify("audit_events", async (note) => {
    if (note.tx_id !== txId) return;
    cursor = await drainHistory(res, txId, cursor);          // read from audit_log = always 1:1
  });
  req.on("close", () => listener.close());
}
async function drainHistory(res, txId, cursor) { /* SELECT … seq > cursor ORDER BY seq; write frames */ }
```

Frame example (adversarial beat):

```
id: 481
event: GATEKEEPER_EVALUATED
data: {"seq":481,"tx_id":"018f6a2e-…","agent":"gatekeeper","event_type":"GATEKEEPER_EVALUATED",
       "payload":{"outcome":"DECLINE_WITH_REASON","failed":["MAX_DISCOUNT_PCT"],
                  "trace":[{"rule_id":"MAX_DISCOUNT_PCT","passed":false,"severity":"HARD",
                            "expected":"<= 15 pct","actual":"50 pct","detail":"EMPLOYEE50 rejected"}]},
       "prev_hash":"9be1c4…","hash":"77ac02…"}
```

### 6.3 pino child bindings

```ts
// shared/src/logging.ts
import { pino } from "pino";
export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: ["req.headers.authorization", "*.api_key", "*key_hash"], censor: "[REDACTED]" },
});

export function txLogger(ctx: { tx_id: string; agent: AuditAgent; }) {
  return rootLogger.child(ctx);            // every line carries {tx_id, agent}
}
// per-step, after the audit row lands:
const log = txLogger({ tx_id: txId, agent: "gatekeeper" }).child({ seq, event_type });
log.info({ outcome }, "gatekeeper decision recorded");
```

Correlation triangle: **UI glitch → SSE `id:` = audit `seq` → DB row → log line with the same `{tx_id, agent, seq}`.** One identifier space end-to-end. (`seq` comes back from `pg` as a string; `Number(seq)` is safe at demo volumes — guarded by an assertion `< 2^53`.)

---

## 7. Replay endpoint — rebuilding reality from `audit_log` ALONE

**Claim under test:** the audit trail is complete enough to reconstruct the entire transaction timeline with **zero** reads of operational tables. Screen (a)'s "post-mortem" tab renders from this endpoint, proving the point live.

`GET /api/v1/transactions/:txId/replay`

```ts
interface ReplayResponse {
  tx_id: string;
  built_from: "audit_log_only";
  generated_at: string;                       // ISO-8601
  chain_integrity:
    | { status: "VERIFIED"; verified_through_seq: number; head_hash: string }
    | { status: "BROKEN"; issues: ChainIssue[] };   // UI paints the red tamper banner from this
  timeline: Array<{
    seq: number; ts: string; agent: AuditAgent; event_type: AuditEventType;
    payload: Json; hash: string; prev_hash: string;
  }>;
  derived: {                                  // folded view the UI binds to directly
    buyer_identity?: { display_name: string; kind: "BUYER" | "INTERNAL" };
    injection_flags?: string[];                        // from INJECTION_HEURISTIC_FLAGGED payloads
    buyer_request?: Json;
    evidence_pack_summary?: { pack_id: string; evidence_count: number };
    priority_set_applied?: { set_id: string; top_priority_title: string };
    proposal?: { attempt: number; source: "LLM_NEGOTIATION" | "RULE_FALLBACK";
                 proposed_cart: Json; cart_value_paise: number;
                 citations_valid: boolean | null; citation_violations: string[] };
    gatekeeper?: { outcome: "APPROVE" | "DECLINE_WITH_REASON" | "ESCALATE_TO_HUMAN";
                   rules_version: number; failed_rule_ids: string[];
                   blended_margin_bp: number | null; rule_trace: RuleTraceEntry[] };
    explainer_narrative?: string;
    settlement?: { razorpay_order_id: string | null; provider_status: string | null;
                   payment_confirmed_at: string | null };
    approvals?: Array<{ id: string; status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
                        decided_by: string | null }>;
  };
}
```

Algorithm (single handler, ~60 lines): (1) `SELECT * FROM audit_log WHERE tx_id = $1 ORDER BY seq` — the only query; (2) run `verifyAuditChain` (global, cheap at demo volume; incremental variant available via `trustedPrefixHead`); (3) fold `event_type` → `derived` via a pure reducer `foldTimeline(rows): DerivedView` (unit-tested independently); (4) respond. If the tx has zero rows: `404` with `chain_integrity.status: "VERIFIED"` for the empty range. If `BROKEN`: still `200` — a tampered trail is *exactly* what you want the UI to display, with the first bad `seq` and reason.

When `chain_integrity.status = BROKEN`, the endpoint MUST partition the timeline at `broken_at_seq` (= `last_good_seq + 1`): rows ≤ `last_good_seq` render as VERIFIED; rows > `last_good_seq` render ONLY inside a visually quarantined "UNVERIFIED SUFFIX" section (collapsed by default, each row badged UNVERIFIED), and are excluded from `foldTimeline` — all `derived.*` views and `rebuilt_outcome` are computed from the verified prefix alone (`rebuilt_outcome = null` if the terminal event falls beyond the break). Reporting stays HTTP 200; rendering past the break never presents unattested bytes as part of the merchant's history.

Demo tie-in: the chaos toggle "tamper audit trail" performs one `UPDATE` of a payload byte via the migrator role (the only role able to), and the next replay shows `HASH_MISMATCH at seq N` in red — the tamper-indicator moment.

---

## 8. Migration tooling, roles, and grants

**Recommendation: `node-pg-migrate`.** Drizzle-kit's center of gravity is schema-as-TypeScript-objects with `generate`/`push` diffing toward them; the moment your DDL includes procedural triggers, `BEFORE TRUNCATE` guards, composite FKs to `UNIQUE` tuples, partial indexes, and role grants — none of which are this design's exotic extras but its *core guarantees* — you end up fighting the ORM layer or smuggling raw SQL through escape hatches anyway. node-pg-migrate executes exactly the SQL above, migrations are plain JS modules that can import the shared canonicalizer (needed to compute the genesis hash correctly, §4.2), it runs via CLI or programmatically in tests (`migrate.up({dryRun})`), supports down-migrations, and adds one tiny dependency rather than an ORM worldview. For a hackathon whose deliverable is precise DDL, plain migrations are the faster *and* safer road.

Roles (least privilege, three-way split):

```sql
-- Owner of all objects; the ONLY role with DDL. Runs migrations in CI/startup hook.
CREATE ROLE growth_migrator LOGIN PASSWORD :'migrator_pw';
-- Application runtime: DML, narrowly carved.
CREATE ROLE growth_app LOGIN PASSWORD :'app_pw';
-- Dashboards/analytics/debugging: read-only forever.
CREATE ROLE growth_readonly LOGIN PASSWORD :'readonly_pw';

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO growth_migrator, growth_app, growth_readonly;
ALTER SCHEMA public OWNER TO growth_migrator;

-- Set by migrations at the end, and via ALTER DEFAULT PRIVILEGES so FUTURE tables inherit sane grants:
ALTER DEFAULT PRIVILEGES FOR ROLE growth_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO growth_app;              -- DELETE nowhere by default
ALTER DEFAULT PRIVILEGES FOR ROLE growth_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO growth_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE growth_migrator IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO growth_app, growth_readonly;

GRANT SELECT, INSERT, UPDATE ON merchants, catalog_raw, catalog_enriched,
  agent_identities, merchant_rules, campaign_priority_sets, transactions, proposals,
  gatekeeper_decisions, stock_reservations, stock_reservation_lines, orders,
  approval_requests, webhook_events, llm_calls TO growth_app;        -- audit_log handled separately (§5)
GRANT INSERT ON sales_history, sales_stats_daily, sku_daily_stats, attach_rates TO growth_app;  -- seed/refresh only
GRANT SELECT ON ALL TABLES IN SCHEMA public TO growth_readonly;      -- includes audit_log (read/verify only)
GRANT SELECT, INSERT ON audit_log TO growth_app;                     -- NO UPDATE/DELETE/TRUNCATE, ever
```

App-role verb matrix (summary):

| Table | growth_app | growth_readonly | growth_migrator |
|---|---|---|---|
| audit_log | SELECT, INSERT | SELECT | owner (guarded by triggers too) |
| sales_history / *_stats / attach_rates | INSERT, SELECT | SELECT | owner |
| catalog_enriched | SELECT, INSERT, UPDATE (status transitions) | SELECT | owner |
| catalog_raw | SELECT, INSERT, **conditional** UPDATE (stock decrement only) | SELECT | owner |
| everything else operational | SELECT, INSERT, UPDATE (scoped) | SELECT | owner |
| any DELETE | **none, anywhere** (releases/expiries are status flips) | none | owner |

A vitest integration test connects **as `growth_app`** and asserts `UPDATE audit_log …`, `DELETE FROM audit_log …`, `TRUNCATE audit_log` all fail, and that the three append-only triggers fire even when invoked by the owner.

---

## 9. How this schema serves the pipeline (map of writes)

| Pipeline step | Writes |
|---|---|
| Orchestrator start | `transactions` INSERT; audit `PIPELINE_STARTED` |
| Load context | audit `CATALOG_LOADED`, `EVIDENCE_PACK_BUILT`, `PRIORITY_SET_INJECTED` (payload carries the ACTIVE set id) |
| Negotiation | `llm_calls` row; audit `NEGOTIATION_COMPLETED`/`NEGOTIATION_FALLBACK_USED`; `proposals` INSERT |
| Citation Auditor | `proposals.citation_audit` UPDATE (pre-consume, allowed); audit `CITATION_AUDIT_PASSED/FAILED` |
| Injection tagger | audit `INJECTION_HEURISTIC_FLAGGED` (deterministic heuristics; feeds escalation counters) |
| Gatekeeper | `gatekeeper_decisions` INSERT; audit `GATEKEEPER_EVALUATED`; tx state → `GATE_DECIDED` |
| APPROVE → Settlement | `stock_reservations`(+lines); audit `STOCK_RESERVED`; `orders` INSERT (idempotency key); audit `RAZORPAY_ORDER_CREATED` |
| Webhook | `webhook_events` INSERT (deduped); audit `PAYMENT_WEBHOOK_RECEIVED`, `PAYMENT_CONFIRMED`, `TX_SETTLED` |
| DECLINE | audit `TX_DECLINED`; tx state → `DECLINED`; reservation RELEASED |
| ESCALATE | `approval_requests` INSERT; audit `ESCALATION_RAISED`; approval → audit `ESCALATION_APPROVED` → settlement proceeds **with the same `proposed_cart_hash`** |

---

## 10. Seed data model fit — "Meera's Cakes"

One merchant row: `slug='meeras-cakes'`, `sim_time_anchor='2026-08-25T09:00:00+05:30'`. Nine `catalog_raw` rows engineered so the messy-text problem is obvious while every numeric column is clean paise (enrichment must never *need* to touch numbers):

| sku | name_raw (verbatim, messy) | description_raw | uom_raw | cost/list (paise) | stock | expiry | planted role |
|---|---|---|---|---|---|---|---|
| CAKE-TRF-500 | `Choco Truffle Cake 500gm` | decent text | `500gm` | 42000 / 89900 | 12 | NULL | hero seller; bundle anchor |
| CAKE-RVL-500 | `red velvet cake half kg` | sparse | `half kg` | 45000 / 94900 | 8 | NULL | messy unit; birthday attach |
| PSTRY-BSC | `ButterScchop Pastry` | typo'd blurb | `pc` | 3500 / 8500 | 40 | NULL | **UNDERSELLING #1** (typo name) |
| CAKE-RVA-750 | `Eggless Rava cake (special Tuesday!!)` | marketing junk inline | `750g` | 38000 / 79900 | 6 | NULL | messy name w/ noise |
| MITHAI-DIW-250 | `Diwali dryfruit mithai box 250g` | seasonal blurb | `250g` | 21000 / 49900 | 30 | **anchor + 4 days** | **NEAR-EXPIRY** + slow demand |
| COOKIE-TIN-AST | `assorted cookies tin` | **NULL** | `tin` | 12000 / 29900 | 25 | 45 days | missing description → enrichment showcase |
| ACC-CNDL-12 | `Birthday candle pack x12` | thin | `x12` | 6000 / 14900 | 60 | NULL | accessory; high true attach rate |
| CAKE-GFA-750 | `Gluten free almond cake 750 GM` | sparse | `750 GM` | 52000 / 109900 | 5 | NULL | casing chaos; premium |
| JAR-GAN-200 | `ganache jar 200g` | NULL | `200g` | 9000 / 19900 | 18 | 21 days | **UNDERSELLING #2**, slow mover |

`catalog_enriched` seeds as 9× `PENDING`; the on-ingestion agent fills it (failures leave `UNENRICHED` + `error_detail` — the degraded path is itself seeded once for the demo). Occasion tags land as `occasions` arrays: `birthday` (cakes, candles), `anniversary` (truffle/red velvet), `diwali`/`gifting` (mithai box, cookie tin), `congrats`.

**Seeded RNG (fully reproducible):**

```ts
// packages/shared/src/seed/rng.ts
export function mulberry32(seed: number): () => number { /* standard 32-bit PRNG */ }
export const SEED_SALES = 1337;                 // one knob; same seed ⇒ byte-identical sales_history
```

Generation: for each of the 90 days ending at the anchor (day 89 = today), per SKU: `base_demand[sku] × weekday_mult[Sun..Sat] × seasonality(day) × planted_mult[sku] × (1 + noise(rng))`, rounded to integer units sold; each unit-batch becomes one `sales_history` row group sharing an `order_ref`. Determinism guards: no `Date.now()` anywhere in the generator (everything derives from `sim_time_anchor`), one PRNG instance sequenced in fixed iteration order, and a vitest snapshot of `SUM(line_total_paise)` + row count catches accidental drift.

Planted signals the campaign agent must find: `planted_mult` = 0.25 for `PSTRY-BSC` and `JAR-GAN-200` (underselling vs category peers in `sku_daily_stats.trend_delta_bp`); `MITHAI-DIW-250` demand collapses over the last 10 days while 30 units sit against an expiry 4 days out (`days_of_cover` explodes, `expiry_risk_days` shrinks); candle attach probability 0.35 on truffle/red-velvet orders produces genuine `attach_rates` rows (lift ≈ 3–4) for the Evidence Pack; a fixed-date festival spike on Aug 15 lifts gift-box categories. Two `agent_identities`: `demo-buyer-polite` (BUYER) and `demo-buyer-adversarial` (BUYER), plus INTERNAL identities for internal agent calls — each with a raw key shown once, `key_hash` stored. Initial `merchant_rules` v1: `max_cart_value_paise=150000`, `max_discount_pct=15`, `margin_floor_bp=3000`, `require_approval_above_paise=120000`, an escalation band `[100000,120000)`, and velocity `BUYER ≤ 5/hour`.

---

## 11. Edge cases and test matrices

### Edge-case register (data-model-specific)

1. `pg` returns `bigint` as string → single `parsePaise()` chokepoint; lint forbids `Number(col.endsWith('_paise'))`.
2. Floats smuggled into audited payloads → `canonicalJson` throws (test: percentage 12.5 must arrive as `1250` bp).
3. Concurrent audits on one tx → advisory-lock serialization; `seq` strictly monotonic, no fork (trigger re-checks head under lock).
4. Empty-table bootstrap → first real row must chain from genesis (guard handles the `COUNT=0` branch).
5. Duplicate webhook deliveries → `event_id UNIQUE` + `ON CONFLICT DO NOTHING`; duplicate gets `200` instantly (retry policy verified: 24 h backoff otherwise).
6. Out-of-order webhooks → settlement keys off its own `razorpay_order_id` + event type; never arrival order (ordering not guaranteed, verified).
7. Unparseable webhook body → row persists with `payload NULL`, `processing_state INVALID_SIGNATURE`/`RECEIVED`, `raw_body` retained for forensics.
8. Secret rotation mid-demo → old-secret events fail verification; `signature_verified=false` + `verification_error` records it; nothing settles.
9. TTL expiry racing settlement → convert path re-`SELECT … FOR UPDATE` on the reservation; `EXPIRED` ⇒ fail-closed ABANDON + explainer event, never a phantom shipment.
10. Oversubscribed stock → conditional decrement returns zero rows; whole reservation txn rolls back; audit shows attempted `STOCK_RESERVED` only on success (failure lands as a tx `FAILED` event).
11. Approval mutation attempt → composite FK `(proposal_id, approved_proposal_hash)` rejects mismatched hash at insert; settlement double-checks before executing.
12. Expired pending approvals → inbox sweeper flips to `EXPIRED` (allowed by `ar_pending_shape`), tx → `ABANDONED`, audit narrates.
13. Rules changed mid-flight → decision stores `rules_version`+`rules_checksum`; replay compares checksum vs the version row and flags drift in `derived.gatekeeper`.
14. Campaign agent down → newest `ACTIVE` priority set persists (partial unique index guarantees at most one); injection event cites its id.
15. Sim-clock confusion → audit `created_at` is always real time; only analytics honor the anchor; `stat_date` buckets IST.
16. Non-v7 tx id sneaking in → optional `is_uuid_v7(tx_id)` check on `transactions` rejects it at insert.
17. `audit_event_type` SQL enum drifting from `AuditEventTypeZ` → consistency test fails CI (matrix F).
18. Chain verifier hitting the genesis row when called with `fromSeq=1` → special-cased; `trustedPrefixHead` mode skips it by design.

### Test matrices (vitest; gatekeeper suite lives elsewhere — these are the data-model suites)

**A. Hash-chain integrity**

| # | Scenario | Action | Expected |
|---|---|---|---|
| A1 | Clean chain | seed 200 events, verify | `ok=true`, `head_hash` stable |
| A2 | Payload byte flipped (as migrator role) | `UPDATE payload` at seq k | `HASH_MISMATCH@k` + `LINK_BREAK@k+1…`, `ok=false` |
| A3 | Row deleted | DELETE at seq k | `SEQ_GAP` + `LINK_BREAK@k+1` |
| A4 | Fork attempt | INSERT row claiming stale prev | trigger raises `chain fork/gap` |
| A5 | Genesis corrupted | edit genesis payload | `GENESIS_INVALID` |
| A6 | Incremental verify | verify suffix w/ `trustedPrefixHead` | suffix-only scan, `ok=true` |
| A7 | Whole-tail rewrite | attacker recomputes k…end | locally `ok=true`; caught only by head-anchor comparison (documented limitation test) |
| A8 | Concurrent appends ×20 | `Promise.all(appendAudit…)` | 20 rows, dense seq, single chain verifies |

**B. Canonical JSON**

| # | Scenario | Expected |
|---|---|---|
| B1 | Key ordering | `{b:1,a:2}` → `{"a":2,"b":1}` |
| B2 | Nested + arrays | recursive sort, array order preserved |
| B3 | Unicode keys | astral-char key sorts by code point (differs from naive JS sort — regression test) |
| B4 | Float rejection | `0.1` throws; `1250` bp fine |
| B5 | Round-trip | `JSON.parse(canonicalJson(x))` deep-equals `x` |
| B6 | Known-answer vector | fixed payload → pinned 64-hex hash (catches algorithm drift) |
| B7 | Cross-check vs DB trigger | app hash equals what linkage guard accepted |

**C. Immutability & grants (connect as `growth_app`)**

| # | Scenario | Expected |
|---|---|---|
| C1/C2/C3 | `UPDATE` / `DELETE` / `TRUNCATE audit_log` | permission denied (grants) |
| C4 | Same ops as `growth_migrator` | triggers raise `append-only` |
| C5 | `growth_readonly` INSERT anywhere | permission denied |
| C6 | `growth_app` DELETE on any table | denied (no DELETE granted anywhere) |
| C7 | Default privileges | newly created table grants match matrix (§8) |

**D. Webhooks**

| # | Scenario | Expected |
|---|---|---|
| D1 | Fresh valid event | row `signature_verified=true`, state advances |
| D2 | Bad signature | `INVALID_SIGNATURE`, **no** downstream mutation, audit event emitted |
| D3 | Duplicate `x-razorpay-event-id` | `ON CONFLICT` no-op, immediate `200`, no second side effect |
| D4 | Tampered raw body, valid sig for original | verification fails (HMAC over raw body) |
| D5 | Out-of-order captured-before-paid | settlement waits; late `order.paid` reconciles cleanly |
| D6 | Mock-provider signed webhook | passes the SAME verification code path (dual-mode invariant) |

**E. Reservations & TTL**

| # | Scenario | Expected |
|---|---|---|
| E1 | Sufficient stock | decrement, `ACTIVE`, audit `STOCK_RESERVED` |
| E2 | Insufficient (any line) | whole txn rollback, stock unchanged |
| E3 | Concurrent reservations racing last unit | exactly one wins (conditional UPDATE) |
| E4 | Sweeper past TTL | `EXPIRED`, stock restored, audit `STOCK_RESERVATION_EXPIRED` |
| E5 | Convert on APPROVE | `CONVERTED` + order linked |
| E6 | Second ACTIVE reservation same tx | partial unique index rejects |

**F. Migrations, seeds, replay**

| # | Scenario | Expected |
|---|---|---|
| F1 | migrate up from scratch on clean DB | all objects; genesis row self-verifies |
| F2 | migrate down/up cycle | lossless (dev-only paths guarded) |
| F3 | Seed determinism | two runs, same seed ⇒ identical row count + `SUM(line_total_paise)` snapshot |
| F4 | Planted patterns present | BSC/GAN velocities bottom-quartile; mithai `expiry_risk_days ≤ 5` w/ 30 stock; candle attach lift > 2 |
| F5 | Enum↔zod consistency | SQL enum labels == `AuditEventTypeZ`/other zod enums |
| F6 | Trust-rule schema lint | `catalog_enriched` has no `/price|cost|margin|stock|qty/i` column |
| F7 | Replay = audit-only | endpoint's DB session touches only `audit_log` (repo-seam assertion) |
| F8 | Replay on adversarial tx | `derived.gatekeeper.outcome=DECLINE_WITH_REASON`, failed rule `MAX_DISCOUNT_PCT`, narrative present |
| F9 | Replay after tamper (A2) | `chain_integrity.status=BROKEN`, first bad seq surfaced |
| F10 | SSE resume | disconnect mid-tx, reconnect with `Last-Event-ID` → zero gaps/dups vs audit rows |

---

## 12. Verified vs. unverified external facts

**Verified against Razorpay official docs (fetched 2026-08-25):**
- Order entity: `id` (`order_…` string), `entity`=`"order"`, `amount` integer in smallest currency sub-unit (₹299 → `29900`), `amount_paid`, `amount_due`, `currency` ISO-3 (`INR`), `receipt` **max 40 chars and unique**, `status` ∈ {`created`, `attempted`, `paid`} with documented transitions, `attempts` integer, `notes` JSON object (**max 15 key-value pairs, 256 chars each**), `created_at` Unix epoch integer. *(https://razorpay.com/docs/api/orders/entity/)* → drove `orders.receipt` (=36-char UUID fits), `amount_paise bigint`, `attempts`, `notes` shape, status mapping + `provider_status` hedge.
- Webhooks: signature in **`X-Razorpay-Signature`** header = `HMAC-SHA256(webhook_secret, raw_request_body)`; docs warn "**Do not parse or cast the webhook request body**" before verifying; dedupe via **`x-razorpay-event-id`** header, unique per event; **at-least-once** delivery, exponential-backoff retries for **24 h**, webhook disabled after 24 h of failures, respond quickly (≤5 s treated as accepted); **event order not guaranteed**. Event names observed verbatim: `payment.authorized`, `payment.failed`, `order.paid` (+ `payment.captured` referenced). *(https://razorpay.com/docs/webhooks/validate-test/, /docs/webhooks/best-practices/, /docs/webhooks/)* → drove `webhook_events` design (header-sourced `event_id UNIQUE`, `raw_body` retention, dedupe-on-insert, out-of-order-safe settlement).

**Not verified (flagged honestly):**
- Exact webhook **body** top-level shape (`event`, `contains`, `payload.payment.entity` nesting, `account_id`, `created_at`) — the fetched pages didn't include the payload schema; the adapter therefore treats bodies as opaque `jsonb` and reads defensively.
- Presence of `offer_id` on the Order entity (not shown on the fetched entity page).
- Create-order request parameters beyond `amount`/`currency`/`receipt`/`notes` (the `/docs/api/orders/create` sub-page wasn't retrievable).
- Any Razorpay order status beyond the three documented values (hence `provider_status`).
- AP2/ACP artifact specifics were not fetched; `agent_identities` + `approval_requests` are this system's own correlation model, not claimed to be AP2-compliant.

**Claude API wire facts** (bundled claude-api reference, cached 2026-06): model id `claude-opus-5`; `temperature`/`top_p`/`top_k` and `thinking.budget_tokens` removed (HTTP 400 if sent); `thinking:{type:"adaptive"}`; `usage` fields `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`; `stop_reason` ∈ {`end_turn`,`max_tokens`,`tool_use`,`pause_turn`,`refusal`} with `stop_details` populated only on refusal; typed `Anthropic.APIError` subclasses — all reflected in the `llm_calls` columns and the stable-mode wrapper.