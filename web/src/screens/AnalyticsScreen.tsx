/**
 * web/src/screens/AnalyticsScreen.tsx
 *
 * Operational Control Center & Main Dashboard.
 * Designed specifically for store operators and risk engineers:
 *  - Real-time Gatekeeper health & active merchant rules status
 *  - High-priority action banner for pending human escalations
 *  - 4 spacious, high-contrast core financial & performance metrics
 *  - Live transaction stream with direct trace inspection
 *  - Deep Gatekeeper invariant enforcement breakdown
 *  - Authoritative Razorpay settlement & inventory hold ledger
 */
import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  formatPaise,
  type AnalyticsWindow,
  type OutcomeKind,
} from "@growthagent/shared";
import {
  fetchAnalytics,
  fetchApprovals,
  fetchRules,
  fetchTransactions,
} from "../lib/admin-api.js";
import { count, humanMs, pctOrDash, rupeesShort } from "../lib/format.js";
import { Chip, Page, Segmented, StatTile } from "../components/ui.js";

const WINDOWS = [
  { value: "24h" as const, label: "24 hours" },
  { value: "7d" as const, label: "7 days" },
  { value: "30d" as const, label: "30 days" },
];

export function AnalyticsScreen(): JSX.Element {
  const [win, setWin] = useState<AnalyticsWindow>("24h");

  // 1. Authoritative Analytics Aggregates
  const { data: analytics, isLoading, error } = useQuery({
    queryKey: ["admin", "analytics", win],
    queryFn: () => fetchAnalytics(win),
    refetchInterval: 10_000,
  });

  // 2. Real Pending Approvals Queue
  const { data: pendingApprovals } = useQuery({
    queryKey: ["admin", "approvals", "pending_dashboard"],
    queryFn: () => fetchApprovals("PENDING"),
    refetchInterval: 8_000,
  });

  // 3. Active Merchant Rules Invariants
  const { data: rulesData } = useQuery({
    queryKey: ["admin", "rules", "dashboard"],
    queryFn: fetchRules,
  });

  // 4. Live Stream of Recent Real Decisions
  const { data: txListData } = useQuery({
    queryKey: ["admin", "transactions", "recent_dashboard"],
    queryFn: () => fetchTransactions({ limit: 6 }),
    refetchInterval: 8_000,
  });

  const t = analytics?.totals;
  const rules = rulesData?.rules;
  const pendingCount = pendingApprovals?.length ?? analytics?.approvals.pending ?? 0;
  const recentTransactions = txListData?.transactions ?? [];

  // Filter rules that actually intervened (blocked or escalated)
  const intervenedRules = (analytics?.rule_findings ?? []).filter(
    (r) => r.fail + r.escalate > 0,
  );

  return (
    <Page
      title="Analytics"
      description="Operational command plane: real-time gatekeeper health, live proposals, and deterministic decision auditing."
      actions={<Segmented options={WINDOWS} value={win} onChange={setWin} label="Window" />}
    >
      {error !== null && (
        <div className="rounded-xl border border-bad/40 bg-bad/5 p-4 text-[13px] text-bad-bright">
          Could not load operational telemetry: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* 1. System Health & Gatekeeper Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-neutral-800/80 bg-[#080808] p-4 text-[12px]">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-ok" />
          </span>
          <div className="flex flex-wrap items-center gap-2 font-mono text-neutral-200">
            <span className="font-semibold text-white">GATEKEEPER v{rules?.rules_version ?? 3}</span>
            <span className="text-neutral-600">·</span>
            <span className="text-neutral-300">16 Invariants Armed</span>
            <span className="text-neutral-600">·</span>
            <span className="text-ok-bright">Zero LLM Financial Authority</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-neutral-400">
          <span>Max Disc: {rules?.max_discount_pct ?? 15}%</span>
          <span>Margin Floor: {rules?.margin_floor_pct ?? 25}%</span>
          <span>Ceiling: {rules ? formatPaise(rules.max_cart_value_paise) : "₹5,000"}</span>
          <Link to="/policy" className="text-white hover:underline">
            Adjust Invariants →
          </Link>
        </div>
      </div>

      {/* 2. Actionable Attention Banner (When Human Intervention Is Required) */}
      {pendingCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-escalate/40 bg-escalate/5 p-5 shadow-sm">
          <div className="flex items-center gap-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-escalate/10 text-escalate-bright">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div>
              <h4 className="text-[14px] font-semibold text-white">
                {pendingCount} Transaction{pendingCount === 1 ? "" : "s"} Requiring Human Approval
              </h4>
              <p className="mt-0.5 text-[12px] text-neutral-400">
                Flagged for prompt injection evasion or cart totals exceeding the automated limit.
              </p>
            </div>
          </div>
          <Link
            to="/approvals"
            className="flex items-center gap-2 rounded-lg bg-escalate px-4 py-2 font-mono text-[12px] font-semibold text-black transition-all hover:bg-escalate-bright"
          >
            Review Inbox ({pendingCount}) →
          </Link>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-xl border border-neutral-800/60 bg-[#0a0a0a] px-5 py-3 text-[12px]">
          <div className="flex items-center gap-2.5 text-neutral-400">
            <span className="flex h-2 w-2 rounded-full bg-ok" />
            <span className="text-white font-medium">All Queues Clear</span>
            <span className="text-neutral-500">· Zero pending escalations requiring manual review</span>
          </div>
          <Link to="/simulate" className="font-mono text-[11px] text-neutral-400 hover:text-white">
            Trigger Adversarial Simulation →
          </Link>
        </div>
      )}

      {/* 3. Four Spacious High-Contrast Core Metrics */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Proposals"
          value={isLoading ? "—" : count(t?.proposals ?? 0)}
          meta={
            (t?.in_flight ?? 0) > 0
              ? `${count(t?.in_flight ?? 0)} in flight right now`
              : "All proposals decided"
          }
        />
        <StatTile
          label="Approval rate"
          value={isLoading ? "—" : pctOrDash(t?.approval_rate_pct ?? null)}
          meta={`${count(t?.injections_blocked ?? 0)} prompt injections caught`}
          tone={t?.approval_rate_pct == null ? "default" : "ok"}
        />
        <StatTile
          label="Decision time"
          value={isLoading ? "—" : humanMs(t?.decision_p50_ms ?? null)}
          meta={`p95 ${humanMs(t?.decision_p95_ms ?? null)} · Zero I/O pure math`}
        />
        <StatTile
          label="Approved value"
          value={isLoading ? "—" : rupeesShort(t?.approved_value_paise ?? 0)}
          meta={`${rupeesShort(t?.settled_value_paise ?? 0)} settled on Razorpay`}
        />
      </div>

      {/* 4. Live Transaction Stream & Recent Decisions */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[14px] font-semibold text-white">Recent Decisions & Live Stream</h3>
            <p className="text-[12px] text-neutral-400">
              Direct execution log from the audit ledger. Click any transaction to inspect its complete stage trace.
            </p>
          </div>
          <Link
            to="/transactions"
            className="rounded-md border border-neutral-800 bg-[#0d0d0d] px-3 py-1.5 font-mono text-[11px] text-neutral-300 transition-colors hover:border-neutral-600 hover:text-white"
          >
            View All Ledger Rows →
          </Link>
        </div>

        <div className="overflow-hidden rounded-xl border border-neutral-800/80 bg-[#090909]">
          <table className="w-full text-left font-sans text-[12px]">
            <thead className="border-b border-neutral-800 bg-neutral-900/40 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              <tr>
                <th className="px-4 py-3">Transaction ID</th>
                <th className="px-4 py-3">Buyer Agent</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Verdict</th>
                <th className="px-4 py-3">Value</th>
                <th className="px-4 py-3">Intervening Reason</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/50">
              {recentTransactions.length > 0 ? (
                recentTransactions.map((tx) => (
                  <tr key={tx.tx_id} className="transition-colors hover:bg-neutral-900/30">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px]">
                      <Link
                        to={`/trace/${tx.tx_id}`}
                        className="text-neutral-300 hover:text-white hover:underline"
                      >
                        {tx.tx_id.slice(0, 18)}...
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-neutral-400">
                      {tx.agent_id}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-neutral-300">
                      {tx.stage}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <OutcomeChip outcome={tx.outcome} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-neutral-200">
                      {tx.value_paise !== null ? formatPaise(tx.value_paise) : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-neutral-400">
                      {tx.reason ?? (tx.outcome === "APPROVED" ? "All Invariants Satisfied" : "—")}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-[11px]">
                      <Link
                        to={`/trace/${tx.tx_id}`}
                        className="text-neutral-400 transition-colors hover:text-white"
                      >
                        Inspect Trace →
                      </Link>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-[12px] text-neutral-500">
                    No transactions recorded yet. Run a simulation to start streaming proposals.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 5. Two Focused Diagnostic Panels */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Panel A: Gatekeeper Invariant Enforcement */}
        <div className="space-y-4 rounded-xl border border-neutral-800/80 bg-[#090909] p-5">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-[14px] font-semibold text-white">Gatekeeper Interventions</h4>
              <p className="text-[11px] text-neutral-400">
                Invariants that blocked or escalated candidate carts.
              </p>
            </div>
            <Link to="/policy" className="font-mono text-[11px] text-neutral-400 hover:text-white">
              Policy Editor →
            </Link>
          </div>

          <div className="space-y-2.5">
            {intervenedRules.length > 0 ? (
              intervenedRules.map((r) => (
                <div
                  key={r.rule_id}
                  className="flex items-center justify-between rounded-lg border border-neutral-800/60 bg-[#0d0d0d] p-3 text-[12px]"
                >
                  <div className="space-y-0.5">
                    <span className="font-mono font-medium text-white">{r.rule_id}</span>
                    <p className="text-[11px] text-neutral-500">
                      Evaluated across {count(r.evaluations)} proposals
                    </p>
                  </div>
                  <div className="flex items-center gap-3 font-mono text-[11px]">
                    {r.fail > 0 && (
                      <span className="rounded bg-bad/10 px-2 py-0.5 text-bad-bright">
                        {r.fail} Blocked
                      </span>
                    )}
                    {r.escalate > 0 && (
                      <span className="rounded bg-escalate/10 px-2 py-0.5 text-escalate-bright">
                        {r.escalate} Escalated
                      </span>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-neutral-800/60 bg-[#0d0d0d] p-4 text-center text-[12px] text-neutral-500">
                No invariant violations in this time window. All proposed carts satisfied margin floors and discount caps.
              </div>
            )}
          </div>
        </div>

        {/* Panel B: Settlement Rail & Money State */}
        <div className="space-y-4 rounded-xl border border-neutral-800/80 bg-[#090909] p-5">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-[14px] font-semibold text-white">Settlement & Money Rails</h4>
              <p className="text-[11px] text-neutral-400">
                Idempotent stock reservation and Razorpay payment captures.
              </p>
            </div>
            <span className="font-mono text-[11px] text-ok-bright">
              {analytics?.settlement.completed ?? 0} Completed
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-neutral-800/60 bg-[#0d0d0d] p-3">
              <span className="text-[10px] text-neutral-500 uppercase tracking-wider">
                Order Funnel
              </span>
              <p className="mt-1 font-mono text-[16px] font-bold text-white">
                {analytics?.settlement.opened ?? 0}
              </p>
              <span className="text-[10px] text-neutral-400">Razorpay Orders Initiated</span>
            </div>

            <div className="rounded-lg border border-neutral-800/60 bg-[#0d0d0d] p-3">
              <span className="text-[10px] text-neutral-500 uppercase tracking-wider">
                Fully Settled
              </span>
              <p className="mt-1 font-mono text-[16px] font-bold text-ok-bright">
                {formatPaise(analytics?.totals.settled_value_paise ?? 0)}
              </p>
              <span className="text-[10px] text-neutral-400">Verified via HMAC Webhook</span>
            </div>
          </div>

          <div className="space-y-1.5 pt-1 text-[11px]">
            <div className="flex justify-between text-neutral-400">
              <span>Stock Reservation Model</span>
              <span className="font-mono text-white">Model A (Deadlock-Free Sorted Locks)</span>
            </div>
            <div className="flex justify-between text-neutral-400">
              <span>Payment Gateway Mode</span>
              <span className="font-mono text-white">Razorpay Orders API + Webhook Ingress</span>
            </div>
            <div className="flex justify-between text-neutral-400">
              <span>State Machine Idempotency</span>
              <span className="font-mono text-white">PostgreSQL Compare-And-Swap (CAS)</span>
            </div>
          </div>
        </div>
      </div>

      {/* 6. Operator Action Hub */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Link
          to="/pipeline"
          className="group rounded-xl border border-neutral-800 bg-[#0a0a0a] p-4 transition-colors hover:border-neutral-700 hover:bg-[#0f0f0f]"
        >
          <span className="font-mono text-[10px] text-neutral-500">VISUAL INSPECTION</span>
          <h5 className="mt-1 text-[13px] font-medium text-white group-hover:underline">
            Open Pipeline Topology →
          </h5>
          <p className="mt-1 text-[11px] text-neutral-400">
            Trace connected graph nodes and stage latencies with real telemetry.
          </p>
        </Link>

        <Link
          to="/simulate"
          className="group rounded-xl border border-neutral-800 bg-[#0a0a0a] p-4 transition-colors hover:border-neutral-700 hover:bg-[#0f0f0f]"
        >
          <span className="font-mono text-[10px] text-neutral-500">CHAOS & ATTACKS</span>
          <h5 className="mt-1 text-[13px] font-medium text-white group-hover:underline">
            Test Prompt Injections →
          </h5>
          <p className="mt-1 text-[11px] text-neutral-400">
            Execute adversarial evasion tests and observe Gatekeeper defenses.
          </p>
        </Link>

        <Link
          to="/guide"
          className="group rounded-xl border border-neutral-800 bg-[#0a0a0a] p-4 transition-colors hover:border-neutral-700 hover:bg-[#0f0f0f]"
        >
          <span className="font-mono text-[10px] text-neutral-500">DOCUMENTATION</span>
          <h5 className="mt-1 text-[13px] font-medium text-white group-hover:underline">
            Operations & Invariants Guide →
          </h5>
          <p className="mt-1 text-[11px] text-neutral-400">
            Browse the 16 invariant formulas, trust boundaries, and curl cheat sheet.
          </p>
        </Link>
      </div>
    </Page>
  );
}

function OutcomeChip({ outcome }: { outcome: OutcomeKind | null }): JSX.Element {
  if (outcome === null) {
    return <Chip tone="run" withDot>In Flight</Chip>;
  }

  const tone =
    outcome === "APPROVED"
      ? "ok"
      : outcome === "ESCALATED"
      ? "escalate"
      : outcome === "DECLINED"
      ? "bad"
      : "warn";

  return (
    <Chip tone={tone} withDot>
      {outcome}
    </Chip>
  );
}
