# GrowthAgent — Project Plan (what's next)

_Last updated: 2026-08-29. Companion to [`README.md`](README.md),
[`ARCHITECTURE.md`](ARCHITECTURE.md) and [`BUILD_LOG.md`](BUILD_LOG.md)._

---

## 1. Where we are

The backend is **complete and tested through M8** and security-hardened:

| Milestone | Module | State |
| --- | --- | --- |
| M1 | Gatekeeper (pure fn, 16 rules) | ✅ done |
| M2–M5 | 4 LLM agents (negotiation, campaign, catalog, explainer) | ✅ done |
| M5b | LLM provider → NVIDIA NIM | ✅ done |
| M6 | Settlement rail (Razorpay + mock, webhooks, CAS state machine) | ✅ done |
| M7 | Pipeline orchestrator (INTAKE → … → EXPLAIN) | ✅ done |
| M8 | Buyer-facing HTTP/API layer (async proposals, poll, SSE, mandates) | ✅ done |
| — | Security hardening (P1, P2-guard, P2-full, P4, P8, P10) | ✅ done |
| **M9** | **React dashboard** | ⬜ **skeleton only — next** |
| M10 | Admin + demo-control routes, deploy wiring, demo script | ⬜ deferred |

`web/` today is just `App.tsx` / `main.tsx` / `index.css`. **Building the
dashboard is the critical path to a demoable product.**

---

## 2. Recommended path (in priority order)

### M9 — Frontend dashboard (the demo surface) ⬅ do this next

The whole point of the "deterministic gatekeeper" thesis is *visible*
auditability. The dashboard is where a judge watches an AI propose a bold move
and a deterministic gate approve/decline/escalate it in real time.

Build three screens, all fed by the existing SSE projection of the audit log:

1. **TraceScreen** — live transaction feed. Subscribe to
   `GET /v1/stream/:txId`, render each audit event as it arrives: stage
   started/completed, per-rule `gatekeeper_rule_result`, the `injection_flagged`
   red banner (quote `matched_snippets`, show `customer_note_preview` as
   context only — see the P8 hardening), `escalation_created/approved/rejected`,
   `degraded`, and the final `explanation_narrative`.
2. **RulesScreen** — the 16 gatekeeper rules as a static reference, and per-tx,
   which rule fired and why (`GK-DISCOUNT-CAP`, `MARGIN_FLOOR_BLENDED`, …). This
   is what makes "deterministic" legible: same inputs → same verdict, always.
3. **ProposalComposer / BuyerView** — drive a new transaction:
   `POST /v1/carts/proposals` → poll `GET /v1/carts/proposals/:txId` (or mint a
   stream ticket and watch live) → render the signed CartMandate on APPROVE, the
   reasons on DECLINE, the human-approval modal on ESCALATE.

**Shared hook:** `useTransactionStream(txId)` — owns the `EventSource`
lifecycle: mint a stream ticket (`POST /v1/stream-tickets`, browsers can't
header-auth EventSource), connect with `Last-Event-ID` resume, dedup by `seq`,
close on terminal. This is the single most reused piece — build it first.

**Contract source of truth:** import event/response schemas from
`@growthagent/shared` (they already exist and the API is validated against
them). Do **not** re-hand-type them in `web/`. `docs/design/frontend-events.md`
is the rendering spec (21 event names, durability classes, the injection-banner
rules).

**Recommended stack for M9** (already scaffolded in `web/package.json`):

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | React 18 + Vite 6 | already installed; fast HMR |
| Styling | Tailwind 3 | already installed; fast to build dense dashboards |
| Types/validation | `@growthagent/shared` (Zod) | one contract, api + web share it |
| SSE | native `EventSource` | server already speaks SSE with resume |
| Server state | **TanStack Query** (add) | poll/refetch + cache for the REST calls |
| Routing | **React Router** (add) | 3 screens; deep-linkable `/tx/:id` |
| Charts (optional) | Recharts / lightweight SVG | if you show the 90-day sales curve |

Keep client state minimal — the audit log is the source of truth; the UI is a
projection. Avoid Redux; `useState` + TanStack Query is enough.

**Dev proxy:** point Vite at the api so `EventSource` and `fetch` share an
origin (avoids CORS + eases cookie/ticket handling). Add to `web/vite.config.ts`:

```ts
server: { proxy: { "/v1": "http://localhost:3000", "/webhooks": "http://localhost:3000" } }
```

### M10 — Admin + demo-control routes (deferred from M8)

`api-contract.md` §1 rows 6–18 enumerate admin/demo-control endpoints that are
still unbuilt (reset demo, re-seed, advance sim clock, revoke agent keys). These
make the live demo *repeatable* — a judge can hit "reset" between runs. Guard
them with the existing loopback + `X-Admin-Token` pattern (`ADMIN_TOKEN`).

### M11 — Deploy / demo wiring

- Wire the settlement webhook router into the standalone `server.ts` listen
  (`buildApiApp({webhook})` exists but isn't mounted — flagged in M8 gaps).
- Move catalog/rules/priorities from static Meera fixtures at the composition
  root to DB-backed loading.
- Build the `DEMO_STABLE_MODE` fixture set (recorded NIM responses + recorded
  signed webhooks) so the demo runs deterministically offline. `fixtures/
  manifest.json` pins each fixture's sha256; boot fails closed on mismatch.
- Write the actual **demo script** (the 3-minute judge walkthrough).

---

## 3. Remaining security backlog

From the 2026-08-27 audit — none are money-integrity holes; the core path is
sound (see [`ARCHITECTURE.md`](ARCHITECTURE.md) and the audit memory). Do these
opportunistically, ideally alongside the milestone that touches the same code:

| Item | What | When |
| --- | --- | --- |
| P3 | Gatekeeper discount-provenance rule (17th rule: discount>0 + `NEGOTIATION_CONCESSION` + no `campaign_priority_id` → ESCALATE) | needs sign-off — mutates the audited 16-rule registry + golden traces; must stay **pure** |
| P5/P6 | Per-agent settle idempotency scoping; stream-ticket revocation recheck on connect | with M10 |
| P7 | Wrap `buildContext(input)` in the per-rule fail-closed try/catch | quick; verify it isn't already covered at the pipeline level |
| P9 | docker-compose bind to `127.0.0.1` + generated creds | with M11 deploy |
| Arch | CartMandate symmetric HMAC → **Ed25519** asymmetric | larger — spans shared + web + api key distribution; only if time allows |

---

## 4. How to configure everything (end to end)

**1. Install & bring up infra**

```bash
npm install
cp .env.example .env
npm run db:up          # Postgres 16 on :15432, Redis 7 on :16379
```

**2. Choose a run mode in `.env`**

- _Fastest demo, no external accounts:_ `RAZORPAY_PROVIDER=MOCK`,
  `DEMO_STABLE_MODE=true`, `NVIDIA_API_KEY=` blank. The mock provider signs its
  own webhooks through the **real** verification path; LLM calls replay from
  fixtures. Fully offline and deterministic.
- _Live LLM, mock payments:_ set `NVIDIA_API_KEY`, keep `RAZORPAY_PROVIDER=MOCK`,
  `DEMO_STABLE_MODE=false`.
- _Live Razorpay test mode:_ `RAZORPAY_PROVIDER=TEST_MODE` **and** set all three
  `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET`. Boot fails closed if the
  provider/keys combo is inconsistent.

**3. Set the guards** (required, no safe defaults in prod):
`ADMIN_TOKEN` and `APPROVAL_TOKEN_SECRET` (≥ 32 bytes). Under
`NODE_ENV=production` the server refuses to start with dev/unset secrets.

**4. Run**

```bash
npm run build                    # shared + api
npm run dev -w @growthagent/api  # api on :3000 (migrations apply on boot)
npm run dev -w @growthagent/web  # dashboard (Vite) once M9 lands
```

**5. Verify**

```bash
npm run typecheck && npm run test   # test needs db:up
```

---

## 5. First concrete step

Build `web/src/hooks/useTransactionStream.ts` against
`@growthagent/shared` + `docs/design/frontend-events.md`, then the TraceScreen
that renders it. Everything else in M9 hangs off that hook. Keep the per-module
cadence: build → test → a built/tested/gaps summary before starting the next.

