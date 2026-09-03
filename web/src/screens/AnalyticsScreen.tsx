/**
 * web/src/screens/AnalyticsScreen.tsx — the operations dashboard, and the
 * default route.
 *
 * Every number on this screen comes from GET /v1/admin/analytics, which
 * aggregates in SQL over proposal_txs, audit_log, transactions and approvals.
 * There is no client-side arithmetic beyond formatting and no fixture anywhere:
 * an empty database renders zeroes and empty states, which is the honest answer.
 *
 * Layout follows one rule — the filter row scopes EVERYTHING below it, so every
 * panel always describes the same slice and the numbers can never disagree with
 * each other. Five panels, in the order an operator actually reads them:
 * headline numbers → what happened over time → how it split → why it split →
 * how fast, and where the money got to.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPaise, type AnalyticsWindow } from "@growthagent/shared";
import { fetchAnalytics } from "../lib/admin-api.js";
import {
  OUTCOME_COLOR,
  OUTCOME_LABEL,
  OUTCOME_ORDER,
  SERIES,
  VIZ,
} from "../lib/viz.js";
import {
  bucketLabels,
  count,
  humanMs,
  pctOrDash,
  rupeesShort,
} from "../lib/format.js";
import { Page, Section, Segmented, StatTile } from "../components/ui.js";
import { ChartCard, TableView } from "../components/chart-kit.js";
import { BarRows, Sparkline, StackedColumns, type BarRow } from "../components/charts.js";

const WINDOWS = [
  { value: "24h" as const, label: "24 hours" },
  { value: "7d" as const, label: "7 days" },
  { value: "30d" as const, label: "30 days" },
];

/** Rule ids are long and all share the GK- prefix; the prefix carries nothing. */
const shortRule = (id: string): string => id.replace(/^GK-/, "");

export function AnalyticsScreen(): JSX.Element {
  const [win, setWin] = useState<AnalyticsWindow>("7d");

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["admin", "analytics", win],
    queryFn: () => fetchAnalytics(win),
    refetchInterval: 15_000,
    // Hold the previous render while refetching — no skeleton flash, no jump.
    placeholderData: (prev) => prev,
  });

  const t = data?.totals;
  const decided =
    (t?.approved ?? 0) + (t?.escalated ?? 0) + (t?.declined ?? 0) + (t?.failed ?? 0);

  const buckets = (data?.volume ?? []).map((b) => {
    const { short, full } = bucketLabels(b.bucket_start, data?.bucket ?? "day");
    return {
      label: short,
      full,
      segments: OUTCOME_ORDER.map((k) => ({
        key: k,
        label: OUTCOME_LABEL[k],
        value: b[k.toLowerCase() as "approved" | "escalated" | "declined" | "failed"],
        color: OUTCOME_COLOR[k],
      })),
    };
  });

  const outcomeRows: BarRow[] = (data?.outcomes ?? []).map((o) => ({
    label: OUTCOME_LABEL[o.outcome],
    value: o.count,
    sub: `${o.share_pct}% of decided`,
    color: OUTCOME_COLOR[o.outcome],
  }));

  // Only rules that changed an outcome. A list of sixteen PASSes ranked by
  // "times evaluated" would just be a chart of how often the pipeline ran.
  const interventions = (data?.rule_findings ?? [])
    .filter((r) => r.fail + r.escalate > 0)
    .slice(0, 8);
  const ruleRows: BarRow[] = interventions.map((r) => ({
    label: shortRule(r.rule_id),
    value: r.fail + r.escalate,
    sub: `${count(r.evaluations)} evaluations`,
    color: SERIES[0],
    extra: [
      { label: "Blocked", value: count(r.fail) },
      { label: "Escalated", value: count(r.escalate) },
    ],
  }));

  const stageRows: BarRow[] = (data?.stage_latency ?? []).map((s) => ({
    label: s.stage,
    value: s.p50_ms,
    sub: `${count(s.runs)} runs`,
    color: SERIES[0],
    marker: { value: s.p95_ms, label: "p95" },
    ...(s.failures > 0
      ? { extra: [{ label: "Non-OK exits", value: count(s.failures) }] }
      : {}),
  }));

  const settlementRows: BarRow[] = (data?.settlement.states ?? []).map((s) => ({
    label: s.state.replace(/_/g, " ").toLowerCase(),
    value: s.count,
    color: SERIES[2],
    extra: [{ label: "Value", value: formatPaise(s.value_paise) }],
  }));

  const trend = buckets.map((b) => b.segments.reduce((s, g) => s + g.value, 0));
  const pending = data?.approvals.pending ?? 0;
  const nothingYet = (t?.proposals ?? 0) === 0;

  return (
    <Page
      title="Analytics"
      description="Aggregated from the audit log and settlement ledger for the selected window."
      actions={<Segmented options={WINDOWS} value={win} onChange={setWin} label="Time range" />}
    >
      {error !== null && (
        <p className="rounded-lg border border-bad/40 bg-bad/5 px-4 py-3 text-[12px] text-bad-bright">
          Could not load analytics: {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {pending > 0 && (
        <Link
          to="/approvals"
          className="flex items-center justify-between gap-4 rounded-xl border border-escalate/40 bg-escalate/5 px-5 py-4 transition-colors hover:border-escalate/60"
        >
          <span className="text-[13px] text-ink">
            {pending} escalation{pending === 1 ? "" : "s"} waiting for a human decision
          </span>
          <span className="text-[12px] text-escalate-bright">Review →</span>
        </Link>
      )}

      <div
        className={`space-y-10 transition-opacity ${
          isFetching && data !== undefined ? "opacity-60" : ""
        }`}
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Proposals"
            value={isLoading ? "—" : count(t?.proposals ?? 0)}
            meta={
              (t?.in_flight ?? 0) > 0
                ? `${count(t?.in_flight ?? 0)} still in flight`
                : "none in flight"
            }
            trend={trend.length > 1 ? <Sparkline points={trend} color={VIZ.ink} /> : undefined}
          />
          <StatTile
            label="Approval rate"
            value={isLoading ? "—" : pctOrDash(t?.approval_rate_pct ?? null)}
            meta={`${count(t?.approved ?? 0)} of ${count(decided)} decided`}
            tone={t?.approval_rate_pct == null ? "default" : "ok"}
          />
          <StatTile
            label="Decision time"
            value={isLoading ? "—" : humanMs(t?.decision_p50_ms ?? null)}
            meta={`p95 ${humanMs(t?.decision_p95_ms ?? null)}`}
          />
          <StatTile
            label="Approved value"
            value={isLoading ? "—" : rupeesShort(t?.approved_value_paise ?? 0)}
            meta={`${rupeesShort(t?.settled_value_paise ?? 0)} fully settled`}
          />
        </div>

        <ChartCard
          title="Volume over time"
          hint="Terminal outcome per bucket. A quiet bucket is shown as zero, never skipped."
          legend={OUTCOME_ORDER.map((k) => ({
            label: OUTCOME_LABEL[k],
            color: OUTCOME_COLOR[k],
          }))}
          empty={nothingYet}
          table={
            <TableView
              rows={buckets}
              columns={[
                { header: "Bucket", cell: (b) => b.full },
                ...OUTCOME_ORDER.map((k, i) => ({
                  header: OUTCOME_LABEL[k],
                  numeric: true,
                  cell: (b: (typeof buckets)[number]) => count(b.segments[i]?.value ?? 0),
                })),
              ]}
            />
          }
        >
          <StackedColumns buckets={buckets} format={count} />
        </ChartCard>

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <ChartCard
            title="Outcome mix"
            hint="Where proposals ended up."
            empty={nothingYet}
            table={
              <TableView
                rows={data?.outcomes ?? []}
                columns={[
                  { header: "Outcome", cell: (o) => OUTCOME_LABEL[o.outcome] },
                  { header: "Count", numeric: true, cell: (o) => count(o.count) },
                  { header: "Share", numeric: true, cell: (o) => `${o.share_pct}%` },
                ]}
              />
            }
          >
            <BarRows rows={outcomeRows} format={count} />
          </ChartCard>

          <ChartCard
            title="Rules that intervened"
            hint="Invariants that blocked or escalated a cart — not the ones that merely ran."
            empty={nothingYet}
            table={
              <TableView
                rows={interventions}
                columns={[
                  { header: "Rule", cell: (r) => shortRule(r.rule_id) },
                  { header: "Blocked", numeric: true, cell: (r) => count(r.fail) },
                  { header: "Escalated", numeric: true, cell: (r) => count(r.escalate) },
                  { header: "Evaluations", numeric: true, cell: (r) => count(r.evaluations) },
                ]}
              />
            }
          >
            <BarRows
              rows={ruleRows}
              format={count}
              emptyNote="No rule blocked or escalated a cart in this window."
            />
          </ChartCard>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <ChartCard
            title="Stage latency"
            hint="Median wall clock per pipeline stage; the tick marks p95."
            empty={stageRows.length === 0}
            table={
              <TableView
                rows={data?.stage_latency ?? []}
                columns={[
                  { header: "Stage", cell: (s) => s.stage },
                  { header: "Runs", numeric: true, cell: (s) => count(s.runs) },
                  { header: "p50", numeric: true, cell: (s) => humanMs(s.p50_ms) },
                  { header: "p95", numeric: true, cell: (s) => humanMs(s.p95_ms) },
                ]}
              />
            }
          >
            <BarRows rows={stageRows} format={humanMs} />
          </ChartCard>

          <ChartCard
            title="Settlement"
            hint="State of every payment opened in this window."
            right={
              <span className="text-[11px] text-mute">
                paid {pctOrDash(data?.settlement.paid_rate_pct ?? null)}
              </span>
            }
            empty={settlementRows.length === 0}
            table={
              <TableView
                rows={data?.settlement.states ?? []}
                columns={[
                  { header: "State", cell: (s) => s.state },
                  { header: "Count", numeric: true, cell: (s) => count(s.count) },
                  { header: "Value", numeric: true, cell: (s) => formatPaise(s.value_paise) },
                ]}
              />
            }
          >
            <BarRows
              rows={settlementRows}
              format={count}
              emptyNote="No payment was opened in this window."
            />
          </ChartCard>
        </div>

        {data !== undefined && (
          <p className="text-[11px] leading-relaxed text-mute">
            Window opens {data.from.slice(0, 16).replace("T", " ")} · policy v
            {data.rules_version} · {count(data.totals.injections_blocked)} injection attempt
            {data.totals.injections_blocked === 1 ? "" : "s"} flagged ·{" "}
            {count(data.totals.degradations)} degraded stage
            {data.totals.degradations === 1 ? "" : "s"}
          </p>
        )}
      </div>
    </Page>
  );
}
