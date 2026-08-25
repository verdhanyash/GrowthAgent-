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
