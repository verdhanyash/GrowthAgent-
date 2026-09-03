/**
 * api/src/http/admin-analytics.route.ts — read-only aggregates for the
 * analytics dashboard (§7.5) plus the transaction index (§7.6).
 *
 *   GET /v1/admin/analytics?window=24h|7d|30d
 *   GET /v1/admin/transactions?outcome=&q=&limit=
 *
 * EVERY figure is computed in SQL over tables the pipeline already writes:
 * proposal_txs (outcome + wall clock), audit_log (rule verdicts, stage
 * durations, injection/degradation events), transactions (money rails), and
 * approvals (human-review latency). There is no fixture, no seeded series and
 * no "demo mode" branch — an empty database returns zeroes and empty arrays,
 * which is the honest answer and what the empty states in the UI render.
 *
 * Two deliberate choices:
 *  - Percentiles use `percentile_disc`, so every reported number is a real
 *    observed duration rather than an interpolation between two runs.
 *  - The volume series is LEFT JOINed onto a generated bucket spine, so a quiet
 *    hour arrives as an explicit zero instead of a hole the chart has to guess
 *    at (a missing bucket and a zero bucket look very different on a column
 *    chart, and only one of them is true).
 */
import express, { type Router } from "express";
import {
  AnalyticsResponseSchema,
  AnalyticsWindowSchema,
  HttpError,
  OutcomeKindSchema,
  TxListResponseSchema,
  type AnalyticsResponse,
  type AnalyticsWindow,
  type OutcomeKind,
  type OutcomeShare,
  type RuleFinding,
  type SettlementStateCount,
  type StageLatency,
  type TxListRow,
  type VolumeBucket,
} from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { asyncHandler } from "./errors.js";

export interface AdminAnalyticsRoutesDeps {
  readonly db: PgPool;
  readonly rulesVersion: () => number;
  readonly nowMs?: (() => number) | undefined;
}

/** Window → (SQL interval, bucket unit, bucket step). A switch rather than a
 *  lookup table so the compiler proves every window is handled. */
function windowSpec(w: AnalyticsWindow): {
  interval: string;
  bucket: "hour" | "day";
  step: string;
} {
  switch (w) {
    case "24h":
      return { interval: "24 hours", bucket: "hour", step: "1 hour" };
    case "7d":
      return { interval: "7 days", bucket: "day", step: "1 day" };
    case "30d":
      return { interval: "30 days", bucket: "day", step: "1 day" };
  }
}

/** Display order for the stage-latency chart: the pipeline's own order. */
const STAGE_ORDER = [
  "INTAKE",
  "CONTEXT_BUILD",
  "CAMPAIGN_INJECT",
  "NEGOTIATION",
  "CITATION_AUDIT",
  "GATEKEEPER",
  "ESCALATION_WAIT",
  "SETTLEMENT",
  "EXPLAIN",
];

/** Settlement states that count as money actually taken. */
const PAID_STATES = new Set(["PAID", "COMPLETED"]);
const FAILED_STATES = new Set(["FAILED", "EXPIRED", "MANUAL_REFUND_REQUIRED", "REJECTED_BY_MERCHANT"]);

const int = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const intOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : int(v);
/** Percent to 1dp — enough precision for a label, never a float tail in JSON. */
const pct = (num: number, den: number): number | null =>
  den <= 0 ? null : Math.round((num / den) * 1000) / 10;
const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

export function adminAnalyticsRoutes(deps: AdminAnalyticsRoutesDeps): Router {
  const router = express.Router();
  const now = (): Date => new Date(deps.nowMs?.() ?? Date.now());

  router.get(
    "/v1/admin/analytics",
    asyncHandler(async (req, res) => {
      const parsed = AnalyticsWindowSchema.safeParse(req.query.window ?? "7d");
      if (!parsed.success) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          "window must be one of 24h, 7d, 30d",
          { retryable: false },
        );
      }
      const win = parsed.data;
      const { interval, bucket, step } = windowSpec(win);

      // One shared lower bound so every panel describes the same slice.
      const fromRow = await deps.db.query<{ from: Date }>(
        `SELECT (now() - $1::interval) AS from`,
        [interval],
      );
      const from = fromRow.rows[0]?.from ?? now();

      const [
        totalsQ,
        volumeQ,
        rulesQ,
        stagesQ,
        eventsQ,
        settleQ,
        approvalsQ,
      ] = await Promise.all([
        // Outcome mix + decision latency straight off the pipeline record.
        deps.db.query(
          `SELECT
             count(*)::int AS proposals,
             count(*) FILTER (WHERE outcome_json->>'outcome' = 'APPROVED')::int  AS approved,
             count(*) FILTER (WHERE outcome_json->>'outcome' = 'ESCALATED')::int AS escalated,
             count(*) FILTER (WHERE outcome_json->>'outcome' = 'DECLINED')::int  AS declined,
             count(*) FILTER (WHERE outcome_json->>'outcome' = 'FAILED')::int    AS failed,
             count(*) FILTER (WHERE stage <> 'TERMINAL')::int                    AS in_flight,
             percentile_disc(0.5) WITHIN GROUP (
               ORDER BY (EXTRACT(EPOCH FROM (COALESCE(finished_at, updated_at) - created_at)) * 1000)
             ) FILTER (WHERE outcome_json IS NOT NULL) AS p50_ms,
             percentile_disc(0.95) WITHIN GROUP (
               ORDER BY (EXTRACT(EPOCH FROM (COALESCE(finished_at, updated_at) - created_at)) * 1000)
             ) FILTER (WHERE outcome_json IS NOT NULL) AS p95_ms
           FROM proposal_txs
           WHERE created_at >= $1`,
          [from],
        ),

        // Bucket spine LEFT JOINed to the facts: quiet buckets stay visible.
        deps.db.query(
          `WITH spine AS (
             SELECT generate_series(
               date_trunc($1, ($2::timestamptz) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
               date_trunc($1, now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
               $3::interval
             ) AS bucket_start
           )
           SELECT
             s.bucket_start,
             count(p.tx_id) FILTER (WHERE p.outcome_json->>'outcome' = 'APPROVED')::int  AS approved,
             count(p.tx_id) FILTER (WHERE p.outcome_json->>'outcome' = 'ESCALATED')::int AS escalated,
             count(p.tx_id) FILTER (WHERE p.outcome_json->>'outcome' = 'DECLINED')::int  AS declined,
             count(p.tx_id) FILTER (WHERE p.outcome_json->>'outcome' = 'FAILED')::int    AS failed
           FROM spine s
           LEFT JOIN proposal_txs p
             ON date_trunc($1, p.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' = s.bucket_start
            AND p.created_at >= $2
           GROUP BY s.bucket_start
           ORDER BY s.bucket_start`,
          [bucket, from, step],
        ),

        // Which invariants actually bite, ranked by how often they block.
        //
        // The status vocabulary is shared's RuleStatus, not a local guess:
        // FAIL is the blocking verdict, while BAND (soft-edge band),
        // ESCALATE_TRIGGER (qualitative, e.g. injection) and
        // UNAVAILABLE_INPUT (fail-closed on a missing input) are the three
        // ways a rule routes to a human. SKIP and PASS are neither.
        deps.db.query(
          `SELECT
             payload->>'rule_id' AS rule_id,
             count(*)::int AS evaluations,
             count(*) FILTER (WHERE payload->>'status' = 'FAIL')::int AS fail,
             count(*) FILTER (
               WHERE payload->>'status' IN ('BAND','ESCALATE_TRIGGER','UNAVAILABLE_INPUT')
             )::int AS escalate
           FROM audit_log
           WHERE event = 'gatekeeper_rule_result'
             AND ts >= $1
             AND payload->>'rule_id' IS NOT NULL
           GROUP BY 1
           ORDER BY fail DESC, escalate DESC, rule_id ASC`,
          [from],
        ),

        // Stage wall-clock, as emitted by the pipeline itself.
        deps.db.query(
          `SELECT
             payload->>'stage' AS stage,
             count(*)::int AS runs,
             percentile_disc(0.5)  WITHIN GROUP (ORDER BY (payload->>'duration_ms')::numeric) AS p50_ms,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY (payload->>'duration_ms')::numeric) AS p95_ms,
             count(*) FILTER (WHERE payload->>'outcome' <> 'OK')::int AS failures
           FROM audit_log
           WHERE event = 'stage_completed'
             AND ts >= $1
             AND payload ? 'duration_ms'
             AND payload->>'stage' IS NOT NULL
           GROUP BY 1`,
          [from],
        ),

        deps.db.query(
          `SELECT
             count(*) FILTER (WHERE event = 'injection_flagged')::int AS injections,
             count(*) FILTER (WHERE event = 'degraded')::int          AS degradations
           FROM audit_log
           WHERE ts >= $1 AND event IN ('injection_flagged','degraded')`,
          [from],
        ),

        deps.db.query(
          `SELECT state, count(*)::int AS count,
                  COALESCE(sum(approved_total_paise), 0)::bigint AS value_paise
           FROM transactions
           WHERE created_at >= $1
           GROUP BY 1`,
          [from],
        ),

        deps.db.query(
          `SELECT
             count(*) FILTER (WHERE status = 'PENDING')::int    AS pending,
             count(*) FILTER (WHERE decision = 'APPROVED')::int AS approved,
             count(*) FILTER (WHERE decision = 'REJECTED')::int AS rejected,
             percentile_disc(0.5) WITHIN GROUP (
               ORDER BY (EXTRACT(EPOCH FROM (resolved_at - created_at)) * 1000)
             ) FILTER (WHERE resolved_at IS NOT NULL) AS median_ms
           FROM approvals
           WHERE created_at >= $1`,
          [from],
        ),
      ]);

      const t = totalsQ.rows[0] ?? {};
      const approved = int(t.approved);
      const escalated = int(t.escalated);
      const declined = int(t.declined);
      const failed = int(t.failed);
      const decided = approved + escalated + declined + failed;

      const states: SettlementStateCount[] = settleQ.rows
        .map((r) => ({
          state: String(r.state),
          count: int(r.count),
          value_paise: int(r.value_paise),
        }))
        .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));

      const opened = states.reduce((s, r) => s + r.count, 0);
      const paidCount = states
        .filter((r) => PAID_STATES.has(r.state))
        .reduce((s, r) => s + r.count, 0);
      const completed = states
        .filter((r) => r.state === "COMPLETED")
        .reduce((s, r) => s + r.count, 0);
      const settlementFailed = states
        .filter((r) => FAILED_STATES.has(r.state))
        .reduce((s, r) => s + r.count, 0);

      const volume: VolumeBucket[] = volumeQ.rows.map((r) => ({
        bucket_start: iso(r.bucket_start),
        approved: int(r.approved),
        escalated: int(r.escalated),
        declined: int(r.declined),
        failed: int(r.failed),
      }));

      // Fixed order — the chart's row order must not depend on the data, so a
      // refetch can never reshuffle the rows under the reader's eyes.
      const outcomes: OutcomeShare[] = (
        [
          ["APPROVED", approved],
          ["ESCALATED", escalated],
          ["DECLINED", declined],
          ["FAILED", failed],
        ] as const
      ).map(([outcome, count]) => ({
        outcome,
        count,
        share_pct: pct(count, decided) ?? 0,
      }));

      const rule_findings: RuleFinding[] = rulesQ.rows.map((r) => ({
        rule_id: String(r.rule_id),
        evaluations: int(r.evaluations),
        fail: int(r.fail),
        escalate: int(r.escalate),
      }));

      const stage_latency: StageLatency[] = stagesQ.rows
        .map((r) => ({
          stage: String(r.stage),
          runs: int(r.runs),
          p50_ms: int(r.p50_ms),
          p95_ms: int(r.p95_ms),
          failures: int(r.failures),
        }))
        .sort((a, b) => {
          const ia = STAGE_ORDER.indexOf(a.stage);
          const ib = STAGE_ORDER.indexOf(b.stage);
          return (ia < 0 ? STAGE_ORDER.length : ia) - (ib < 0 ? STAGE_ORDER.length : ib);
        });

      const ev = eventsQ.rows[0] ?? {};
      const ap = approvalsQ.rows[0] ?? {};

      const body: AnalyticsResponse = AnalyticsResponseSchema.parse({
        window: win,
        bucket,
        from: iso(from),
        generated_at: now().toISOString(),
        rules_version: deps.rulesVersion(),
        totals: {
          proposals: int(t.proposals),
          approved,
          escalated,
          declined,
          failed,
          in_flight: int(t.in_flight),
          approval_rate_pct: pct(approved, decided),
          decision_p50_ms: intOrNull(t.p50_ms),
          decision_p95_ms: intOrNull(t.p95_ms),
          approved_value_paise: states.reduce((s, r) => s + r.value_paise, 0),
          settled_value_paise: states
            .filter((r) => r.state === "COMPLETED")
            .reduce((s, r) => s + r.value_paise, 0),
          injections_blocked: int(ev.injections),
          degradations: int(ev.degradations),
        },
        volume,
        outcomes,
        rule_findings,
        stage_latency,
        settlement: {
          opened,
          paid: paidCount,
          completed,
          failed: settlementFailed,
          paid_rate_pct: pct(paidCount, opened),
          states,
        },
        approvals: {
          pending: int(ap.pending),
          approved: int(ap.approved),
          rejected: int(ap.rejected),
          median_decision_ms: intOrNull(ap.median_ms),
        },
      });

      res.status(200).json(body);
    }),
  );

  router.get(
    "/v1/admin/transactions",
    asyncHandler(async (req, res) => {
      const rawOutcome = req.query.outcome;
      let outcome: OutcomeKind | null = null;
      if (typeof rawOutcome === "string" && rawOutcome !== "" && rawOutcome !== "ALL") {
        const p = OutcomeKindSchema.safeParse(rawOutcome);
        if (!p.success) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "outcome must be one of APPROVED, ESCALATED, DECLINED, FAILED",
            { retryable: false },
          );
        }
        outcome = p.data;
      }

      const rawQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const q = rawQ === "" ? null : rawQ.slice(0, 120);
      const limit = Math.min(
        Math.max(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 1),
        200,
      );

      // ILIKE on a user string: parameterised, and the wildcards are ours — a
      // caller cannot inject a pattern that widens the scan beyond a substring.
      const where = `
        WHERE ($1::text IS NULL OR p.outcome_json->>'outcome' = $1)
          AND ($2::text IS NULL OR p.tx_id ILIKE '%' || $2 || '%' OR p.agent_id ILIKE '%' || $2 || '%')`;

      const [rowsQ, countQ] = await Promise.all([
        deps.db.query(
          `SELECT p.tx_id, p.agent_id, p.stage, p.rules_version, p.created_at,
                  -- The verdict lands with outcome_json; finished_at is only
                  -- stamped once settlement is done, so an approved-and-paying
                  -- cart would otherwise report no decision time at all.
                  CASE WHEN p.outcome_json IS NOT NULL
                       THEN COALESCE(p.finished_at, p.updated_at) END AS decided_at,
                  p.finished_at,
                  p.outcome_json,
                  t.state AS settlement_state,
                  t.approved_total_paise,
                  (m.mandate_json->>'total_paise')::bigint AS mandate_total,
                  -- The stored ESCALATED outcome is compact (approval_id +
                  -- expires_at); the reason it escalated lives on the approval
                  -- row, so read it from there rather than from a shape that
                  -- does not carry it.
                  a.reason AS approval_reason
           FROM proposal_txs p
           LEFT JOIN transactions  t ON t.tx_id = p.tx_id
           LEFT JOIN cart_mandates m ON m.tx_id = p.tx_id
           LEFT JOIN approvals     a ON a.tx_id = p.tx_id
           ${where}
           ORDER BY p.created_at DESC
           LIMIT $3`,
          [outcome, q, limit],
        ),
        deps.db.query(
          `SELECT count(*)::int AS total FROM proposal_txs p ${where}`,
          [outcome, q],
        ),
      ]);

      const transactions: TxListRow[] = rowsQ.rows.map((r) => {
        const oc = (r.outcome_json ?? null) as Record<string, unknown> | null;
        const kind = typeof oc?.outcome === "string" ? oc.outcome : null;
        const parsedKind = kind === null ? null : OutcomeKindSchema.safeParse(kind);
        const created = iso(r.created_at);
        const finished = r.finished_at === null ? null : iso(r.finished_at);
        const decided = r.decided_at === null || r.decided_at === undefined
          ? null
          : iso(r.decided_at);

        return {
          tx_id: String(r.tx_id),
          agent_id: String(r.agent_id),
          stage: String(r.stage),
          outcome: parsedKind && parsedKind.success ? parsedKind.data : null,
          value_paise:
            intOrNull(r.mandate_total) ?? intOrNull(r.approved_total_paise),
          reason: reasonOf(oc, r.approval_reason as string | null),
          rules_version: intOrNull(r.rules_version),
          settlement_state: r.settlement_state === null ? null : String(r.settlement_state),
          created_at: created,
          finished_at: finished,
          duration_ms:
            decided === null
              ? null
              : Math.max(0, Date.parse(decided) - Date.parse(created)),
        };
      });

      res.status(200).json(
        TxListResponseSchema.parse({
          transactions,
          total: int(countQ.rows[0]?.total),
        }),
      );
    }),
  );

  return router;
}

/**
 * The one line an operator scanning the list actually wants: WHY this ended
 * the way it did. Pulled from the stored terminal outcome, so it is the same
 * text the trace screen shows — never a re-derivation.
 */
function reasonOf(
  outcome: Record<string, unknown> | null,
  approvalReason: string | null,
): string | null {
  if (outcome === null) return null;
  const kind = outcome.outcome;

  if (kind === "DECLINED" && Array.isArray(outcome.decline_reasons)) {
    const first = outcome.decline_reasons[0] as Record<string, unknown> | undefined;
    return typeof first?.rule_id === "string" ? first.rule_id : null;
  }
  if (kind === "ESCALATED") {
    // Prefer the approval row; fall back to the poll-shaped outcome for any
    // row written before the compact form, and never echo "ESCALATED" back as
    // though it were a reason.
    if (approvalReason !== null) return approvalReason;
    const req = outcome.approval_request as Record<string, unknown> | undefined;
    return typeof req?.reason === "string" ? req.reason : null;
  }
  if (kind === "FAILED") {
    const f = outcome.failure as Record<string, unknown> | undefined;
    return typeof f?.reason === "string" ? f.reason : null;
  }
  return null;
}
