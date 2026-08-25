# GrowthAgent — Build Log

Running ledger of what changed, when, and why. One entry per module or fix batch.
Decisions that reconcile spec conflicts live in **ARCHITECTURE.md §18** (canonical register).

---

## M0 — docs + scaffold (commit `daca19c`)

Architecture corpus (7 deep design specs under `docs/design/`, master synthesis in
ARCHITECTURE.md), red-team hardening register (28 findings adjudicated), npm-workspaces
monorepo skeleton (`shared/`, `api/`; `web/` intentionally absent until the frontend phase).

---

## M1 — Gatekeeper (`api/src/gatekeeper/`) — 2026-08-25

**The money gate: a pure, deterministic, fail-closed function** `(proposal, rules,
ground_truth, velocity, injection, now_iso, tx_id) → GatekeeperResult`. Implements
`docs/design/gatekeeper.md` end to end.

### Built

- **All 16 rules**, registry order per §6: citation-gate, rules-effective,
  proposal-freshness, cart-structure, sku-resolution, totals-drift, cart-value,
  discount-cap, margin-floor, category-allowlist, stock-availability, expiry-guard,
  velocity-requests, velocity-value, injection-guard, repeat-offender. Each returns
  `{status, severity, reason_code?, human_message, evidence}`; SKIP when a `dependsOn`
  rule didn't PASS (tracked by the engine).
- **Engine** (`engine.ts`): context build → rules in fixed order → verdict→trace entries
  → aggregation **DECLINE > ESCALATE > APPROVE** → `input_digest`
  = sha256(canonicalJson(inputs)) binding result to inputs. Unexpected rule faults are
  converted to fail-closed FAIL entries, never crash the gate.
- **Money math** (§8): integer paise throughout; `toBps` conversion exactly once;
  ONE HALF_UP rounding event (discount amount); largest-remainder per-line allocation
  conserving paise exactly; margin check via integer cross-multiplication
  (`M·10000 >= floorBps·N`) so no float ever decides an outcome.
- **Purity enforced mechanically**: ESLint bans `Date.now()`, `new Date()`,
  `Math.random()`, `process.*`, and `await` inside `api/src/gatekeeper/**` (§16.4).
  Time enters only as `now_iso`; velocity history is projected outside and passed in.

### Tests — 84/84 passing

- **48-row boundary matrix** from §13, row by row (`rules.spec.ts`), including the
  EMPLOYEE50 prompt-injection demo beat and the multi-blocker precedence case.
- **Fast-check property battery** (`engine.spec.ts`): PAISE-CONSERVATION (300 runs),
  PROSE-INVARIANCE (100), MONOTONE-SAFETY ×2 asserting the spec's actual claim
  (`DECLINE ↛ APPROVE`; ESCALATE→APPROVE is legal by band design — see below),
  CROSS-MULT-EQ-FLOAT (2000), ALLOCATION-BOUNDS (1000), randomized DETERMINISM (100).
- Latency budget (row 48): 25-distinct-SKU worst-case cart < 5ms.
- I-4 trace completeness pinned: every evaluation yields all 16 trace rows in registry order.

### Adversarial fix caught by testing

Hostile NaN quantities made `buildContext` call `assertSafeInt(price × NaN)` → thrown
RangeError — the gate *crashed* on malformed input instead of failing closed. Fix:
a `structurallyValid` guard zeroes all money math for structurally invalid carts, so
GK-CART-STRUCTURE delivers the FAIL verdict and no rule ever touches hostile numerics.

### Documented normalizations (registered in ARCHITECTURE.md §18)

1. Escalation bands are `[lowerEdge, cap)` — lower inclusive, upper exclusive
   (resolves §8.5 vs §13 rows 2/7; matrix is normative).
2. `FAIL.reason_code` widened to `DeclineCode | EscalationCode`.
3. Optional `expected`/`actual` added to non-FAIL verdict variants (matrix pins them on
   PASS/BAND rows too).
4. Repeat-offender with UNAVAILABLE velocity → **SKIP** (not UNAVAILABLE_INPUT) to avoid
   duplicating VELOCITY_UNAVAILABLE as an escalation cause; decision recorded in-trace.

### Gaps / deferred

- Redis-Lua atomic velocity `checkAndRecord` (red-team closure) belongs to the API layer
  around the gate — lands with settlement/persistence (M3), not inside the pure function.
- The gate is wired but has no HTTP surface yet; arrives with the orchestrating route in M2+.

---

## M2 — Negotiation agent (LLM #1 of 4) — 2026-08-25

**The buyer-facing negotiator**: proposal generation → citation audit → deterministic
fallback, per `docs/design/negotiation.md`. Same split as the gatekeeper: everything
deciding money or truth lives in `shared/` as pure code; `api/src/negotiation/` holds
the LLM transport, prompt assembly, and stage routing.

### Built

- **Evidence pack foundations** (`shared/src/evidence/`): `allocateIds` — deterministic
  E001… allocator over a canonical sort (kind order → sku → payload hash), so the same
  facts always yield the same ids and replay stays byte-stable; `packHash` binds
  post-allocation content + sensitivity tier; `deriveNumericFacts` — THE one fact
  deriver shared by pack tooling and auditor, so "legal numbers" have exactly one source.
  OCCASION_FIT/PAIRING emit no money facts by construction (trust rule §1.7).
- **Proposal schema** (`shared/src/negotiation/proposal.schema.ts`): zod/v4 strictObject
  — items 1..6, discount multipleOf 0.5, claims 1..12 with E-id regex evidence refs,
  priority ids ≤6, duplicate-sku rejection. First LLM-facing schema on `zod/v4`
  (SDK requirement — see normalizations).
- **Citation Auditor** (`shared/src/negotiation/audit.ts`): pure `(proposal, pack,
  opts) → {verdict CLEAN|STRIPPED|FAILED, violations[], effective_proposal, flags}`.
  Stage 1 SKU existence · 1b stock relation · 2 per-claim reconciliation (dangling ids,
  kind guard, numeric scanner with Indian-grouping parsing, tolerance rules for rupee/
  pct/count round-down/derived-total allowance) · 2b priority-ref integrity. Fatal codes
  UNKNOWN_SKU / GROSS_FABRICATION / STOCK_OVERDRAW / PRIORITY_REF_MISMATCH +
  money-relevant NUMERIC_MISMATCH + empty cart. Injection-echo n-gram overlap flag;
  `include_costs=false` redaction makes cost citations unauditable (the model cannot
  cite what it was never shown). No clock reads — `audited_at` injected, so replays
  re-audit byte-identically years later.
- **Prompt renderer** (`api/src/negotiation/prompt.ts`): frozen system prompt (sha256
  pinned in provenance), evidence pack rendered verbatim, buyer request + customer note
  behind `<untrusted_customer_note>` with case-insensitive neutralization of close-tag
  injection attempts, NUL/zero-width stripping, newline + length clamps.
- **Deterministic fallback ladder** (`api/src/negotiation/fallback.ts`, §6.3): seed line
  (best-seller by units_sold among stock-available SKUs) → step-3 attach/pairing
  complement → step-4 campaign nudge (fills only skus not already present); qty clamped
  [1, min(2, available)]; discount only when a cited campaign advertises it; every claim
  cites its evidence id; byte-deterministic across runs. Degenerate case codified as
  EMPTY_DECLINE_PROPOSAL (polite decline, zero items).
- **Stage router** (`api/src/negotiation/stage.ts`): response checklist per §3.5 —
  refusal→REFUSAL, max_tokens→MAX_TOKENS, end_turn+parse-fail→PARSE_FAILED, throw→
  TRANSPORT_ERROR; FAILED audit preserves the original audit for the trail and ships the
  fallback's own CLEAN audit alongside; provenance envelope on every outcome
  (NEGOTIATION_LLM_V3 vs DETERMINISTIC_FALLBACK_V1).
- **Transports**: live (`transport.live.ts`) with typed-error retry classification
  (429/5xx/timeouts retried with retry-after-aware backoff; 400-class never),
  chaos-injectable for tests; replay (`transport.replay.ts`) implementing DEMO_STABLE_MODE
  record/replay keyed by sha256(system_prompt_hash ‖ pack_hash ‖ canonical buyer request).

### Tests — shared 43/43 · api 148/148 passing

- **A1–A18 matrix rows** from negotiation.md §8.1 plus beyond-matrix edges (derived-total
  allowance, post-discount total rejection, stock overdraw, ghost priority, degenerate
  carts, envelope hygiene, scanner probes) against a golden fixture pack whose ids are
  asserted stable under 100 input shuffles.
- Prompt purity (no clock/env/network reads), freeze discipline (sha256 changes when
  prompt bytes change), sanitizer suite (tag neutralization, control chars, multibyte
  truncation safety), honest params pinning (`max_tokens/model/thinking` exactly).
- Fallback ladder ordering (complement before nudge), clamps, determinism ×200.
- Stage routing matrix incl. the spoke-but-lied path (FAILED audit → PARSE_FAILED
  narration → fallback ships, original audit preserved).
- Replay key reproducibility/sensitivity, stale-schema rejection, corrupt-fixture miss.
- Typed SDK error instances through the retry classifier (11-row table).

### Adversarial fixes caught by testing

1. `deriveNumericFacts` had no RUPEE mirror of `cost_paise`, so a TRUE "cost is ₹342"
   claim could never reconcile — A16's redaction contrast was unobservable. Added
   `cost_rupees` mirroring list/revenue.
2. The cost-redaction gate treated *omitted* `include_costs` as false (redact-by-default)
   while its own doc comment said "defaults true" — inverted default fixed to explicit
   `=== false`.
3. Gross-fabrication observability: with `orders_with_sku` (178) exceeding `units_sold`
   (140), the same-unit max was 178, so a fabricated "sold 500" slipped under
   3×178=534 and degraded to plain NUMERIC_MISMATCH — GROSS_FABRICATION was
   unreachable on the fixture. Redesigned fixture numbers (units 150 / orders 120)
   so both sides of the gate stay observable (A2 fires at 500 > 3×150; A2b stays
   recoverable at 300).

### Documented normalizations (registered in ARCHITECTURE.md §18)

Nine new register rows: unsupported-discount verdict (STRIPPED not FAILED), gross-gate
arithmetic correction, the money-relevance rule, unconditional claim amputation, the
discount-context short-circuit, dual-track zod/v3+v4, SDK 0.120 surface corrections,
ReplayTransport addressing contract, plus §19 checklist items resolved (SDK surface,
Zod pin). Two matrix-vs-pseudocode conflicts adjudicated toward recoverability — the
auditor strips narrative lies; policy stays with the gatekeeper.

### Gaps / deferred

- Live Anthropic calls untested against the real API (no key in CI); classification is
  tested via real SDK error instances, and DEMO_STABLE_MODE replay covers demo runs.
- Pack BUILDER (SQL/materialized views feeding EvidencePackEntry inputs) lands with
  persistence in M3 — tests use hand-built packs.
- Remaining three LLM agents: campaign-orchestrator, catalog-intelligence, explainer.

---

## M3 — Campaign orchestrator (LLM #2 of 4) — 2026-08-26

**The merchandising brain**: analytics opportunities → deterministic priority set →
per-entry rationales that cannot lie, per `docs/design/campaign.md`. This slice is the
pure domain + LLM seam; the analytics SQL layer and the scheduler cycle land with
persistence (M4) by plan — opportunities arrive hand-built from the doc's worked
examples today.

### Built

- **Schemas** (`shared/src/campaign/schema.ts`): dual-track zod — validation-only v3
  (`Opportunity` id regex `^opp_[a-z_]+_[0-9a-f]{10}$`, ≥2 metrics; `PriorityEntry`
  rationale min 20; `PrioritySet` content-bound `ps_v<version>_<8hex>` id, nullable
  `llm_invocation`; `LlmInvocation` counters incl. `from_cache`) plus the LLM-facing
  `RationalesOutputZ` on zod/v4 strictObject — `{rationales: [{entry_index: int ≥0,
  rationale_nl: 40..600}]}` is the model's ENTIRE output surface; it structurally
  cannot mutate actions/SKUs/weights. `CampaignAuditEvent` union (7 event types) also
  in shared.
- **Metric formatters + exact-set table** (`api/src/campaign/analytics/format.ts`):
  en-IN paise grouping, `units/day` rate formatter, weekday labels, and `METRIC_SETS` —
  each OpportunityType carries EXACTLY the metric keys its template quotes.
- **Pure derivation core** (`api/src/campaign/domain/derive.ts`): content-derived ids
  (`opp_<type>_<sha256[:10]>` over runId|type|sorted skus — reorder-invariant,
  idempotent republication), fixed ACTION_MAP, monotone clamped weight functions
  (§6.5 worked examples pinned: UNDER .44 / EXPIRY .71 / ATTACH .58 / TIMING .77),
  total-order assembly (weight desc → type tiebreak → id asc) with audited suppressions
  (SET_FULL at 8, SKU_ALREADY_CLAIMED), one-rounding weight emission, `buildPrioritySet`
  with `set_id = ps_v<n>_<md5(canonicalJson(set-without-id))[:8]>` and TTL-bounded
  `valid_until_sim`.
- **Prompt layer** (`api/src/campaign/llm/prompts.ts`): frozen system prompt (sha256
  pinned; quoting contract + index-addressed role; zero run data — freeze test proves
  the only datelike byte sequence is rule 4's sanctioned exemplar), user payload of
  `{entry_index, action, skus, weight, metrics}` lines carrying NO ids the model could
  echo wrongly, deterministic request body + sha256 replay-key over canonical JSON.
- **Live port** (`llm/live-claude.rationale.ts`): claude-opus-5 via `messages.parse` +
  `output_config: {format: zodOutputFormat(RationalesOutputZ)}`, adaptive thinking,
  ephemeral-cached system block, client `maxRetries: 0` — the ladder below is ours and
  test-visible.
- **Failure classification** (`llm/rationale.port.ts`): typed SDK errors → RETRYABLE /
  NON_RETRYABLE / PARSE_FAILED / CHAOS_FORCED (connection-timeout folded into
  connection-error before the base-class check).
- **Rationale runner** (`llm/rationale-runner.ts`): retry ladder (attempts=2, backoff
  500ms·2^n+jitter with injectable sleep/jitter for determinism), index-addressed
  attachment (first-wins on duplicates → NO_INDEX events with rejected text; missing
  indices → templated entry + NO_INDEX; out-of-range silently ignored), §10 outcome
  reconciliation — verified→FRESH, any verifier failure templates just that entry
  (PARTIAL_TEMPLATE), port-level failure keeps previous set EXCEPT seed time publishes
  an all-template set so demo beat 1 always has material — plus `LlmInvocation`
  telemetry on every publish.
- **Verifier** (`verify/rationale-verifier.ts`): Rule 1 completeness (every metric
  display present after normalization) before Rule 2 no-invention (every numeric token
  ∈ displays ∪ raw values ∪ entry weight). Normalizer strips SKU-like identifiers
  pre-lowercase (so KAJU_KATLI_250G contributes no phantom "250"), handles ₹ Indian
  grouping, unicode minus, subscripts, unit suffixes.
- **Templates** (`verify/template-rationales.ts`): per-type rationale quoting exactly
  METRIC_SETS — self-verifying by construction (U-9).
- **Stable-mode ports** (`llm/replay.rationale.ts`): record/replay keyed by request-body
  sha256; cache miss throws LOUD `StableModeCacheMissError` — never a silent live call.

### Tests — shared 51/51 · api 240/240 passing

- Worked-example weight goldens; monotonicity sweeps per type; clamp extremes (lift
  100 ⇒ exactly 1; dte 0 ⇒ max urgency); golden id vector + sku-reorder invariance;
  assembly ordering/conflict tiebreak/SET_FULL cap/shuffled-input determinism; set_id
  stability + sensitivity + regex.
- Verifier matrix U-4..U-9: honest rationales verify ∀4 types; percent-conversion
  ("46%" for "0.46x") rejected; EMPLOYEE50-style injection trips the digit scanner;
  dropped display ⇒ MISSING_METRIC; restating raw values tolerated; normalizer probes;
  all four templates self-verify.
- Prompt tests: hash stability + recompute, freeze discipline, payload id-freeness,
  byte-equality (U-14), body determinism, key sensitivity to payload AND model edits.
- Failure classification 9-row table with REAL SDK error instances (mirrors negotiation's
  suite); ladder call/sleep-count assertions incl. PARSE_FAILED single re-request and
  CHAOS break.
- §10 outcome matrix ×4 failure kinds × {previous exists ⇒ KEEP_PREVIOUS, seed ⇒
  TEMPLATE_ONLY}; poisoned-rationale containment (rejected text kept verbatim in the
  fallback event; templated replacement still self-verifies); index edges (missing/
  duplicate/out-of-range/null).
- Replay: record round-trip, hit byte-equality, loud miss, corrupt fixture, schema
  rejection of structurally-wrong fixtures, key sensitivity forcing exactly-one re-record.
- shared `campaign-schema.spec`: bounds + strictness on both zod tracks (39-char
  rationale rejected, negative index rejected, unknown keys rejected everywhere).

### Adversarial fixes caught by testing

1. **Positional DraftArgs mis-zip**: spec helpers built payloads by zipping assembly
   output against ALL_OPPS positionally — wrong the moment assembly reorders or
   suppresses. Caught as `entry_index: 0` carrying EGGLESS_LOAF with UNDERSELLING's
   metrics; replaced with a lookup-aligned `DRAFT_ARGS` fixture helper (the M3 cycle
   must construct args the same way).
2. **Fixture SKU collision**: the expiry example sat on KAJU_KATLI_250G, which AT-1's
   pair also claims — campaign.md's dataset uses E for both, but only ever as separate
   per-query SQL fixtures, never one assembled set. Our combined fixture suppressed
   ATTACH at assembly (weight .58 < .71) and broke eleven downstream expectations.
   Expiry moved to F=DRY_CAKE_ASSORTED; conflict semantics remain covered by dedicated
   synthetic U-11 tests.
3. **Inverted monotonicity sweep**: the U-1 probe walked velocity ratio ASCENDING while
   asserting non-decreasing weight — but lower underselling means LOWER weight. Sweep
   now walks descending, matching the property it names.

### Documented normalizations (registered in ARCHITECTURE.md §18)

Eight new register rows: string-valued context metrics, the EXACT-SET RULE (and
UNDERSELLING gaining stock_units), SKU-like identifier stripping in the verifier,
retry-ladder ownership, seed-time TEMPLATE_ONLY fallback, the TS↔PG set_id digest
coincidence, TIMING reusing PRIORITIZE_IN_BUNDLES, and the §15-A fixture de-conflict
adjudication.

### Gaps / deferred

- Analytics SQL layer (§5 queries, fingerprint/run_id emission) lands with Postgres
  persistence (M4) — opportunity fixtures are hand-built until then.
- `runCampaignCycle` composition (lock acquisition, DB reads/writes, audit sink wiring)
  deferred to M4 by plan; ports tested via stubs.
- Live Anthropic calls untested against the real API (no key in CI);
  DEMO_STABLE_MODE replay covers demo runs.
- Remaining two LLM agents: catalog-intelligence, explainer.

---

## M4 — Catalog-intelligence agent (LLM #3 of 4) — 2026-08-26

**The messy-text cleaner**: raw merchant catalog rows → clean marketing copy,
per `data-model-audit.md` §2.5 + negotiation.md §1.7's trust rule. The agent
with the smallest output surface and the strictest structural leash: everything it
writes lands in a table that physically has no commercial column.

### Built

- **Schemas** (`shared/src/catalog/schema.ts`): dual-track zod again — validation-only
  v3 `EnrichedSkuSchema` mirroring the catalog_enriched row WITH the two SQL CHECK
  constraints reproduced as superRefine (`ce_model_required`: ENRICHED ⇒ model +
  display_name; `ce_failed_has_reason`: FAILED ⇒ error_detail), so a TS write PG would
  reject fails at the seam. LLM-facing `EnrichmentOutputZ` on zod/v4 strictObject —
  prose + tags only; the sole number is confidence ∈ [0,1], which is not money.
- **Config** (`shared/src/catalog/config.ts`): closed occasion vocabulary
  {birthday, anniversary, diwali, rakhi, congrats}, field caps mirroring §2.5 columns,
  ladder knobs (attempts=2, backoff 500ms, injectable timing).
- **Pure normalizer** (`shared/src/catalog/normalize.ts`): PARTIAL ACCEPT policy —
  unknown occasions dropped + `UNKNOWN_OCCASION:<raw>` warning; pairings allow-listed
  against the merchant's real SKUs case-insensitively (canonical casing wins) with
  `PAIRING_NOT_IN_CATALOG`; tags lowercased/deduped/capped with `TAGS_TRUNCATED`;
  money-flavored prose flagged `MONEY_TOKEN_IN_COPY` but KEPT (no numeric column
  exists to feed — a loud warning beats silent mutation); model warnings ride through
  prefixed. Only blank display_name/description hard-reject → UNENRICHED path.
- **Prompt layer** (`api/src/catalog/prompts.ts`): frozen data-free system prompt
  (closed vocabulary + "NEVER mention prices" contract; zero seed-data examples after
  freeze-test caught the typo example leaking PSTRY-BSC's name). THE TRUST RULE AT THE
  SOURCE: `CatalogItemInput` carries sku/name_raw/description_raw/uom_raw/category_raw
  ONLY — cost, list price, stock, expiry are not fields, so no code path can transmit
  them. Deterministic request body + sha256 replay key.
- **Live port** (`live-claude.enrichment.ts`): one messages.parse per SKU
  (llm_calls.purpose='enrich_sku', offline — tx_id NULL), claude-opus-5, adaptive
  thinking, cached system block, client maxRetries: 0.
- **Port + classification** (`enrichment.port.ts`): same typed-error semantics as the
  campaign classifier (subclass-before-base, unknown ⇒ NON_RETRYABLE).
- **Batch runner** (`api/src/catalog/batch.ts`): per-SKU isolation — one SKU's failure
  never blocks siblings; retry ladder owned by us (PARSE_FAILED = exactly one
  re-request); every operational failure lands UNENRICHED + classified error_detail;
  telemetry counters for llm_calls rows.
- **Stable-mode ports** (`replay.enrichment.ts`): record/replay keyed by request-body
  sha256; LOUD cache-miss error, same contract as campaign.

### Tests — shared 59/59 · api 263/263 passing

- SQL-constraint mirrors: ENRICHED-without-model rejected, FAILED-without-reason
  rejected, UNENRICHED degraded row valid both bare and with reason; strict rejection
  of a smuggled `list_price_paise` key (the trust rule as a test).
- Normalizer branch coverage: clean pass-through zero-warning; rogue output degrades
  partially with every warning named; money token kept + flagged; blank display name
  hard-rejects; empty-catalog pairings never invented.
- Prompt tests: hash recompute, closed-vocabulary presence driven from CATALOG_CONFIG
  (not string-matched prose), fixture-leak prohibition, payload field whitelist (the
  six marketing keys exactly), sorted allowed_skus stability, key sensitivity to item
  AND model.
- Batch matrix: healthy batch counters, rogue-still-enriches, parse-fail→one
  re-request→success (parse_retries=1), transport exhaustion → UNENRICHED with
  classified detail, NON_RETRYABLE single-call abort with sibling unaffected,
  EMPTY_DISPLAY_NAME keeps raw_response for debug, backoff arithmetic with injected
  jitter (550ms).
- Replay: record round-trip, byte-equal hit, loud miss with key, corrupt fixture.

### Adversarial fixes caught by testing

1. **Seed data leaked into the frozen prompt**: rule 1 originally taught typo-fixing
   with "ButterScchop → Butterscotch" — literally PSTRY-BSC's raw name. The freeze-
   discipline test forbidding fixture strings caught it; example genericized ("correct
   obvious typos"), and the test now also forbids the corrected form.
2. **CATALOG_CONFIG imported from the wrong module** in normalize.ts (schema.ts
   re-exported nothing) — TS2459 at build, fixed to import from config.ts.

### Documented normalizations (registered in ARCHITECTURE.md §18)

Five new register rows: UNENRICHED-vs-FAILED semantics, post-hoc enforcement of the
closed vocabulary, flag-don't-strip money prose, trust-rule-at-the-source input shape +
case-insensitive pairing allow-listing, and SQL CHECK constraints mirrored as superRefine.

### Gaps / deferred

- DB writes (status transitions on catalog_enriched) land with Postgres persistence —
  outcomes are pure values today.
- The seeded degraded row (one UNENRICHED SKU with error_detail) is written by the
  M6 seed scripts using this runner.
- Live Anthropic calls untested against the real API (no key in CI).

---

