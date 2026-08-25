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

