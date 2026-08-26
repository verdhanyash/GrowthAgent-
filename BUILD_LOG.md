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

## M5 — Explainer-agent (LLM #4 of 4) — 2026-08-26

**The audit narrator**: gatekeeper trace → human-readable narrative, per
frontend-events.md §4.4.6's narration constraint. The agent whose output is
pure prose, which is exactly why its contract is the most defensive in the
codebase: everything it writes is typed `non_authoritative: true` at the TYPE
level, and when anything goes wrong it ships NOTHING.

### Built

- **Schemas** (`shared/src/explainer/schema.ts`): `ExplanationNarrativeSchema`
  (v3, `.strict()`) carries `non_authoritative: z.literal(true)` — an
  authoritative-looking explanation is a TYPE error, not a convention.
  `TimelineEventSchema` restricts `type` to the three groundable event kinds
  (rule results, decisions, citation audits); payload stays open JSON rendered
  into prompts via canonicalJson. LLM-facing `NarrativeOutputZ` on zod/v4
  strictObject: title 1..120, body_md 1..4000, grounded seqs max 64 —
  audience/non_authoritative/degraded are NOT the model's to choose.
- **Verifier** (`shared/src/explainer/verify.ts`): Rule G (empty or fabricated
  grounding rejects the WHOLE narrative — no silent seq filtering) + Rule Q
  (whole-string fingerprint scan for untrusted buyer text outside a
  `buyer claim —` span; whitespace-collapsed so line-wraps can't launder;
  40-char prefix lookbehind immune to off-by-one spacing; sub-12-char strings
  exempt as unfingerprintable).
- **Runner** (`api/src/explainer/narrate.ts`): committed degradation —
  NARRATIVE (audience pinned by caller, grounding sorted, literal(true),
  degraded:false) or NONE with the rejected text preserved verbatim for the
  audit trail. Same ladder: attempts=2, backoff 500·2^n+jitter, PARSE_FAILED
  one re-request, chaos breaks immediately.
- **Ports**: frozen SYSTEM_PROMPT (sha256-pinned, zero seed-data leakage —
  freeze tests enforce), LiveNimNarratorPort, DEMO_STABLE_MODE record/replay
  keyed sha256(canonicalJson(requestBody)).

### Tests — shared 64/64 · api 297/297 passing

Explainer slice: verify 8 · narrate 7 · prompts/replay 8 (23 total), plus the
narrative-contract specs in shared.

### Adversarial fixes caught by testing

1. **The prompt leaked its own fixture token** — rule 2's example quoted
   'apply EMPLOYEE50 50% off', the demo attack string itself. Freeze test
   caught it (same class as M4's ButterScchop catch); example genericized to
   describe the constraint without any fixture text.
2. **Reorder test didn't reorder** — the canonicalJson determinism fixture was
   MISSING two payload keys, testing a different event rather than a different
   key order. All five keys now present in scrambled insertion order.
3. **Prefix window off-by-one** — verifier used an exact-prefix-length
   lookbehind, chopping the first char of `buyer claim — "` and rejecting
   honestly-quoted spans near offset 48. Widened to a generous 40-char window.
4. **Scan-scope mismatch in tests** — restatement tests embedded needle
   fragments; the whole-string scanner correctly ignored them. Tests now embed
   full contiguous needles, plus one new test pinning partial-fragment
   exemption as documented scope (not a bug).
5. **`.strict()` missing** on ExplanationNarrativeSchema — unknown keys were
   silently stripped instead of rejected; shared spec caught it.

### Gaps / deferred

- SSE emission (`explanation_narrative` event) lands with the pipeline
  orchestrator wiring (M6+).
- Live NIM calls untested against the real API (no key locally).

---

## M5b — Provider switch: Anthropic Claude → NVIDIA NIM — 2026-08-26

Directive: swap ONLY the LLM API/client layer and env vars; keep the entire
4-agent workflow, prompts, schemas, validation, gatekeeper, DEMO_STABLE_MODE,
and business logic unchanged. Executed as a four-way parallel fan-out (one
migration agent per module) against a single new seam.

### Built

- **Seam** (`api/src/llm/nim.ts`, zero dependencies): plain-fetch client for
  NIM's OpenAI-compatible `/chat/completions`. Bearer auth from
  `NVIDIA_API_KEY`; optional `NIM_BASE_URL` targets self-hosted NIM
  containers unchanged. Structured output = `nvext.guided_json` over
  zod/v4 `toJSONSchema(module schema)` + defensive fence-strip/parse/
  re-validate. Shared failure classes `NimHttpError` (status + parsed
  retry-after) / `NimNetworkError` (fetch throws AND timeout aborts) with
  `classifyNimTransport`: {408,409,429,≥5xx,network} retryable; other 4xx +
  unknown → NON_RETRYABLE. One-shot calls — module ladders keep owning retries.
- **Model id**: `meta/llama-3.3-70b-instruct` across all four agents
  (single-model stance preserved); lives in shared configs / module consts.
- **Migrations** (all preserving ladder constants, port contracts, and
  PARSE_FAILED/CHAOS_FORCED semantics):
  - negotiation: `transport.live.ts` → `transport.nim.live.ts` (12s wall
    budget intact; repair turn appends assistant+user messages; chaos hooks
    throw seam-native errors) + `mapStopReason` translating NIM finish reasons
    (`length`→max_tokens, `content_filter`→refusal) so stage.ts stays
    provider-neutral.
  - campaign: `live-nim.rationale.ts`; classify now delegates to the shared
    taxonomy (aligned across modules after initially hand-rolling).
  - catalog: `live-nim.enrichment.ts`; batch.ts untouched.
  - explainer: `live-nim.narrator.ts`; SYSTEM_PROMPT byte-identical (freeze
    tests still green).
- **Removed** `@anthropic-ai/sdk` from api/package.json (+lockfile). No
  dependency added in its place — Node's global fetch covers it.
- **Env**: `.env.example` ANTHROPIC_API_KEY → NVIDIA_API_KEY (+NIM_BASE_URL).

### Tests — shared 64/64 · api 297/297 · lint clean

Classification coverage grew (campaign table 10→13 rows: explicit
404/422/418→NON_RETRYABLE pins; negotiation added 408/409 rows). All model-id
and error-fixture assertions swapped to seam equivalents WITHOUT weakening.

### Adjudications (registered in §18)

1. Guided decoding constrains but never guarantees — validation never skipped.
2. Prompt-cache telemetry (`cache_control`, `cache_read_input_tokens`) has no
   NIM equivalent: discipline kept (it stabilizes replay keys), telemetry reads
   absent — honest flag, not faked.
3. Adaptive-thinking summaries gone with opus-5: `thinking_summary` field kept,
   always "" (shape stability over capability pretense).
4. Stop-reason translation lives IN the transport, not stage.ts.
5. Replay keys shift by design (model id changed) — recordings are regenerated
   at next `demo:record`.

### Gaps / deferred

- docs/design/*.md corpus intentionally untouched (design-time snapshot);
  divergences live in §18 rows, per standing practice.
- A live smoke call against integrate.api.nvidia.com needs NVIDIA_API_KEY.

## M6 — Settlement module (`api/src/settlement/`) — 2026-08-26

The deliberately-dumb money rail per docs/design/settlement.md: AI proposed the
cart everywhere upstream, ONE deterministic pipeline settles exactly those
frozen bytes. Zero LLM. First DB-touching module of the repo — everything M1–M5
was pure.

### Built

- **Schema** (`api/migrations/V7__settlement.sql`, first migration ever):
  transactions (12-state CHECK, frozen `proposal_bytes` + digest,
  BIGINT paise), inventory (Model-A hold counters + table-level CHECK),
  stock_reservations (UNIQUE(tx_id,sku) — resurrection reuses rows),
  identity_velocity (per-identity-per-day ledger), razorpay_orders
  (INTENT/CREATED/AMBIGUOUS lifecycle), processed_webhook_events (insert-first
  dedupe + payload bytes for W6 redrive), completed_sales, idempotency_keys.
  Plus `db/client.ts`: pool factory + file-ordered transactional migration
  applier tracked in schema_migrations.
- **State machine**: T1…T13 authority TABLE as data; every state write goes
  through `casTransition()` (single guarded UPDATE, timestamp column stamped by
  arrival state, pay_id bound on T7). Illegal pairs AUDITED
  (`illegal_transition_attempt`); legal-but-lost races reported distinctly.
- **Reservation core** (`reserve.ts`): whole-cart-in-one-transaction with the
  conditional-UPDATE guard (`stock_qty - reserved >= q`) as the only way
  reserved ever grows; lexicographic SKU ordering kills deadlocks;
  identity_velocity upsert closes the TB-2b TOCTOU under row lock; release is
  a status-CAS noop-on-retry; `reReserveExpiredHolds` flips the tx's own
  EXPIRED holds back ACTIVE for the grace ladder (UNIQUE(tx_id,sku) forbids
  fresh inserts).
- **Idempotency layer 1** (Redis SET NX PX + finalize-only Lua; DONE snapshots
  never overwritten) with durable PG twin. Fail-closed on Redis loss:
  degraded PG replay if one exists, else 503 — never process unmarked money
  POSTs. Verbatim replay + `Idempotency-Replayed: true`; key+body mismatch 422.
- **Idempotency layer 2** (`ensure-order.ts`): claim-first CAS into
  ORDER_CREATING; intent row persisted BEFORE the network call; deterministic
  receipt = fn(tx_id) so crash windows W3/W4 resolve through the SAME receipt —
  provider-saw-it ambiguity surfaces as DuplicateReceiptError → AMBIGUOUS +
  ops event, never a blind third attempt.
- **settle()**: digest re-check over frozen bytes → T1 insert (ON CONFLICT →
  409 TX_ALREADY_SETTLED) → reserve or RELEASED-refuse → order-create with
  retryable-degradation (503, holds retained) vs hard-fail (T5 release +
  FAILED).
- **Webhook ingress** (`webhook-handler.ts`): raw-body parser mounted FIRST;
  authenticate (HMAC over exact bytes, V7) before parsing anything;
  freshness gate; insert-first dedupe two-phase RECEIVED→PROCESSED (crash can't
  swallow an event — sweeper redrives); ALWAYS 2xx once authenticated (V8/V9).
  onCapture triple-match (amount/currency/receipt) + frozen-bytes re-hash +
  armed-provider check BEFORE any state move; mismatch ⇒ MANUAL_REFUND_REQUIRED
  + inbox item, never auto-complete. payment.failed ⇒ T8 + instant hold
  release. Late capture ⇒ §10.3 ladder T10 (grace re-reserve) / T11 (refund).
- **Completion** (`completion.ts`): PAID→COMPLETED latch inside one
  transaction; holds→sold moves all-guarded; committed units reconciled
  against the FROZEN proposal lines — a short/vanished hold set aborts the
  latch-open commit for sweep retry instead of silently booking a sale.
- **Sweeper** (`sweeper.ts`): TTL pass pair (tx flip decoupled from counter
  release) + reconciliation ladder W1–W7: resume reserve/order-create,
  same-receipt INTENT retry (+W5 healing of CREATED-with-lagging-state),
  RECEIVED-event redrive via the shared dispatch core, PAID completion drive.
- **Providers**: MockProvider signs REAL envelopes through the shared
  builder/HMAC path (dogfooding; no mock bypass) and mails them over real
  loopback HTTP in tests; razorpay adapter (Basic-auth REST createOrder +
  verifyAndParseWebhook delegation) built to the same narrow two-method seam,
  TEST_MODE boot-asserted fail-closed.
- **HTTP surface** (`routes.ts`): POST /v1/tx/settle (json → idempotency gate →
  SettleRequest schema), GET /v1/tx/:tx_id, POST /webhooks/razorpay (raw),
  typed-error mapper last. `buildSettlementApp()` is the composition root the
  pipeline milestone reuses as-is.
- **Audit seam** (`api/src/audit/writer.ts`): structured events through one
  sink; MemoryAuditSink for tests/SSE later.

### Tests — api 356/356 across 29 files · lint clean · tsc clean

Settlement adds 59 tests in 5 suites: sign/parsing 16 (pinned V10/V11 shapes,
rotation, length-burn compare, PARSE_FAILED-vs-auth separation), state machine
9 (full 12×12 pair enumeration against table AND DB CAS, rerun-idempotence,
vanished-hold atomicity), reserve 12 (20-worker last-unit race, velocity race
ceilings, fast-check invariant property over randomized interleavings, TTL +
grace-row reuse), idempotency 8 (layer-1 semantics incl. TTL reuse + degraded
replay; W3 same-receipt retry; AMBIGUOUS no-blind-retry; concurrent claim
election), integration 14 (full HTTP loopback happy path, replay/burst/distinct
-races, duplicate event, chaos→sweep recovery on SAME receipt, stale letters,
loopback-vs-direct equivalence, T10/T11 end-to-end).

The suite earned its keep immediately — five production bugs caught & fixed
pre-commit: missing T4b advance (happy path could never reach AWAITING_PAYMENT);
`RETURNING DISTINCT` invalid SQL; BIGINT-as-string vs numeric wire amount
(flagged every honest capture as a mismatch); SELECT/alias key mismatch behind
a type cast (same effect); velocity FIRST-insert bypassing both ceilings.

### Adjudications

1. `digestView` convention: proposal_sha256 binds every frozen byte EXCEPT
   itself (field participates as ""); producer and verifiers hash that view.
2. MANUAL_REFUND_REQUIRED edges granted to every stock/payment-holding state
   (§8.3 tamper path vs §6 T-table gap); PROPOSAL_APPROVED excluded — nothing
   to refund there.
3. processed_webhook_events carries the authenticated payload bytes (beyond
   spec sketch) so W6 redrive re-dispatches without re-trusting headers (U4).
4. Sweeper lane 3 widened to CREATED-with-lagging-state rows (W5 healing rides
   the same-receipt lane).
5. Audit hash-chain (seq/prev_hash/verify) deferred to the pipeline milestone —
   vocabulary final now, chain not yet.
6. HUMAN_ESCALATION re-entry refuses 501 ESCALATION_REENTRY_NOT_WIRED until the
   approvals inbox lands (consumeApprovalToken seam already in SettleDeps).
7. Velocity ceilings fully enforced at commit-time but buyer-identity wiring
   arrives with the pipeline; absent input ⇒ no ledger increment.
8. transactions owns its slice: TEXT ULID tx_id + TEXT CHECK state vocabulary
   (no PG enum) for cheap evolution.

### Gaps / deferred

- Razorpay TEST_MODE adapter never spoke to the live API (no keys locally) —
  error-code heuristics marked U2 stay heuristic.
- AMBIGUOUS-order adoption via fetch-by-receipt (U1 ⚠️) unimplemented; ops
  inbox path stands.
- SSE fan-out of audit events to the web trace is a later module's wire-up.

## M7 — Pipeline orchestrator (`api/src/pipeline/`) — 2026-08-27

The spine that runs a proposal end-to-end: INTAKE → CONTEXT_BUILD →
CAMPAIGN_INJECT → NEGOTIATE → CITATION_AUDIT → GATEKEEPER → (SETTLE | ESCALATE |
DECLINE) → EXPLAIN, over the pure gatekeeper and the real settlement rail. Every
LLM stage proposes; the deterministic gate disposes.

- **`orchestrator.ts`** (`runPipeline`): claims `proposal_txs` on a unique tx_id
  (`ON CONFLICT DO NOTHING` → `PipelineAlreadyRunError`, so replays never
  re-enter), walks the stages behind a `RunCtx` that stamps `stage`/`updated_at`
  per transition, and finishes into one of four terminal `outcome_json` shapes.
  `resumeAfterApproval`/`rejectAfterRejection` re-enter from the approvals inbox.
- **Audit hash chain** (`audit-chain.ts`): the deferred-from-M6 seq/prev_hash
  chain — `append` links each row to the GLOBAL predecessor; `tailFor(txId,
  afterSeq)` replays one tx's durable history; `verify` walks global OR per-tx.
- **Event fabric** (`emitter.ts` + `bus.ts`): `PipelineEmitter.emit` validates
  payloads against the shared taxonomy ON WRITE, persists through the chain,
  publishes durable envelopes on the in-process `TraceBus` (per-tx + admin
  channels); ephemeral events are bus-only (no seq, no SSE id). Pure frame
  formatters (`formatDurableFrame`/`formatEphemeralFrame`/`formatCommentPing`)
  make the wire shape unit-testable without a socket. `ChainedAuditSink` bridges
  settlement's synchronous `appendAudit` onto the one true chain.
- **Injection tagger** (`tagger.ts`): heuristic scan of the untrusted note; a
  suspected hit emits `injection_flagged` and drives the ESCALATE path.
- **Evidence + cart** (`evidence.ts`, `cart-adapter.ts`): deterministic pack the
  model may only cite from (R1 integrity), and the adapter that turns an
  approved proposal into the settleable cart the money rail consumes.
- **Approvals** (`approvals.ts`, V8 `approvals` table): freeze the proposal into
  a PENDING inbox row with band context + gate trace; token-guarded resolve.

### Tests — 8 pipeline suites incl. the 316-line end-to-end integration spec

Full-stack runs over real Postgres: honest APPROVE→AWAITING_PAYMENT with stock
held, DECLINE on exhausted velocity (real reasons recorded), ESCALATE on an
injection note (cart frozen into the inbox), plus chain verify, bus ordering,
tagger, evidence, and cart-adapter units.

## M8 — Buyer-facing HTTP/API layer (`api/src/http/`) — 2026-08-27

The public surface an autonomous buyer agent talks to. Async-job POST → detached
pipeline → poll/SSE, all riding the M7 orchestrator and M6 settlement rail
underneath. The HTTP layer never writes `proposal_txs` (the pipeline claims it)
nor `transactions` (settle owns it) — it owns exactly three tables (V9).

- **Auth** (`auth.ts`): `X-Agent-Key` (or `Bearer` alias) → sha256 → indexed
  lookup on `agent_identities.api_key_hash`, revocation re-checked every request;
  `requireAgent(db, role)` attaches `req.agent`.
- **POST /v1/carts/proposals** (`proposals.route.ts`): validate →
  `reqHash = sha256(canonicalJson(body))` → claim `proposal_idempotency`
  (unique `(agent_id, key)`) which MINTS the tx_id in the same statement →
  enqueue `runPipeline` detached → 202. A same-key same-body replay returns the
  SAME tx_id (`idempotent_replay:true`); same-key different-body is 409
  IDEMPOTENCY_CONFLICT; an `Idempotency-Key` header that disagrees with the body
  is 400.
- **GET /v1/carts/proposals/:txId**: ownership resolves on
  `proposal_idempotency` (written SYNCHRONOUSLY in the POST), NOT `proposal_txs`
  (claimed async) — so a poll that races ahead of the pipeline reports PROPOSING
  instead of a spurious 404; foreign/unknown → uniform 404 (no existence
  oracle, E-13). Terminal projection reshapes each stored `outcome_json` into
  the §5.2 union: APPROVED lazily mints the signed mandate + settlement info,
  DECLINED surfaces reasons, ESCALATED loads the approval row (rules_version
  from `frozen_proposal.gatekeeper.ruleset_version`), FAILED synthesizes a stage.
- **MandateBuilder** (`mandate-builder.ts`): NO numeric field from an LLM —
  `subtotal` from RAW GT list prices, `total` from `transactions
  .approved_total_paise` (authoritative), signed with the merchant HMAC and
  SELF-VERIFIED before shipping; persisted once so nonce/expires_at stay stable.
- **SSE** (`stream.route.ts`, `stream-ticket.ts`): `POST /v1/stream-tickets`
  mints a 60s `{agent_id,tx_id}`-bound ticket (browsers can't header-auth
  EventSource); `GET /v1/stream/:txId` authenticates by ticket OR X-Agent-Key,
  enforces ownership BEFORE the SSE upgrade, then runs the race-free connect
  sequence — subscribe FIRST → replay durable history after Last-Event-ID →
  drain what buffered (dedup by seq) → forward live, with a 15s comment-ping
  heartbeat and a ~1s `outcome_json` poll that closes the stream on terminal.
- **Composition** (`app.ts`, `server.ts`): `buildApiApp` wires requestContext →
  (optional webhook raw router, reused from settlement) → buyer routes → stream
  routes → `jsonNotFound` → the single `apiErrorRenderer`. `server.ts` is the
  guarded listen root; the orchestrator now persists `rules_version` on
  `proposal_txs` at the gate so every terminal poll can report it.

### Tests — api 424/424 (10 new HTTP integration tests) · tsc clean

Real-stack loopback fetch against the actual pipeline (only the negotiation
transport stubbed): POST→poll→signed-mandate happy path, idempotency
replay/conflict, missing/unknown-key 401s, cross-agent 404, DECLINE + ESCALATE
terminal projections, stream-ticket mint + verify, and the SSE replay-to-close
lifecycle.

### Gaps / deferred

- `server.ts` mounts the buyer surface only; the settlement webhook router is
  reusable via `buildApiApp({webhook})` but not wired into the standalone listen
  (settlement runs its own app today) — flagged for the deploy/demo milestone.
- groundTruth/rules/priorities are wired to the static Meera fixtures at the
  composition root; DB-backed catalog/rules loading is a later wire-up.
- Admin + demo-control routes (api-contract §1 rows 6–18) remain deferred.


