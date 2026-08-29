# GrowthAgent

**Autonomous AI growth system with ONE deterministic gatekeeper.**
Built for the Razorpay AI Buildathon — Track: AI Growth & Agentic Commerce.

GrowthAgent runs the growth loop for a demo merchant, *Meera's Cakes* (a home
bakery, ₹ in integer paise, 90 days of seeded synthetic sales). Four LLM agents
propose boldly — negotiation, campaigns, catalog intelligence, buyer-facing
explanation — but **every rupee of money movement passes through a single
deterministic, non-LLM gatekeeper pure function.** No number an LLM emits ever
reaches a money field: the gatekeeper recomputes and caps amounts from raw price
lists, and only an HMAC-verified webhook can move a transaction to `PAID`.

> Core philosophy: **AI proposes everywhere; one auditable gate decides.**

---

## Architecture at a glance

```
buyer agent ──HTTP──▶ INTAKE ─▶ negotiation ─▶ catalog ─▶ campaign ─▶ ┌───────────┐
                                                (4 LLM agents)        │ GATEKEEPER│  pure fn
                                                                      │ 16 rules  │  no IO/LLM/clock
                                                                      └─────┬─────┘
                                                    APPROVE / DECLINE / ESCALATE
                                                            │
                                              settlement rail (reserve stock →
                                              Razorpay order → webhook → PAID)
                                                            │
                          every stage appends to a hash-chained audit_log,
                          projected 1:1 to the frontend over SSE (seq = SSE id)
```

Full design lives in [`ARCHITECTURE.md`](ARCHITECTURE.md) (master synthesis) and
[`docs/design/`](docs/design/) (seven canonical subsystem specs). The
module-by-module build history is in [`BUILD_LOG.md`](BUILD_LOG.md).

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Language / runtime | TypeScript (ESM), Node **≥ 22** |
| Monorepo | npm workspaces — `shared/` · `api/` · `web/` |
| Shared contracts | **Zod** schemas + types, imported by both `api` and `web` |
| API | Express 4, `pg` (Postgres), `ioredis`, `pino` logging |
| Datastore | **Postgres 16** (system of record) + **Redis 7** (idempotency / locks) |
| LLM | **NVIDIA NIM** — `meta/llama-3.3-70b-instruct`, grammar-constrained JSON |
| Payments | **Razorpay** test-mode Orders API + HMAC webhooks (mock provider by default) |
| Frontend | React 18 + Vite 6 + Tailwind 3 *(in progress — see the plan)* |
| Tests | **Vitest**, `fast-check` (property tests); real Postgres/Redis via compose |

---

## Repository layout

```
shared/   @growthagent/shared — ALL zod schemas + shared types
api/      @growthagent/api — the backend monolith
  src/
    gatekeeper/   the pure deterministic decision fn (no IO/LLM/clock)
    negotiation/  campaign/  catalog/  explainer/   the four LLM agents
    llm/          NVIDIA NIM transport seam
    settlement/   providers, stock reservation, webhooks, CAS state machine
    pipeline/     end-to-end orchestrator (INTAKE → … → EXPLAIN)
    http/         buyer-facing API: auth, proposals, poll, SSE, mandates
    db/           pool + versioned SQL migrations (migrations/V*.sql)
    audit/        hash-chained append-only log writer
  migrations/     V7 settlement · V8 pipeline · V9 api · V10/V11 hardening
web/      @growthagent/web — React dashboard (skeleton today)
docs/design/   seven subsystem specs + red-team hardening notes
```

---

## Quick start

**Prerequisites:** Node ≥ 22, Docker (for Postgres + Redis). An NVIDIA NIM API
key is only needed for *live* LLM calls — the app runs against the mock payment
provider and can replay recorded LLM responses without one.

```bash
# 1. install (workspaces resolve together from the root)
npm install

# 2. configure — copy the template and fill in what you need
cp .env.example .env

# 3. bring up Postgres + Redis (mapped to host ports 15432 / 16379)
npm run db:up

# 4. build shared + api, then run the api (migrations apply on boot)
npm run build
npm run dev -w @growthagent/api      # tsx watch on src/server.ts

# frontend (once built out)
npm run dev -w @growthagent/web      # Vite dev server
```

### Configuration (`.env`)

Everything is driven by `.env` (see [`.env.example`](.env.example) for the full,
commented list). The load-bearing knobs:

| Var | Purpose |
| --- | --- |
| `RAZORPAY_PROVIDER` | `MOCK` (default; keys must be **absent**) or `TEST_MODE` (both keys required). Selection is **explicit** — boot fails closed on an inconsistent combo. |
| `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET` | Razorpay test-mode credentials + webhook HMAC secret. |
| `NVIDIA_API_KEY` / `NIM_BASE_URL` | NIM auth; base URL defaults to the hosted API, override for a self-hosted container. |
| `DEMO_STABLE_MODE` | `true` swaps LLM transports for recorded replay (deterministic demos); validators/gatekeeper are never relaxed. |
| `DATABASE_URL` / `REDIS_URL` | Point at the compose stack (defaults match `docker-compose.yml`). |
| `ADMIN_TOKEN` | Loopback admin-plane guard (constant-time compared). |
| `APPROVAL_TOKEN_SECRET` | HMAC secret for single-use human-approval capability tokens. |
| `SIM_NOW` / `DEFAULT_SEED` | Simulation clock anchor + PRNG seed for reproducible synthetic data. |

> **Security note:** under `NODE_ENV=production` the server refuses to boot with
> dev/unset signing secrets or an unset provider — the fail-closed guard from
> commit `f737ecc`. Never commit a real `.env`.

---

## Development

```bash
npm run typecheck        # tsc --noEmit across all workspaces
npm run test             # vitest run across all workspaces (needs db:up)
npm run lint             # eslint
npm run db:down          # tear down the compose stack
```

Integration tests run against a **real** Postgres + Redis (via
`docker-compose`), not mocks — start the stack with `npm run db:up` first.

---

## Status

Backend complete through **M8** (buyer-facing HTTP/API layer) and security-
hardened. The React dashboard is the next milestone. See
[`PROJECT_PLAN.md`](PROJECT_PLAN.md) for what's next, the recommended stack for
the remaining work, and step-by-step configuration.
