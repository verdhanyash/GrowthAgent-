# GrowthAgent — Subsystem Design: campaign-orchestrator-agent

Meera's Cakes · AI Growth & Agentic Commerce track · Design date 2026-08-25
Scope of this document: **only** the campaign-orchestrator-agent subsystem (analytics → opportunities → PrioritySet → injection → scheduling → audit → tests). Interfaces to sibling subsystems (negotiation Evidence Pack, audit log, simulation clock, seed) are specified as contracts but their internals belong to their own sections.

---

## 1. Position and trust posture

```
                       ┌──────────────────────────── OFFLINE LOOP (async) ───────────────────────────┐
 trigger: seed done ──► │                                                                             │
 trigger: timer N h ──► │  [single-flight lock]                                                       │
 trigger: POST refresh ►│      │                                                                      │
                        │      ▼                                                                      │
                        │  AnalyticsService (deterministic SQL over Postgres, as_of = sim clock)      │
                        │      │  underselling · expiry-risk · attach-rates · weekday/occasion        │
                        │      ▼                                                                      │
                        │  Opportunities[]  (typed metrics, deterministic ids, deterministic weights) │
                        │      │                                                                      │
                        │      ▼                                                                      │
                        │  RationalePort (claude-opus-5, structured output)  ◄── DEMO_STABLE_MODE     │
                        │      │   writes ONLY rationale_nl per entry                                 │
                        │      ▼                                                                      │
                        │  RationaleVerifier (deterministic: quotes-must-match, no invented numbers)  │
                        │      │            fail → deterministic template rationale                   │
                        │      ▼                                                                      │
                        │  assemble PrioritySet → persist → atomic current-pointer swap               │
                        │      │                                                                      │
                        └──────┼──────────────────────────────────────────────────────────────────────┘
                               │ append-only hash-chained audit_log (correlation_id = run_id)
                               │ SSE: campaign.priority_set.published
                               ▼
                    priority_sets.current  ──snapshot-at-tx-open──►  Evidence Pack section
                                                                     CAMPAIGN_PRIORITY (advisory)
                                                                     ↓
                                              negotiation-upsell-agent (cites EP-CAMP-*)
                                                                     ↓
                          GATEKEEPER  ◄── NEVER reads anything from this subsystem
```

Trust-boundary statements this design is accountable for (rows for ARCHITECTURE.md threat-model table):

| # | Threat | Boundary response |
|---|--------|-------------------|
| TB-C1 | Poisoned/manipulated PrioritySet tries to obtain discounts | Gatekeeper inputs are strictly `(proposedCart, merchantRules, agentIdentityHistory)`; campaign data is absent from all three. Worst case of a poisoned set is bad advice upstream, still bounded by margin floor / max-discount / max-cart-value. |
| TB-C2 | LLM invents metrics ("this item sells 3x more on Sundays!") | Rationales verified against the exact canonical metric strings the LLM was given; any unmatched number ⇒ entry replaced by a deterministic template built from the metrics. The LLM structurally cannot alter actions/SKUs/weights (see §7.2 — it only emits rationales keyed by entry index). |
| TB-C3 | Stale campaign set silently steers negotiation | Freshness computed at pack-build; STALE tagged in-band; HARD_EXPIRED omitted. Gatekeeper indifferent either way. |
| TB-C4 | Enrichment leakage (catalog-intelligence-agent descriptions) becoming pricing authority | Analytics read only merchant raw columns (`cost_paise`, `list_price_paise`, `stock_units`, `expires_on`, raw `category`). Enriched text columns are read solely for `tags`/`occasions` used in TIMING demand grouping and never feed money-relevant metrics. |
| TB-C5 | Concurrent refresh mutates an in-flight transaction's context | Pipeline snapshots the current set once at transaction open; refresh swaps a pointer; in-flight packs are immutable. |

This subsystem makes **no Razorpay API calls** and defines no Razorpay contracts (that is settlement-agent's exclusive surface). No AP2/ACP artifacts originate here.

---

## 2. Module layout (npm workspaces)

```
packages/shared/src/campaign/
  config.ts                 # CAMPAIGN_CONFIG (single source, imported by api + web)
  schema.ts                 # Metric, Opportunity, PriorityEntry, PrioritySet zod schemas
  audit-events.ts           # campaign audit event payload types

api/src/campaign/
  analytics/sql.ts                  # parameterized SQL string constants
  analytics/analytics.service.ts    # runs queries, builds Opportunities[]
  analytics/format.ts               # canonical display formatters (fmtRatio, fmtPct, ...)
  domain/derive.ts                  # action map, weight functions, ids, dedupe/assembly
  llm/rationale.port.ts             # RationalePort interface + failure classification
  llm/live-claude.rationale.ts      # claude-opus-5 via client.messages.parse()
  llm/replay.rationale.ts           # DEMO_STABLE_MODE record/replay
  llm/prompts.ts                    # frozen system prompt + volatile user payload builder
  verify/rationale-verifier.ts      # deterministic verification
  verify/template-rationales.ts     # fallback template builders
  scheduler/campaign.cycle.ts       # runCampaignCycle() orchestration
  scheduler/lock.ts                 # Redis single-flight (+ Postgres advisory fallback)
  http/campaign.routes.ts           # refresh/status/current endpoints
  campaign.module.ts                # wiring, timers
```

Dependencies point inward: `scheduler → domain → analytics → sql`; `llm/*` and `verify/*` depend only on `domain` + `shared`. Nothing in `api/src/campaign` imports the settlement or gatekeeper modules (enforced by an eslint `no-restricted-imports` rule — cheap structural guarantee of TB-C1).

---

## 3. Input contracts

### 3.1 Tables read (owned by seed/shared migrations)

```sql
CREATE TABLE catalog (
  sku              TEXT PRIMARY KEY,
  name             TEXT NOT NULL,                 -- merchant raw name (may be messy)
  category         TEXT NOT NULL,                 -- merchant raw category, e.g. 'CAKES'
  tags             TEXT[] NOT NULL DEFAULT '{}',  -- enriched (catalog-intelligence-agent)
  occasions        TEXT[] NOT NULL DEFAULT '{}',  -- enriched, e.g. '{birthday,festive}'
  cost_paise       INTEGER NOT NULL CHECK (cost_paise > 0),
  list_price_paise INTEGER NOT NULL CHECK (list_price_paise > cost_paise),
  stock_units      INTEGER NOT NULL CHECK (stock_units >= 0),
  expires_on       DATE,                          -- NULL = non-perishable
  created_at       TIMESTAMPTZ NOT NULL
);

CREATE TABLE sales_history (
  sale_id          TEXT NOT NULL,                 -- basket/order identity (attach mining key)
  line_no          INTEGER NOT NULL,
  sku              TEXT NOT NULL REFERENCES catalog(sku),
  units            INTEGER NOT NULL CHECK (units > 0),
  unit_price_paise INTEGER NOT NULL,              -- as sold (integer paise)
  sold_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (sale_id, line_no)
);
CREATE INDEX idx_sales_sku_time  ON sales_history (sku, sold_at);
CREATE INDEX idx_sales_sold_at   ON sales_history (sold_at);
```

Notes:
- `sale_id` groups lines bought together; attach-rate mining depends on it. Seed must synthesize realistic multi-line baskets (it already plants attach patterns for demo beat 1).
- Comparability helper (immutable, deterministic):

```sql
CREATE FUNCTION price_band(list_price_paise INTEGER) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN list_price_paise <  30000 THEN 'low'      -- < ₹300
              WHEN list_price_paise <  80000 THEN 'mid'      -- ₹300–₹799
              ELSE 'high' END;                               -- ≥ ₹800
$$;
```

### 3.2 Simulation clock contract

```ts
// packages/shared/src/sim-clock.ts (owned elsewhere; consumed here)
export interface SimulationClock {
  /** Synthetic "now". Synthetic history always ends "yesterday" relative to this. */
  simNow(): Date;                 // e.g. 2026-08-24T23:59:59+05:30 at seed anchor
  simTodayIso(): string;          // "2026-08-24"
}
```

Hard rule: **every** campaign SQL takes `:as_of` (and derived window bounds) as a bound parameter. `now()`, `CURRENT_DATE`, `CURRENT_TIMESTAMP` are banned in `analytics/sql.ts`; a vitest guard greps the file for those tokens and fails CI if present. Consequence: analytics output is invariant to real wall-clock date — the demo behaves identically on stage day.

---

## 4. Configuration

```ts
// packages/shared/src/campaign/config.ts
export const CAMPAIGN_CONFIG = {
  // -- underselling
  velocityWindowDays: 28,       // trailing window for units/day
  minHistoryDays: 14,           // SKUs newer than this are excluded (launch ramp noise)
  minPeersPerGroup: 3,          // category+band group must have >= this many SKUs for a peer median
  undersellRatioMax: 0.5,       // flag when units_per_day / peer_median < this (STRICTLY less)
  coverWeeksMin: 4,             // worth promoting only if stock cover >= this many weeks
  coverWeeksSentinel: 999,      // cover value when units_per_day == 0

  // -- expiry risk
  expiryHorizonDays: 7,         // expires_on within [as_of, as_of + horizon]
  expiryVelocityWindowDays: 14, // shorter window: recent velocity is what burns stock

  // -- attach mining
  attachWindowDays: 60,
  attachMinCoCount: 5,          // absolute co-occurrence floor
  attachMinSupport: 0.03,       // co_count / total_baskets
  attachMinConfidence: 0.15,    // co_count / baskets_with_anchor_sku
  attachMaxPairs: 10,

  // -- timing
  patternWindowDays: 84,        // 12 whole weeks
  timingMinLift: 1.8,
  timingMinCellUnits: 20,       // (occasion,dow) cell must have >= this many units

  // -- set lifecycle
  maxEntriesPerSet: 8,
  prioritySetTtlSeconds: 6 * 3600,     // FRESH window
  hardExpirySeconds: 48 * 3600,        // past this, section omitted entirely
  refreshIntervalHours: 6,

  // -- scheduling / locking
  lockTtlMs: 5 * 60_000,

  // -- LLM
  rationaleModel: 'claude-opus-5' as const,
  rationaleMaxTokens: 4096,
  rationaleTimeoutMs: 30_000,
} as const;
```

---

## 5. Analytics layer

All four detectors are pure functions of `(database state, params, as_of)`. Every query ends in a deterministic `ORDER BY ... , sku ASC` before any `LIMIT`.

### 5.1 Underselling detection

Definition: `units_per_day = SUM(units) in trailing W days / W` (calendar-day denominator — zero-sale days count against you). Peer median is taken over `category × price_band`. Flag when `ratio < undersellRatioMax` **and** `weeks_of_stock_cover >= coverWeeksMin` (don't spend campaign attention on items that will sell out anyway).

```sql
-- :as_of timestamptz (sim clock)   :window_days int   :min_history_days int
-- :undersell_ratio_max numeric     :cover_weeks_min numeric
WITH win AS (
  SELECT (:as_of - make_interval(days => :window_days)) AS win_start, :as_of AS win_end
),
per_sku AS (
  SELECT
    c.sku,
    c.category,
    price_band(c.list_price_paise) AS band,
    c.stock_units,
    EXTRACT(EPOCH FROM (:as_of - c.created_at)) / 86400.0 AS age_days,
    COALESCE(SUM(s.units) FILTER (WHERE s.sold_at >= win.win_start
                              AND s.sold_at <  win.win_end), 0)::numeric AS units_win,
    COALESCE(COUNT(DISTINCT s.sale_id) FILTER (WHERE s.sold_at >= win.win_start
                                           AND s.sold_at <  win.win_end), 0) AS orders_win
  FROM catalog c
  LEFT JOIN sales_history s ON s.sku = c.sku
  CROSS JOIN win
  GROUP BY c.sku, c.category, price_band(c.list_price_paise), c.stock_units, c.created_at
),
peer_median AS (
  SELECT category, band,
         COUNT(*) AS peer_count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY units_win / :window_days) AS peer_upd
  FROM per_sku
  WHERE age_days >= :min_history_days
  GROUP BY category, band
),
peer_median_category AS (          -- fallback when band-group is too small
  SELECT category,
         COUNT(*) AS peer_count_cat,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY units_win / :window_days) AS peer_upd_cat
  FROM per_sku
  WHERE age_days >= :min_history_days
  GROUP BY category
),
scored AS (
  SELECT
    p.sku,
    p.category,
    p.units_win / :window_days                                        AS units_per_day,
    p.orders_win,
    CASE WHEN pm.peer_count >= :min_peers_per_group THEN pm.peer_upd ELSE pmc.peer_upd_cat END AS peer_units_per_day,
    CASE WHEN pm.peer_count >= :min_peers_per_group THEN pm.peer_upd ELSE pmc.peer_upd_cat END
      IS NOT NULL
    AND (p.units_win / :window_days)
      / NULLIF(CASE WHEN pm.peer_count >= :min_peers_per_group THEN pm.peer_upd ELSE pmc.peer_upd_cat END, 0)
      < :undersell_ratio_max                                          AS is_underselling_raw,
    CASE
      WHEN (p.units_win / :window_days) > 0
      THEN LEAST(p.stock_units / ((p.units_win / :window_days) * 7.0), 999)
      ELSE 999
    END                                                               AS weeks_of_stock_cover
  FROM per_sku p
  JOIN peer_median pm       USING (category, band)
  JOIN peer_median_category pmc USING (category)
  WHERE p.age_days >= :min_history_days
)
SELECT sku, category, units_per_day, orders_win, peer_units_per_day, weeks_of_stock_cover
FROM scored
WHERE is_underselling_raw
  AND weeks_of_stock_cover >= :cover_weeks_min
ORDER BY units_per_day ASC, sku ASC;
```

Edge cases handled:
- **Zero-sale SKU**: `units_per_day = 0` → ratio `0` (flagged, strongest signal), cover hits the `999` sentinel so the weight function's cover term saturates.
- **Singleton / tiny peer group**: falls back to category-level median; if even the category is a singleton, `peer_upd = units_per_day` ⇒ ratio `1` ⇒ never flagged (correctly: nothing comparable exists).
- **Young SKU**: excluded by `age_days >= min_history_days` in both scorer and peer pool (so a new slow starter doesn't drag the median).
- **Boundary**: `ratio == 0.50` exactly is **not** flagged (`<` not `<=`) — pinned by a fixture test.
- **Division safety**: `NULLIF(..., 0)` guards zero medians; `LEAST(..., 999)` caps runaway cover.

### 5.2 Expiry risk

Flag perishables whose stock exceeds expected sell-through by expiry, inside the horizon.

```sql
-- :as_of timestamptz  :horizon_days int  :velocity_window_days int
WITH candidates AS (
  SELECT c.sku, c.name, c.category, c.stock_units, c.expires_on,
         (c.expires_on - (:as_at)::date) AS days_to_expiry          -- integer days in PG
  FROM catalog c
  WHERE c.expires_on IS NOT NULL
    AND c.expires_on >= (:as_at)::date
    AND c.expires_on <  ((:as_at)::date + :horizon_days)
),
velocity AS (
  SELECT s.sku, SUM(s.units)::numeric / :velocity_window_days AS upd
  FROM sales_history s
  CROSS JOIN (SELECT (:as_at - make_interval(days => :velocity_window_days)) AS ws) w
  WHERE s.sold_at >= w.ws AND s.sold_at < :as_at
  GROUP BY s.sku
)
SELECT c.sku, c.days_to_expiry, c.stock_units,
       COALESCE(v.upd, 0)                                   AS units_per_day,
       ROUND(COALESCE(v.upd,0) * c.days_to_expiry, 2)       AS expected_sell_through,
       c.stock_units - FLOOR(COALESCE(v.upd,0) * c.days_to_expiry) AS projected_surplus_units
FROM candidates c
LEFT JOIN velocity v USING (sku)
WHERE c.stock_units > COALESCE(v.upd, 0) * c.days_to_expiry      -- strict: will NOT sell through
ORDER BY projected_surplus_units DESC, c.expires_on ASC, c.sku ASC;
```

(Shown with `:as_at` aliasing `:as_of` purely for line-width; the real file uses one name.)

Edge cases:
- **Already expired** (`expires_on < as_of::date`): excluded here — it is a markdown/write-off decision for the human, not a bundling opportunity. Surfaced once in the run stats (`expired_skus_count`) for the explainer.
- **Expires today** (`days_to_expiry = 0`): `expected_sell_through = 0` ⇒ entire stock is surplus ⇒ maximum urgency; the weight formula's urgency term saturates at `1`.
- **No sales history at all**: `upd = 0` ⇒ everything is surplus ⇒ flagged with high weight (defensible: unknown-velocity perishable near expiry is exactly what CLEAR_NEAR_EXPIRY is for).
- **Will just barely sell through**: strict `>` excludes it; boundary pinned by fixture.

### 5.3 Attach-rate mining (pair co-occurrence)

Classic association rules restricted to size-2 itemsets. Support uses **all baskets** in the window as denominator; confidence is directional from the anchor SKU.

```sql
-- :as_of timestamptz  :attach_window_days int  :min_co_count int
-- :min_support numeric  :min_confidence numeric  :max_pairs int
WITH window_bounds AS (
  SELECT (:as_of - make_interval(days => :attach_window_days)) AS ws, :as_of AS we
),
pairs AS (
  SELECT a.sku AS sku_a, b.sku AS sku_b
  FROM sales_history a
  JOIN sales_history b
    ON b.sale_id = a.sale_id AND b.line_no > a.line_no   -- each unordered pair once
  CROSS JOIN window_bounds wb
  WHERE a.sold_at >= wb.ws AND a.sold_at < wb.we
    AND b.sold_at >= wb.ws AND b.sold_at < wb.we
    AND a.sku <> b.sku
),
pair_counts AS (
  SELECT sku_a, sku_b, COUNT(*) AS co_count
  FROM pairs GROUP BY sku_a, sku_b
),
totals AS (
  SELECT
    (SELECT COUNT(DISTINCT sale_id) FROM sales_history
      WHERE sold_at >= (SELECT ws FROM window_bounds)
        AND sold_at <  (SELECT we FROM window_bounds)) AS total_baskets
),
sku_baskets AS (
  SELECT sku, COUNT(DISTINCT sale_id) AS baskets_with_sku
  FROM sales_history
  WHERE sold_at >= (SELECT ws FROM window_bounds)
    AND sold_at <  (SELECT we FROM window_bounds)
  GROUP BY sku
)
SELECT q.*
FROM (
  SELECT pc.sku_a, pc.sku_b, pc.co_count, t.total_baskets,
         sb_a.baskets_with_sku AS baskets_with_a,
         sb_b.baskets_with_sku AS baskets_with_b,
         pc.co_count::numeric / t.total_backets_placeholder      -- see note
  FROM pair_counts pc
) dummy
```

The nesting above is deliberately collapsed in the real file to avoid the Postgres restriction that `HAVING`/`WHERE` cannot reference output aliases; the shipped form is:

```sql
SELECT
  pc.sku_a, pc.sku_b, pc.co_count,
  t.total_baskets,
  pc.co_count::numeric / t.total_baskets                       AS support,
  pc.co_count::numeric / sba.baskets_with_sku                  AS confidence_a_to_b,
  pc.co_count::numeric / sbb.baskets_with_sku                  AS confidence_b_to_a
FROM pair_counts pc
CROSS JOIN totals t
JOIN sku_baskets sba ON sba.sku = pc.sku_a
JOIN sku_baskets sbb ON sbb.sku = pc.sku_b
WHERE pc.co_count >= :min_co_count
  AND pc.co_count::numeric / t.total_baskets   >= :min_support
  AND GREATEST(pc.co_count::numeric / sba.baskets_with_sku,
               pc.co_count::numeric / sbb.baskets_with_sku) >= :min_confidence
ORDER BY confidence_a_to_b DESC, co_count DESC, sku_a ASC, sku_b ASC
LIMIT :max_pairs;
```

Correctness notes:
- `b.line_no > a.line_no` yields each unordered basket pair exactly once; `a.sku <> b.sku` excludes self-pairs; multi-unit lines don't inflate counts because pairs are per-line, not per-unit (documented choice: quantity-insensitive co-occurrence).
- Denominator choices are stated in ARCHITECTURE.md: support over all baskets (including single-item), confidence directional. The `confidence_b_to_a` column rides along so the negotiator can pitch the pair from whichever direction the buyer entered.
- Determinism: full deterministic sort before `LIMIT`, so truncation is reproducible.

### 5.4 Weekday / occasion demand patterns (feeds TIMING)

Two result sets: (a) plain day-of-week curve (also consumed by the negotiation Evidence Pack's general demand section), (b) occasion × dow lift versus an independence baseline.

```sql
-- (a) dow curve
SELECT EXTRACT(ISODOW FROM sold_at AT TIME ZONE 'Asia/Kolkata')::int AS dow,  -- 1=Mon .. 7=Sun
       SUM(units) AS units, COUNT(DISTINCT sale_id) AS baskets
FROM sales_history
WHERE sold_at >= :as_of - make_interval(days => :pattern_window_days)
  AND sold_at <  :as_of
GROUP BY 1 ORDER BY 1;
```

```sql
-- (b) occasion × dow lift
WITH base AS (
  SELECT l.sku, l.units,
         EXTRACT(ISODOW FROM l.sold_at AT TIME ZONE 'Asia/Kolkata')::int AS dow
  FROM sales_history l
  WHERE l.sold_at >= :as_of - make_interval(days => :pattern_window_days)
    AND l.sold_at <  :as_of
),
cells AS (
  SELECT o.occ, b.dow, SUM(b.units) AS units
  FROM base b CROSS JOIN LATERAL unnest(c.occasions) AS o(occ)
  JOIN catalog c ON c.sku = b.sku
  GROUP BY o.occ, b.dow
),
grand AS (SELECT SUM(units) AS total FROM base),
occ_totals AS (SELECT o.occ, SUM(c.units) AS units FROM cells c ... ),
```

shipped form:

```sql
WITH base AS (...),
cells AS (SELECT occ, dow, SUM(units) AS units FROM ... GROUP BY occ, dow),
occ_total AS (SELECT occ, SUM(units) AS u FROM cells GROUP BY occ),
dow_total AS (SELECT dow, SUM(units) AS u FROM cells GROUP BY dow),
grand     AS (SELECT SUM(u) AS total FROM occ_total)
SELECT c.occ, c.dow, c.units,
       g.total,
       ot.u AS occ_units, dt.u AS dow_units,
       ROUND(g.total * (ot.u::numeric / g.total) * (dt.u::numeric / g.total), 2) AS expected_units,
       ROUND(c.units::numeric /
             NULLIF(g.total * (ot.u::numeric / g.total) * (dt.u::numeric / g.total), 0), 4) AS lift
FROM cells c
JOIN occ_total ot USING (occ)
JOIN dow_total dt USING (dow)
CROSS JOIN grand g
WHERE c.units >= :timing_min_cell_units
ORDER BY lift DESC NULLS LAST, c.occ ASC, c.dow ASC;
```

TIMING opportunity emitted when `lift >= timingMinLift` (and cell volume floor met). All timestamps bucketed in `Asia/Kolkata` — Indian merchant, Indian buyers; pinned by fixture (a sale at `2026-08-23T19:00Z` is a **Sunday** row, since that is Monday 00:30 IST... correction used by tests: it is **Mon 00:30 IST**, i.e. dow=1 — the fixture asserts the IST conversion explicitly both directions).

### 5.5 Dataset fingerprint (run identity)

```sql
SELECT md5(concat_ws('|',
  (SELECT COUNT(*)                    FROM sales_history),
  (SELECT COALESCE(SUM(units),0)      FROM sales_history),
  (SELECT COALESCE(MAX(line_no),0)    FROM sales_history),
  (SELECT COUNT(*)                    FROM catalog),
  (SELECT COALESCE(SUM(stock_units::bigint),0) FROM catalog),
  (SELECT COUNT(expires_on)           FROM catalog)
)) AS fingerprint;
```

`analytics_run_id = 'ar_' || to_char(:as_of,'YYYYMMDD') || '_' || left(fingerprint, 8)`. Same data + same sim-date ⇒ same run id ⇒ same opportunity ids (§6.2). Any inserted/changed sale or stock movement ⇒ new fingerprint ⇒ fresh ids (audit-friendly, replay-safe).

### 5.6 Empty-analytics rule

If the fingerprint shows zero sales rows in **any** detector's window, the cycle short-circuits after the fingerprint query: it publishes a valid `PrioritySet` with `status: 'EMPTY'`, `entries: []` (see §9). This is a *published, auditable empty*, not an absence — downstream injection renders "no active campaigns", and the demo can narrate it.

---

## 6. Domain schemas and deterministic derivation

### 6.1 Canonical metric formatting (single source of truth)

The **display string** is the canonical form of every metric: it is what goes into the LLM prompt, what the verifier checks for, and what the frontend renders. One formatter, used everywhere — the verifier never recomputes numbers from raw values.

```ts
// api/src/campaign/analytics/format.ts
export const fmtRatio = (x: number): string => `${x.toFixed(2)}x`;          // "0.46x"
export const fmtPct   = (x: number): string => `${(x * 100).toFixed(1)}%`;  // "15.0%"
export const fmtUnits = (n: number): string => `${Math.round(n)} units`;    // "13 units"
export const fmtPaise = (p: number): string =>
  `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; // "₹650.00"
export const fmtDays  = (n: number): string => `${Math.round(n)} days`;
export const fmtWeeks = (n: number): string => `${n.toFixed(1)} weeks`;     // "18.5 weeks"
export const fmtDate  = (iso: string): string => iso.slice(0, 10);          // "2026-08-29"
export const fmtInt   = (n: number): string => Math.round(n).toString();    // "200"
```

Rounding policy: internal math at full `numeric` precision; values are rounded **once** at emission, inside the formatter. Weights are computed from unrounded metrics and rounded to 2 dp at the very end. Pinned by a unit test that asserts `weight(round(metrics)) !== round(weight(unrounded))` divergence cases are avoided (i.e., documents the chosen order).

### 6.2 Zod schemas (verbatim, `packages/shared/src/campaign/schema.ts`)

```ts
import { z } from "zod";

export const OpportunityType = z.enum(["UNDERSELLING", "EXPIRY_RISK", "ATTACH_BUNDLE", "TIMING"]);
export type OpportunityType = z.infer<typeof OpportunityType>;

export const MetricSchema = z.object({
  key:     z.string(),   // stable identifier, e.g. "velocity_ratio"
  label:   z.string(),   // human label, e.g. "Velocity vs category-peer median"
  value:   z.number(),   // raw numeric (full precision as emitted)
  display: z.string(),   // canonical formatted string — THE auditable token
}).strict();
export type Metric = z.infer<typeof MetricSchema>;

export const OpportunitySchema = z.object({
  opportunity_id:  z.string().regex(/^opp_[a-z_]+_[0-9a-f]{10}$/),
  type:            OpportunityType,
  skus:            z.array(z.string()).min(1).max(2),
  metrics:         z.array(MetricSchema).min(2),
  weight:          z.number().min(0).max(1),
  analytics_run_id: z.string(),
  generated_at_sim: z.string(),   // ISO timestamp = as_of
}).strict();
export type Opportunity = z.infer<typeof OpportunitySchema>;
```

```ts
export const PriorityAction = z.enum([
  "PRIORITIZE_IN_BUNDLES",
  "CLEAR_NEAR_EXPIRY",
  "PROMOTE_PAIR",
]);
export type PriorityAction = z.infer<typeof PriorityAction>;

export const PriorityEntrySchema = z.object({
  entry_id:       z.string().regex(/^pe_[0-9a-f]{10}$/),
  opportunity_id: z.string(),                    // traceability back to analytics
  action:         PriorityAction,
  skus:           z.array(z.string()).min(1).max(2),
  weight:         z.number().min(0).max(1),
  rationale_nl:   z.string().min(20),
  rationale_provenance: z.enum(["VERIFIED_LLM", "TEMPLATE_FALLBACK"]),
}).strict();
export type PriorityEntry = z.infer<typeof PriorityEntrySchema>;

export const PrioritySetStatus = z.enum(["FRESH", "EMPTY", "TEMPLATE_ONLY", "PARTIAL_TEMPLATE"]);
export const PrioritySetSchema = z.object({
  set_id:               z.string().regex(/^ps_v\d+_[0-9a-f]{8}$/),
  priority_set_version: z.number().int().nonnegative(),
  analytics_run_id:     z.string().nullable(),   // null for EMPTY published without a run? never — run always exists; kept nullable for forward-compat
  status:               PrioritySetStatus,
  entries:              z.array(PriorityEntrySchema),
  generated_at_sim:     z.string(),
  ttl_seconds:          z.number().int().positive(),
  valid_until_sim:      z.string(),              // generated_at_sim + ttl
  llm_invocation: z.object({
    model: z.string(),
    request_hash: z.string(),                      // sha256 of canonical request body
    latency_ms: z.number().int().nonnegative(),
    entries_verified: z.number().int().nonnegative(),
    entries_template_fallback: z.number().int().nonnegative(),
    from_cache: z.boolean(),                       // DEMO_STABLE_MODE replay hit
  }).nullable(),
}).strict();
export type PrioritySet = z.infer<typeof PrioritySetSchema>;
```

### 6.3 Deterministic opportunity ids

```ts
import { createHash } from "node:crypto";
export const h10 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
export const opportunityId = (runId: string, type: OpportunityType, skus: string[]) =>
  `opp_${type.toLowerCase()}_${h10(`${runId}|${type}|${[...skus].sort().join("+")}`)}`;
```

Same inputs ⇒ byte-identical id. Two runs over unchanged data produce the *same* ids (idempotent republication); changed data ⇒ new fingerprint ⇒ new run id ⇒ new ids.

### 6.4 Action mapping (fixed, no LLM involvement)

| Opportunity.type | PriorityEntry.action | skus |
|---|---|---|
| `UNDERSELLING` | `PRIORITIZE_IN_BUNDLES` | `[sku]` |
| `EXPIRY_RISK` | `CLEAR_NEAR_EXPIRY` | `[sku]` |
| `ATTACH_BUNDLE` | `PROMOTE_PAIR` | `[sku_a, sku_b]` (sorted asc) |
| `TIMING` | `PRIORITIZE_IN_BUNDLES` | `[sku]` — the occasion/dow context lives in the metrics + rationale |

TIMING reuses `PRIORITIZE_IN_BUNDLES` because the action enum has exactly three members (committed); the *reason* it is timed is carried verbatim in the rationale ("lift 2.15x on Sundays for festive").

### 6.5 Weight functions (deterministic, monotone, clamped)

```ts
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function opportunityWeight(o: OpportunityInputs): number {
  switch (o.type) {
    case "UNDERSELLING": {
      const severity = 1 - Math.min(o.velocityRatio / CFG.undersellRatioMax, 1); // 1 at zero sales
      const coverTerm = clamp01((o.weeksOfStockCover - CFG.coverWeeksMin) / 8);
      return 0.6 * severity + 0.4 * coverTerm;
    }
    case "EXPIRY_RISK": {
      const surplusFraction = o.projectedSurplusUnits / o.stockUnits;
      const urgency = 1 - o.daysToExpiry / CFG.expiryHorizonDays;
      return clamp01(0.65 * clamp01(surplusFraction) + 0.35 * clamp01(urgency));
    }
    case "ATTACH_BUNDLE":
      return clamp01(
        0.5 * clamp01(o.confidence / (2 * CFG.attachMinConfidence)) +
        0.5 * clamp01(o.support / (3 * CFG.attachMinSupport))
      );
    case "TIMING":
      return clamp01((o.lift - 1) / 1.5);
  }
}
```

Properties pinned by unit tests: monotone in each driver, `clamp01` at extremes, `EXPIRY_RISK` weight ≥ ~0.65 whenever surplus fraction ≥ 1 (near-expiry always ranks competitively), `TIMING` at exactly `timingMinLift` gives `~0.53`, at threshold-boundary `UNDERSELLING` gives `coverTerm` only.

Worked example (used again in §15 fixture): SKU with `units_per_day = 13/28 = 0.4643`, `peer_median = 1.00`, `ratio = 0.4643 < 0.5` → flagged; `stock = 60` ⇒ cover `= 60/(0.4643·7) = 18.4615 weeks`; weight `= 0.6·(1 − 0.9286) + 0.4·clamp01((18.4615−4)/8) = 0.6·0.0714 + 0.4·1 = 0.4429` → **0.44**.

Expiry worked example: stock 30, `days_to_expiry = 5`, trailing-14d `upd = 0.4` ⇒ sell-through 2.0 ⇒ surplus 28 ⇒ `surplusFraction = 0.9333`, `urgency = 1 − 5/7 = 0.2857` ⇒ weight `= 0.65·0.9333 + 0.35·0.2857 = 0.7067` → **0.71**.

### 6.6 Assembly: dedupe, conflicts, ordering

```ts
// api/src/campaign/domain/assemble.ts
const TYPE_TIEBREAK: Record<OpportunityType, number> =
  { EXPIRY_RISK: 0, UNDERSELLING: 1, ATTACH_BUNDLE: 2, TIMING: 3 };

export function assembleEntries(opps: Opportunity[], cfg): { entries: EntryDraft[]; suppressed: SuppressedOpp[] } {
  const ranked = [...opps].sort((a, b) =>
    b.weight - a.weight ||
    TYPE_TIEBREAK[a.type] - TYPE_TIEBREAK[b.type] ||
    (a.opportunity_id < b.opportunity_id ? -1 : 1));          // total order, deterministic
  const owner = new Map<string, Opportunity>();
  const entries: EntryDraft[] = [];
  const suppressed: SuppressedOpp[] = [];
  for (const o of ranked) {
    if (entries.length >= cfg.maxEntriesPerSet) { suppressed.push({...o, reason: "SET_FULL"}); continue; }
    if (o.skus.some(s => owner.has(s)))         { suppressed.push({...o, reason: "SKU_ALREADY_CLAIMED"}); continue; }
    o.skus.forEach(s => owner.set(s, o));
    entries.push({
      entry_id: `pe_${h10(`${o.analytics_run_id}|${o.opportunity_id}`)}`,
      opportunity_id: o.opportunity_id,
      action: ACTION_MAP[o.type],
      skus: [...o.skus].sort(),
      weight: Number(o.weight.toFixed(2)),
      rationale_nl: "",                                       // filled by LLM-or-template stage
      rationale_provenance: "VERIFIED_LLM",                   // provisional
    });
  }
  return { entries, suppressed };
}
```

One SKU ⇒ at most one entry per set. A SKU that is both underselling and expiry-risk resolves to `CLEAR_NEAR_EXPIRY` unless the undersell weight wins outright — either way the outcome is a pure function of the data, and every suppression lands in the audit event (§12).

---

## 7. LLM step — rationale synthesis (claude-opus-5)

### 7.1 Division of authority (design decision, stated crisply)

Committed determinism clause: *"analytics are deterministic SQL; the LLM only phrases rationales."* Therefore the LLM's semantic authority in this subsystem is **zero**:

1. Which opportunities exist, their metrics, weights, ids — deterministic (§5–6).
2. Which entries exist, their actions, SKUs, weights, order — deterministic (§6.6).
3. What the LLM produces: **one natural-language sentence per entry, addressed by index**, plus nothing else.

The structured-output schema is designed so the model *cannot* mutate the decision even if it wanted to — it never receives a field to mutate:

```ts
// packages/shared/src/campaign/schema.ts (LLM-facing)
export const RationalesOutputSchema = z.object({
  rationales: z.array(z.object({
    entry_index:  z.number().int().min(0),
    rationale_nl: z.string().min(40).max(600),
  })).strict(),
}).strict();
export type RationalesOutput = z.infer<typeof RationalesOutputSchema>;
```

Deterministic code attaches each returned `rationale_nl` to `entries[entry_index]`; missing indices and out-of-range indices fall back to templates. (An earlier alternative — have the LLM echo full entries and diff-check them — was rejected as strictly weaker: echo validation catches drift, index-addressing makes drift impossible.) If product later wants genuine LLM judgment over ranking, an opt-in `llm_weight_adjustment` flag (clamped ±0.10, default off, disabled in DEMO_STABLE_MODE) is the sanctioned extension point — not implemented in v1.

### 7.2 Prompt construction and the verbatim call

Frozen system prompt (~1.2k tokens, byte-stable across runs — no dates, no data, no counters) carries the role, the audience (audit trail readers), the quoting contract, and the tone rules. Volatile payload goes last. One `cache_control` breakpoint on the system block; the volatile user turn is never cached (it changes per run).

```ts
// api/src/campaign/llm/prompts.ts
export const SYSTEM_PROMPT = `You are the campaign strategist for Meera's Cakes, a home bakery.
You receive a numbered list of campaign entries. Each entry already HAS a decision
(action, SKUs, weight) computed by deterministic analytics. Your ONLY job is to write
the human-readable rationale for the audit trail.

Rules:
1. For EVERY entry, write exactly one rationale of 1-3 sentences, plain English.
2. You MUST quote every provided metric value EXACTLY as given, including the symbol
   and unit suffix (₹, x, %, units, days, weeks). Do not round, convert, reformat,
   or derive new numbers. "0.46x" must appear as "0.46x", never "46%" or "about half".
3. Do not introduce ANY number that is not in the entry's metrics. No invented
   percentages, prices, dates, or counts.
4. State the action, name the SKUs, cite the metrics, and finish with the business
   consequence ("bundle it with...", "clear before 2026-08-29").
5. No markdown, no bullet lists, no headings, no preamble. Output only the JSON object
   the format requires.`;

export function buildUserPayload(entries: EntryDraft[], metricsByEntry: Metric[][]): string {
  // Deterministic serialization: JSON.stringify of a stable-shaped structure.
  // Entries carry NO ids the model could echo wrongly — index + facts only.
  const lines = entries.map((e, i) => ({
    entry_index: i,
    action: e.action,
    skus: e.skus,
    weight: e.weight,
    metrics: metricsByEntry[i],        // [{key,label,value,display}]
  }));
  return JSON.stringify({ entries: lines }, null, 2);
}
```

```ts
// api/src/campaign/llm/live-claude.rationale.ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { RationalesOutputSchema } from "@growthagent/shared/campaign/schema";

export class LiveClaudeRationalePort implements RationalePort {
  private client = new Anthropic({ maxRetries: 0 });  // we own the retry ladder explicitly

  async draft(args: DraftArgs): Promise<RationalesOutput> {
    const response = await this.client.messages.parse(
      {
        model: CAMPAIGN_CONFIG.rationaleModel,            // "claude-opus-5"
        max_tokens: CAMPAIGN_CONFIG.rationaleMaxTokens,   // 4096 — small output, non-streaming OK
        // NOTE: temperature / top_p / top_k intentionally absent — removed on opus-5 (400 if sent).
        thinking: { type: "adaptive" },                   // sampling knobs likewise omitted
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          { role: "user", content: buildUserPayload(args.entries, args.metricsByEntry) },
        ],
        output_config: {
          format: zodOutputFormat(RationalesOutputSchema),
        },
      },
      { timeout: CAMPAIGN_CONFIG.rationaleTimeoutMs }     // ms, per-request override
    );
    if (response.parsed_output === null) throw new RationaleParseError("parsed_output was null");
    return response.parsed_output;
  }
}
```

Verified SDK facts this code relies on (checked against current SDK docs during design): `client.messages.parse()` with `output_config: { format: zodOutputFormat(Schema) }` (import path `@anthropic-ai/sdk/helpers/zod`; the bare `output_format` parameter is deprecated); `response.parsed_output` is `null` when parsing failed; on `claude-opus-5` sending `temperature`/`top_p`/`top_k` returns 400 so they are simply omitted; `thinking: { type: "adaptive" }` is the correct on-mode (`budget_tokens` is removed, 400 if sent); typed error classes `Anthropic.BadRequestError`, `.AuthenticationError`, `.RateLimitError`, `.InternalServerError`, `.APIConnectionError` (subclass of `.APIError`, so catch order matters); per-request `timeout` override is in **milliseconds** in the TypeScript SDK.

Cache economics: the system prompt crosses the 1024-token minimum cacheable prefix; consecutive runs within 5 minutes hit `cache_read_input_tokens > 0`. Runs are 6h apart in production so the ephemeral cache usually cold-misses — acceptable (one cheap warm call per cycle); the caching discipline still pays off during DEMO_STABLE_MODE debugging bursts and manual-refresh spam.

### 7.3 Port abstraction, retry ladder, DEMO_STABLE_MODE

```ts
// api/src/campaign/llm/rationale.port.ts
export interface RationalePort {
  draft(args: DraftArgs): Promise<RationalesOutput>;
}

export type RationaleFailureKind =
  | "RETRYABLE_EXHAUSTED"     // rate limit / 5xx / network / timeout, retries spent
  | "NON_RETRYABLE"           // BadRequestError etc. — our bug; abort cycle, keep previous set
  | "PARSE_FAILED"            // HTTP OK but parsed_output null / schema mismatch
  | "CHAOS_FORCED";           // demo chaos toggle

export function classify(e: unknown): RationaleFailureKind {
  if (e instanceof ChaosForcedTimeoutError) return "CHAOS_FORCED";
  if (e instanceof Anthropic.RateLimitError) return "RETRYABLE_EXHAUSTED";
  if (e instanceof Anthropic.InternalServerError) return "RETRYABLE_EXHAUSTED";
  if (e instanceof Anthropic.APIConnectionError) return "RETRYABLE_EXHAUSTED"; // includes timeouts
  if (e instanceof Anthropic.BadRequestError) return "NON_RETRYABLE";
  if (e instanceof Anthropic.AuthenticationError) return "NON_RETRYABLE";
  if (e instanceof RationaleParseError) return "PARSE_FAILED";
  if (e instanceof Anthropic.APIError) return "RETRYABLE_EXHAUSTED"; // base, checked LAST (TS subclass order)
  return "NON_RETRYABLE";
}
```

Retry policy: `attempts = 2` for `RETRYABLE_EXHAUSTED` with exponential backoff `500ms · 2^n + jitter` — but note the SDK's own `max_retries` is set to `0` on this client so the ladder is ours and test-visible. `NON_RETRYABLE` skips retries and fails the cycle immediately (keeping the previous set) because a 400 on a frozen-shape request is a code defect, not weather.

DEMO_STABLE_MODE:

```ts
export class ReplayRationalePort implements RationalePort {
  async draft(args: DraftArgs): Promise<RationalesOutput> {
    const key = sha256(canonicalJson(requestBodyOf(args)));   // same hashing as recording
    const hit = await store.get(`rationale:${key}`);
    if (!hit) throw new StableModeCacheMissError(key);        // LOUD failure, never a silent live call
    return RationalesOutputSchema.parse(hit);
  }
}
```

Recording wraps `LiveClaudeRationalePort`: same request-hash key, stores `parsed_output` under `recordings/campaign/<key>.json` (committed for the shipped seed dataset so the demo machine needs no API access). Because the request body embeds the entries (whose ids derive from the data fingerprint), identical data replays identically; edited seed data forces exactly one live re-record.

---

## 8. Rationale verification and template fallback

### 8.1 Normalization

Matching is done on a normalized form so trivial typography can't cause false rejects, while any *semantic* invention still trips:

```ts
// api/src/campaign/verify/rationale-verifier.ts
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/₹/g, "")                 // rupee sign
    .replace(/[,]/g, "")                    // Indian digit grouping 1,23,456 -> 123456
    .replace(/−/g, "-")                // unicode minus
    .replace(/[₀-₉]/g, d => String(d.codePointAt(0)! - 0x2080)) // subscript digits
    .replace(/\s+/g, " ")
    .trim();
}

const NUMERIC_TOKEN = /\d+(?:\.\d+)?/g;

/** Numbers legitimately present besides metrics: entry weights, entry indices, years in quoted metric dates. */
function allowedNumericTokens(opp: Opportunity, entry: EntryDraft): Set<string> {
  const s = new Set<string>();
  for (const m of opp.metrics) {
    for (const t of normalizeForMatch(m.display).match(NUMERIC_TOKEN) ?? []) s.add(t);
    s.add(String(m.value));                                  // raw value tolerated alongside display
  }
  s.add(entry.weight.toFixed(2));
  return s;
}

export type Verdict = "VERIFIED" | "MISSING_METRIC" | "INVENTED_NUMBER";

export function verifyRationale(opp: Opportunity, entry: EntryDraft, rationale: string): Verdict {
  const norm = normalizeForMatch(rationale);

  // Rule 1 — completeness: EVERY metric display string must appear verbatim-normalized.
  for (const m of opp.metrics) {
    if (!norm.includes(normalizeForMatch(m.display))) return "MISSING_METRIC";
  }

  // Rule 2 — no invention: every number in the text must be accounted for.
  const allowed = allowedNumericTokens(opp, entry);
  for (const t of norm.match(NUMERIC_TOKEN) ?? []) {
    if (!allowed.has(t)) return "INVENTED_NUMBER";
  }
  return "VERIFIED";
}
```

Deliberate consequences (each pinned by a unit test):
- Rationale says "**46%** slower than peers" while the metric display is `"0.46x"` → token `"46"` is not allowed → `INVENTED_NUMBER` → template. This is exactly the fabrication class we care about: numerically faithful-looking, representationally unauthorized.
- Rationale restating `"0.46x"` twice → fine (Rule 2 checks membership, not counts).
- SKU codes contain digits (`CHOC_TRUFFLE_500G`)? SKU mentions aren't numbers post-tokenization (`500g` yields `"500"`). Therefore metric packs always include a `stock_units` metric whose display (`"60 units"`) legitimizes quantities; additionally the tokenizer strips a trailing `g`/`ml` unit before matching (`500g` → `500` allowed only if some metric contains `500`). Implemented as: `normalizeForMatch` also removes `(?<=\d)(g|kg|ml|gm)\b`.
- Dates quoted as `"2026-08-29"` pass only because the expiry metric's display is exactly that string.

### 8.2 Template fallbacks (verbatim builders)

```ts
// api/src/campaign/verify/template-rationales.ts
const M = (o: Opportunity, key: string): string =>
  o.metrics.find(m => m.key === key)?.display ?? "<missing>";   // defensive; analytics always populates

export function templateRationale(o: Opportunity, entry: EntryDraft): string {
  const [sku] = entry.skus;
  switch (o.type) {
    case "UNDERSELLING":
      return `PRIORITIZE_IN_BUNDLES for ${sku}: selling ${M(o,"units_per_day")} vs peer median `
           + `${M(o,"peer_units_per_day")} (${M(o,"velocity_ratio")} of normal) with ${M(o,"weeks_of_stock_cover")} `
           + `of stock cover. Push this SKU into bundles to close the velocity gap.`;
    case "EXPIRY_RISK": {
      const pairSku = entry.skus[1];
      return `CLEAR_NEAR_EXPIRY for ${sku}${pairSku ? ` paired with ${pairSku}` : ""}: `
           + `${M(o,"stock_units")} on hand, expected sell-through ${M(o,"expected_sell_through")} before `
           + `${M(o,"expires_on")} (${M(o,"days_to_expiry")} away), leaving ${M(o,"projected_surplus_units")} at risk.`
           + ` Discount-and-bundle now to convert it.`;
    }
    case "ATTACH_BUNDLE":
      return `PROMOTE_PAIR ${entry.skus.join(" + ")}: bought together in ${M(o,"co_count")} baskets `
           + `(${M(o,"support")} of all baskets, ${M(o,"confidence_a_to_b")} attach from ${o.skus[0]}). `
           + `Offer as a combo to lift basket size.`;
    case "TIMING":
      return `PRIORITIZE_IN_BUNDLES for ${sku}: demand peaks at ${M(o,"lift")} on ${M(o,"dow_label")} `
           + `for the "${M(o,"occ_label")}" occasion (${M(o,"cell_units")} vs ${M(o,"expected_units")} expected). `
           + `Feature it in weekend/festive bundles.`;
  }
}
```

Templates quote the same canonical displays — so even the fallback is fully auditable, and the *verifier itself passes on template output* (property-tested: `verifyRationale(opp, entry, templateRationale(...)) === "VERIFIED"` for every fixture opportunity).

---

## 9. Publication

```ts
// api/src/campaign/scheduler/campaign.cycle.ts (core, abridged)
export async function runCampaignCycle(deps: CycleDeps): Promise<CycleResult> {
  const token = randomUUID();
  const lock = await deps.locks.acquire(`campaign:lock:${MERCHANT_ID}`, token, CAMPAIGN_CONFIG.lockTtlMs);
  if (!lock.acquired) return { status: "SKIPPED_LOCKED", holder: lock.holderInfo };

  try {
    const asOf = deps.clock.simNow();
    const runId = await deps.audit.append(CAMPAIGN_RUN_STARTED, { as_of: asOf.toISOString() });

    const fingerprint = await deps.db.one(sql.fingerprint, { as_of: asOf });
    const analyticsRunId = `ar_${fmtSimDate(asOf)}_${fingerprint.slice(0, 8)}`;
    await deps.repo.insertAnalyticsRun(analyticsRunId, asOf, fingerprint);

    const opps = await deps.analytics.buildOpportunities(asOf, analyticsRunId);
    await deps.audit.append(CAMPAIGN_OPPORTUNITIES_EMITTED,
      { run_id: analyticsRunId, count: opps.length,
        by_type: countBy(opps, o => o.type),
        suppressed: [] /* filled below */ });

    if (opps.length === 0) {
      const set = emptySet(analyticsRunId, asOf);            // status EMPTY, entries []
      await publish(deps, set, runId);
      return { status: "OK_EMPTY", set_id: set.set_id };
    }

    const { entries, suppressed } = assembleEntries(rankByWeight(opps), CAMPAIGN_CONFIG);
    const llmOutcome = await draftRationalesWithFallback(deps, entries, opps);
    //  - per-entry: VERIFIED_LLM or TEMPLATE_FALLBACK (verifier verdict recorded)
    //  - port-level failure: PARSE/RETRYABLE/NON_RETRYABLE/CHAOS -> see policy table §10

    const set = buildPrioritySet({ analyticsRunId, asOf, entries: llmOutcome.entries });
    await publish(deps, set, runId);   // INSERT priority_sets + swap pointer + audit + SSE
    return { status: "OK", set_id: set.set_id, version: set.priority_set_version };
  } finally {
    await deps.locks.release(`campaign:lock:${MERCHANT_ID}`, token);  // Lua compare-and-delete
  }
}
```

Publication is transactional: `INSERT INTO priority_sets ...` and `UPDATE app_config SET value = set_id WHERE key='campaign.current_priority_set'` commit atomically; SSE `campaign.priority_set.published` fires only after commit.

Persistence DDL:

```sql
CREATE TABLE analytics_runs (
  run_id      TEXT PRIMARY KEY,
  as_of       TIMESTAMPTZ NOT NULL,
  fingerprint TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'RUNNING'
              CHECK (status IN ('RUNNING','OK','OK_EMPTY','KEPT_PREVIOUS','FAILED')),
  stats       JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE priority_sets (
  set_id     TEXT PRIMARY KEY,
  version    INTEGER NOT NULL UNIQUE,
  run_id     TEXT NOT NULL REFERENCES analytics_runs(run_id),
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  status     TEXT NOT NULL CHECK (status IN ('FRESH','EMPTY','TEMPLATE_ONLY','PARTIAL_TEMPLATE')),
  payload    JSONB NOT NULL,          -- PrioritySet, validated by shared zod schema before write
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX priority_sets_one_current ON priority_sets (is_current) WHERE is_current;

-- app_config(key TEXT PRIMARY KEY, value TEXT NOT NULL)  row: 'campaign.current_priority_set'
```

`version = COALESCE(MAX(version) OVER ()) + 1` assigned inside the publish transaction; `set_id = 'ps_v' || version || '_' || left(md5(payload::text), 8)`.

---

## 10. Failure-mode policy (the keep-previous vs template-fallback reconciliation)

The brief commits to two behaviors that must compose precisely:
- "campaign agent failure → previous PrioritySet persists" (graceful-degradation list), and
- "LLM rationale fails the metrics check → fall back to a deterministic template string" (per-entry guard).

Resolution, encoded in `draftRationalesWithFallback`:

| Situation | Detection | Behavior | Set published? | Set status |
|---|---|---|---|---|
| LLM healthy, all rationales verify | verifier `VERIFIED` ∀ entries | Publish normally | Yes | `FRESH` |
| LLM healthy, **some** rationales fail verification | any `MISSING_METRIC`/`INVENTED_NUMBER` | Replace offending rationale with template; keep verified ones | Yes | `PARTIAL_TEMPLATE` |
| LLM responded, **all** rationales fail | verifier fails ∀ | All-template set | Yes | `PARTIAL_TEMPLATE` (all entries `TEMPLATE_FALLBACK`) — semantically equivalent to template-only, kept distinct for telemetry |
| LLM unreachable / times out / rate-limited / 5xx after retries | `classify = RETRYABLE_EXHAUSTED` or `CHAOS_FORCED` | **Abort cycle; previous set stays current** (its TTL keeps running → goes STALE per §11). Run status `KEPT_PREVIOUS`. | No | previous retained |
| LLM 400-class defect | `classify = NON_RETRYABLE` | Abort cycle; page-worthy log; previous retained | No | previous retained |
| Parse failure after 1 re-request | `PARSE_FAILED` | Treat as `RETRYABLE_EXHAUSTED` (one retry, then keep previous) | No | previous retained |
| LLM down **at seed time** (no previous set exists) | previous lookup misses | Publish all-template set so demo beat 1 always has material | Yes | `TEMPLATE_ONLY` |
| Analytics find nothing | zero opportunities | Publish explicit EMPTY set | Yes | `EMPTY` |
| SQL error / DB down | exception in analytics | Abort cycle; previous retained; `CAMPAIGN_RUN_FAILED` appended | No | previous retained |
| Redis down at lock time | connection error from `SET NX` | Fall back to `pg_try_advisory_lock(hashtext('campaign_cycle'))`; if that also fails, abort (previous retained) | per above | — |

Rationale for the split: a template rationale is *fully deterministic and auditable* — publishing it costs nothing in trust and keeps the set fresh. An unavailable LLM is an agent failure, and the committed contract for agent failure is "previous persists." The seed-time hole (nothing to persist) is closed with `TEMPLATE_ONLY` rather than EMPTY because demo beat 1 requires *some* priority content; it is logged loudly and visible in the UI badge.

---

## 11. Injection contract into the negotiation Evidence Pack

### 11.1 Section shape

The Evidence Pack (owned by the pipeline orchestrator) gains one section. Each entry is registered in the pack's stable-ID registry so the negotiation-upsell-agent can cite it and the deterministic Citation Auditor can resolve the citation back to `priority_sets.payload`.

```ts
// packages/shared/src/evidence-pack/campaign-section.ts
export const CAMPAIGN_FRESHNESS = z.enum(["FRESH", "STALE"]);

export const CampaignPriorityEvidenceSchema = z.object({
  section:            z.literal("CAMPAIGN_PRIORITY"),
  priority_set_id:    z.string(),
  priority_set_version: z.number().int(),
  freshness:          CAMPAIGN_FRESHNESS,
  age_seconds:        z.number().int().nonnegative(),   // simNow - generated_at_sim
  entries: z.array(z.object({
    evidence_id:   z.string().regex(/^EP-CAMP-pe_[0-9a-f]{10}$/),
    entry_id:      z.string(),
    action:        PriorityAction,
    skus:          z.array(z.string()),
    weight:        z.number(),
    rationale_nl:  z.string(),
    metrics:       z.array(MetricSchema),      // raw metrics ride along so citations quote real numbers
    opportunity_type: OpportunityType,
  })).strict(),
}).strict();
```

`evidence_id = 'EP-CAMP-' + entry_id`. Registry entry: `{ id, kind: "CAMPAIGN_PRIORITY", resolver: (id) => rowFrom(priority_sets.payload) }` — the Citation Auditor treats an EP-CAMP citation whose quoted numbers don't match `metrics[].display` exactly as a broken citation, same machinery it uses for every other evidence kind.

### 11.2 Freshness policy

Computed at pack-build time from the snapshot row:

```ts
const ageSec = (clock.simNow().getTime() - Date.parse(set.generated_at_sim)) / 1000;
// plus a wall-clock guard for long-idle demo machines:
const realAgeSec = (Date.now() - set.created_at_wall) / 1000;
freshness = (ageSec <= set.ttl_seconds && realAgeSec <= 24 * 3600) ? "FRESH" : "STALE";
omitSection = ageSec > CAMPAIGN_CONFIG.hardExpirySeconds;   // HARD_EXPIRED -> section absent
```

Three states, one contract:
- **FRESH** — injected normally; negotiation prompt: "Campaign priorities below are current; weigh them strongly."
- **STALE** — still injected, `freshness: "STALE"` plus prompt note "stale — treat as advisory background only." Never silently treated as fresh; never dropped while within hard-expiry (a stale hint beats no hint, and the demo benefits from showing the tag).
- **HARD_EXPIRED** (age > 48 h sim, or no set ever published) — section omitted; negotiator told "no active campaign priorities." Gatekeeper behavior identical in all three states, by construction.

Snapshot semantics: the pipeline loads the current set **once** at transaction open (single `SELECT ... WHERE is_current`), and the resulting pack is frozen for the transaction's lifetime. A refresh landing mid-transaction affects only future transactions.

Negotiation-side consumption (contract, not implementation): the negotiator must cite `EP-CAMP-*` ids for any campaign-derived claim ("I'm featuring X because the campaign engine flags 18.5 weeks of cover"); deviating from a priority is allowed but must cite something else (buyer intent, margin evidence). It may never cite campaign data as justification for a discount percentage — discounts come from merchant rules only; the Citation Auditor and gatekeeper independently enforce this from their own sides.

---

## 12. Scheduling, locking, endpoints, audit

### 12.1 Triggers

1. **Seed completion** — seed calls `runCampaignCycle()` inline (awaited) so demo beat 1 works immediately after `npm run seed`.
2. **Timer** — `setInterval(runCampaignCycleSafe, refreshIntervalHours·3600·1000)` started in `campaign.module.ts` on API boot; unref'd; wrapped so a cycle crash never kills the process. Interval is wall-clock; all *data* windows are sim-clock-relative, so cadence alignment with sim time is irrelevant to correctness.
3. **Manual refresh** — endpoint below (demo choreography + chaos recovery).

### 12.2 Single-flight lock

```ts
// api/src/campaign/scheduler/lock.ts
const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

async acquire(key: string, token: string, ttlMs: number) {
  try {
    const ok = await redis.set(key, token, "NX", "PX", ttlMs);
    return ok ? { acquired: true } : { acquired: false, holderInfo: await redis.get(key) !== null ? "in-flight" : "unknown" };
  } catch (e) {
    // Redis degraded: Postgres advisory lock keeps single-flight intact (session-scoped, auto-released)
    const pgOk = await db.one(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [key]);
    return pgOk.ok ? { acquired: true } : { acquired: false, holderInfo: "pg-advisory-holder" };
  }
}
async release(key: string, token: string) {
  try { await redis.eval(RELEASE_IF_OWNER, 1, key, token); }
  catch { /* Redis was down: advisory lock releases with session end */ }
}
```

Details that matter: the Lua compare-and-delete means an expired-then-reacquired lock is never deleted by the stale holder; `lockTtlMs` (5 min) exceeds the worst-case cycle duration (analytics ≪ 1 s on 90 days × 10 SKUs; LLM budget ≈ 30 s × 3 attempts) so TTL expiry mid-run is a pathological case logged at `error`. Two overlapping manual refreshes ⇒ exactly one runs, the other gets `409` with the current run status.

### 12.3 HTTP surface (`api/src/campaign/http/campaign.routes.ts`)

| Route | Auth | Behavior |
|---|---|---|
| `POST /internal/campaign/refresh` | `X-Admin-Key` (constant-time compare against sha256 of `ADMIN_API_KEY` env) | Acquires lock via `runCampaignCycle`; returns `202 { run_id, status: "STARTED" }` or `409 { status: "RUNNING", current_set: {...} }` on lock contention. |
| `GET /internal/campaign/status` | same | Last run: id, status, durations, entry counts, LLM provenance counters, current set id/version. |
| `GET /internal/campaign/priorityset/current` | same | Current set + freshness computed at read time. |
| `GET /internal/campaign/runs/:runId` | same | Reconstructed timeline from audit_log (read-only replay support). |

### 12.4 Audit events (appended via the shared hash-chained audit service; `correlation_id = run_id`, `tx_id = null`)

```ts
// packages/shared/src/campaign/audit-events.ts
export type CampaignAuditEvent =
  | { type: "CAMPAIGN_RUN_STARTED";        run_id: string; as_of: string; trigger: "SEED"|"TIMER"|"MANUAL" }
  | { type: "CAMPAIGN_OPPORTUNITIES_EMITTED"; run_id: string; count: number;
      by_type: Record<OpportunityType, number>; opportunities: Array<{ opportunity_id: string; type: OpportunityType; skus: string[]; weight: number }> }
  | { type: "CAMPAIGN_PRIORITY_SET_PUBLISHED"; run_id: string; set_id: string;
      priority_set_version: number; status: PrioritySetStatus; entry_count: number;
      llm_invocation: PrioritySet["llm_invocation"] }                     // full payload in priority_sets.payload
  | { type: "CAMPAIGN_RATIONALE_FALLBACK"; run_id: string; entry_id: string;
      opportunity_id: string; verdict: "MISSING_METRIC"|"INVENTED_NUMBER"|"PORT_FAILURE"|"NO_INDEX";
      rejected_rationale: string }                                        // kept: great demo/explainer fodder
  | { type: "CAMPAIGN_SET_SUPPRESSED_OPPORTUNITY"; run_id: string; opportunity_id: string;
      reason: "SKU_ALREADY_CLAIMED"|"SET_FULL" }
  | { type: "CAMPAIGN_RUN_FAILED";        run_id: string; phase: "ANALYTICS"|"LLM"|"PUBLISH";
      error_kind: string; message: string; previous_set_retained: boolean };
```

Chain integrity: `event.hash = sha256(prev_hash || "|" || canonicalJson(eventWithoutHash))` — provided by the shared audit service; campaign supplies events only. The audit-only replay endpoint walks the chain, verifies hashes, and rebuilds any run's timeline; a tampered or reordered chain fails verification loudly. `CAMPAIGN_RATIONALE_FALLBACK.rejected_rationale` is deliberately retained — it is the exact artifact the explainer-agent and the demo narrator use to show "what the AI tried vs what shipped."

---

## 13. Determinism guarantees (and how each is enforced)

| Guarantee | Mechanism | Enforced by |
|---|---|---|
| Same data + same sim-date ⇒ same `analytics_run_id`, same opportunity ids | Fingerprint hash (§5.5) + content-derived ids (§6.3) | FP-1/FP-2 fixture tests |
| Same opportunities ⇒ same entries, actions, weights, order | Pure functions (§6.4–6.6), total-order sort, no clocks | Snapshot unit tests: `assembleEntries` golden-file comparison |
| Rationale *content* deterministic when LLM absent/untrusted | Template builders from canonical displays (§8.2) | Property test: templates always pass the verifier |
| Live-mode rationale variance confined to phrasing | Index-addressed output schema; verifier gates every number | Unit tests §15-B |
| Byte-identical replay in DEMO_STABLE_MODE | Request-hash keyed recordings; loud cache-miss error | Integration test: two full cycles → `JSON.stringify(set)` deep-equal |
| No hidden wall-clock dependence | `:as_of` parameters everywhere; grep-guard banning `now()\|CURRENT_DATE\|CURRENT_TIMESTAMP` in `analytics/sql.ts` | CI grep test |
| Reproducible truncation/top-N | Deterministic ORDER BY before LIMIT, everywhere | Reviewed per query; asserted by fixtures with tied scores |

Known irreducible nondeterminism (documented, bounded): live-mode `rationale_nl` wording and `latency_ms`/token counts. Neither influences decisions, citations resolution, or gatekeeper outcomes.

---

## 14. Edge-case catalogue (consolidated)

**Data shapes:** zero-sale SKU; SKU younger than `minHistoryDays`; singleton category; category where all members are slow (median drags — accepted, ratio≈1 protects); SKU expiring today; already-expired SKU; non-perishable (`expires_on IS NULL`); stock 0 (underselling still possible but cover-term saturates; expiry needs `stock_units > 0` implicitly via surplus>0); basket of size 1 (support denominator only); duplicate SKU lines in one basket (line_no pairing handles); DST-less IST bucketing (India has no DST — one less hazard, still pinned by test).

**Numerics:** ratio exactly at threshold (excluded); confidence exactly at floor (`>=`, included — pinned); support floor; lift below threshold; `percentile_cont` on 1-element group; `NULLIF` zero-median; paise formatting with Indian grouping (`₹1,23,456.00`) and the normalizer stripping commas.

**Lifecycle:** refresh during an open transaction (pointer swap, snapshot isolation); refresh during a refresh (lock); Redis down (advisory lock); Postgres down (abort, retain); seed-time LLM failure (`TEMPLATE_ONLY`); TTL boundary (`age_seconds == ttl_seconds` ⇒ FRESH — `<=`, pinned); hard-expiry boundary; EMPTY set injection renders "no active campaigns"; `maxEntriesPerSet` reached (suppression audited); same SKU claimed by higher-weight entry (suppression audited).

**LLM output:** missing entry index (template); duplicate indices (first wins, rest ignored, one fallback event); out-of-range index (fallback); `parsed_output === null` (parse failure path); rationale in wrong language/register (passes verifier — acceptable, audit prose is human-reviewed); rationale omitting one metric (`MISSING_METRIC` → template); rationale paraphrasing a number (`INVENTED_NUMBER` → template — the adversarial-buyer-analogous failure *inside our own stack*, and a strong talking point for the "AI proposes, gatekeeper disposes" theme: we run the same distrust internally).

---

## 15. Tests (vitest)

Runner layout: `api/vitest.config.ts` with projects `unit` (pure, no IO) and `integration` (Postgres + Redis testcontainers; `pg-mem` is *not* used — it does not faithfully implement `percentile_cont ... WITHIN GROUP` or `make_interval`). Fixtures live in `api/test/campaign/fixtures/`.

### 15-A SQL correctness fixtures (tiny hand-computed dataset)

Fixture dataset: categories `CAKES` (members A=`CHOC_TRUFFLE_500G`, B=`RED_VELVET_500G`, C=`MANGO_PASTRY`), `COOKIES` (D=`BUTTER_COOKIE_JAR`), `GIFTS` (E=`KAJU_KATLI_250G` perishable, F=`DRY_CAKE_ASSORTED`). Anchor `as_of = 2026-08-24T23:59:59+05:30`. Sales inserted explicitly (not via the 90-day generator) so expectations are hand-checkable; `price_band` breakpoints chosen so A,B,E,F are `mid`, C,D `low`.

| ID | Case | Setup | Expected |
|---|---|---|---|
| US-1 | Underseller flagged | 28d units A=28,B=56,C=13 (all `mid` CAKES) | C flagged: `units_per_day=0.4643`, `peer=1.0000`, `ratio=0.4643`, `cover=18.5 weeks` (display), weight `0.44` |
| US-2 | Exactly-at-threshold not flagged | C=14 units ⇒ ratio `0.50` | C absent (strict `<`) |
| US-3 | Singleton band falls back, then protected | Give A,B,C distinct bands ⇒ each alone in band | Category-level median used; if category singleton ⇒ ratio 1 ⇒ not flagged |
| US-4 | Young SKU excluded | G created 5 days ago, zero sales | G absent from results and from peer pool |
| US-5 | Zero-sale veteran flagged with sentinel | H (28d old) zero sales, stock 40 | Flagged: ratio `0.00`, cover `999` sentinel, highest weight in type |
| EX-1 | Surplus flagged | E: stock 30, expires as_of+5d, 14d upd 0.4 | `surplus=28`, weight `0.71`, display `"2026-08-29"`, `"5 days"` |
| EX-2 | Sells through — not flagged | E': stock 2, same velocity | Absent (strict `>`) |
| EX-3 | Beyond horizon | E'': expires as_of+8d | Absent from expiry query |
| EX-4 | Already expired | E''': expires as_of−1d | Excluded; counted in `stats.expired_skus_count` |
| EX-5 | Expires today | E⁗: expires as_of, stock 10 | Flagged, `urgency` term saturated, top weight |
| AT-1 | Pair mined | 200 baskets; D&E co-occur 12; D in 80 | `support=6.0%`, `confidence_a_to_b=15.0%`, included (floor `>=`) |
| AT-2 | Support floor drops pair | co_count 5, 400 baskets ⇒ 1.25% | Absent despite passing co-count |
| AT-3 | Confidence floor drops pair | co 12 but anchor in 200 baskets ⇒ 6% | Absent |
| AT-4 | No dupes/self-pairs | Basket with A twice + B once | Exactly one `(A,B)` row per such basket; zero `X,X` rows |
| AT-5 | Deterministic truncation | 12 qualifying pairs, limit 10 | Same 10 rows across two executions (tie-break by sku) |
| WD-1 | Occasion lift emits TIMING | Eggless units 100/900 total; Sunday 180/900; eggless-on-Sunday 43 | `expected=20.0`, `lift=2.15x` ≥ 1.8 ⇒ TIMING opp, weight `0.77` |
| WD-2 | Lift below threshold | eggless-on-Sunday 25 | `lift=1.25x` ⇒ absent |
| WD-3 | IST bucketing | Sale `2026-08-23T19:00:00Z` (= Mon 00:30 IST) | Counted in `dow=1` (Monday), not Sunday |
| FP-1 | Fingerprint stability | Run twice, no writes | Identical fingerprint, run_id, opportunity ids |
| FP-2 | Fingerprint sensitivity | Insert one sale row | New fingerprint ⇒ new run_id ⇒ new opportunity ids; old set untouched |

### 15-B Unit tests (pure logic)

| ID | Case | Assertion |
|---|---|---|
| U-1 | Weight monotonicity | Lower ratio / higher surplus / higher confidence / higher lift ⇒ weight non-decreasing (property sweep) |
| U-2 | Clamp extremes | Ratio 0 & cover ∞ ⇒ ≤ 1; lift huge ⇒ exactly 1; negative inputs impossible by schema but clamp01 holds |
| U-3 | Id stability | `opportunityId` golden vectors; reordering `skus` input yields same id |
| U-4 | Verifier accepts honest rationale | Golden rationale per type ⇒ `VERIFIED` |
| U-5 | Verifier rejects percent-conversion | `"0.46x"` rendered as `"46%"` ⇒ `INVENTED_NUMBER` |
| U-6 | Verifier rejects invented figure | Extra `"50% off"` ⇒ `INVERTED_NUMBER` (sic — test name kept) ⇒ `INVENTED_NUMBER` |
| U-7 | Verifier rejects missing metric | Drops `"18.5 weeks"` ⇒ `MISSING_METRIC` |
| U-8 | Normalizer robustness | `₹1,23,456.00`, unicode minus, subscripts, `500g` handling all match |
| U-9 | Templates self-verify | ∀ fixture opportunities: `verify(template) === VERIFIED` |
| U-10 | Index attachment | Returned indices map to correct entries; missing index ⇒ that entry templated, others untouched |
| U-11 | Assembly conflicts | Shared-SKU competition resolved by weight→type-tiebreak→id; suppressions recorded with reasons |
| U-12 | Freshness math | age==ttl ⇒ FRESH; age=ttl+1 ⇒ STALE; age>hardExpiry ⇒ omit; wall-clock 25h ⇒ STALE |
| U-13 | Failure classification | Each typed SDK error maps to the right `RationaleFailureKind`; `APIConnectionError` checked before base `APIError` |
| U-14 | Request-body stability | `buildUserPayload` byte-equal across two invocations (cache + replay-key prerequisite) |

### 15-C Integration tests

| ID | Case | Assertion |
|---|---|---|
| I-1 | Happy path | Seed → cycle → current set FRESH, entries carry `VERIFIED_LLM` majority, audit chain verifies end-to-end |
| I-2 | Manual refresh | `POST /internal/campaign/refresh` 202; second concurrent call 409 `SKIPPED_LOCKED`; exactly one new version |
| I-3 | Single-flight race | Fire two cycles concurrently against real Redis ⇒ one `OK`, one `SKIPPED_LOCKED`; lock released afterwards |
| I-4 | LLM down keeps previous | Mock port throws `APIConnectionError` exhaustively ⇒ previous set still current, run status `KEPT_PREVIOUS`, `CAMPAIGN_RUN_FAILED` appended with `previous_set_retained: true` |
| I-5 | Fabrication contained | Mock returns rationales with invented `"EMPLOYEE50 50% off"`-style numbers ⇒ published set marks those entries `TEMPLATE_FALLBACK`, `CAMPAIGN_RATIONALE_FALLBACK` events carry rejected text, set status `PARTIAL_TEMPLATE` |
| I-6 | Empty analytics | Truncate `sales_history` ⇒ cycle publishes EMPTY set; pack-builder omits entries gracefully; negotiation smoke test still completes |
| I-7 | Seed-time LLM outage | Empty prior + dead port ⇒ `TEMPLATE_ONLY` set published |
| I-8 | Redis down | Stop Redis container ⇒ cycle succeeds via advisory lock; two concurrent cycles still serialized |
| I-9 | Stable-mode replay | Record once, wipe derived tables, rerun with `ReplayRationalePort` ⇒ `deepEqual(JSON.stringify(setA), JSON.stringify(setB))`; cache miss ⇒ throws `StableModeCacheMissError` |
| I-10 | Audit chain | Over a 5-cycle history: recompute hashes ⇒ chain valid; flip one byte ⇒ verification fails |
| I-11 | Injection snapshot | Start cycle and a transaction concurrently ⇒ transaction's pack references pre-swap version; next transaction sees new version |
| I-12 | Chaos toggle | `CHAOS_FORCED_LLM_TIMEOUT=1` ⇒ behavior identical to I-4, and the frontend chaos panel reflects it |
| I-13 | No-Razorpay assertion | Static import-graph test: nothing under `api/src/campaign` imports the Razorpay adapter or settlement module (structural enforcement of TB-C1) |

Mocking note: LLM mocks implement `RationalePort`, never `fetch` interception — the port seam is the only place Anthropic is touched, so tests exercise the real retry/classification code with synthetic throws.

---

## 16. Frontend touchpoints (contract only)

- Screen (a), live trace: a persistent "Campaign brain" chip lane shows current set version + status badge (`FRESH` / `STALE` / `EMPTY` / `TEMPLATE_ONLY` / `PARTIAL_TEMPLATE`); when a negotiation cites `EP-CAMP-*`, the cited entry's rationale highlights with its metric chips (rendered from `metrics[].display`).
- Screen (b), merchant console: read-only "Current priorities" card (entries, weights, rationales, provenance icons) plus a **Refresh campaigns** button wired to `POST /internal/campaign/refresh` with the admin key; after `CAMPAIGN_RUN_FAILED`, shows "kept previous set (vN)" with the failure reason.
- SSE: subscribes to `campaign.priority_set.published` on both screens; the publish event animates the chip update — nice between-beats texture during the demo.

---

## 17. Verified vs. unverified items

**Verified during this design** (against current SDK documentation loaded in-session):
- `client.messages.parse()` + `output_config: { format: zodOutputFormat(schema) }`, import `@anthropic-ai/sdk/helpers/zod`; deprecated bare `output_format` avoided; `response.parsed_output` null-on-failure.
- `claude-opus-5`: `temperature`/`top_p`/`top_k` removed (400 if sent) — omitted; `thinking: { type: "adaptive" }`; `budget_tokens` removed.
- Typed errors: `Anthropic.BadRequestError` / `.AuthenticationError` / `.RateLimitError` / `.InternalServerError` / `.APIConnectionError` (subclass of `.APIError` — catch order honored in §7.3); `.status` available on the base.
- Prompt caching: system-block `cache_control: { type: "ephemeral" }`, prefix-match semantics, ~1024-token minimum cacheable prefix, `usage.cache_read_input_tokens` for verification.
- TypeScript per-request timeout override in milliseconds.

**Not applicable here:** Razorpay Orders/webhook field names — this subsystem performs zero Razorpay IO (settlement-agent's section owns that verification burden). AP2/ACP mandates — no campaign artifact participates in mandate flows.

**Marked unverified / confirm at implementation time:**
1. `zodOutputFormat` compatibility with deeply nested `.strict()` objects and `z.array(...).min/max` constraints — presumed supported (it serializes Zod to JSON Schema), but confirm the generated schema passes the API's strict-schema validator for our exact `RationalesOutputSchema`; if a constraint is rejected, relax to plain `z.array(z.object(...))` and enforce bounds in the follow-up application check (the verifier tolerates it either way).
2. Minimum SDK version carrying `messages.parse`/`output_config` — pin `@anthropic-ai/sdk` to the latest release in `package.json` and add a smoke test that fails loudly on downgrade.
3. `percentile_cont` performance characteristics are irrelevant at demo scale (10 SKUs), but the peer-median CTE assumes `catalog` fits in memory; revisit only if the merchant catalog grows past ~10k SKUs.
4. The `TEMPLATE_ONLY` seed-time fallback (§10) is this document's one deliberate interpretation call where the committed rules intersect ("keep previous" + "template fallback" + "empty analytics ⇒ EMPTY set" leave the no-previous-set-and-LLM-down corner unspecified); flagged for the architecture owner to ratify.