/**
 * web/src/screens/TransactionsScreen.tsx — the transaction index.
 *
 * This screen exists because the trace view had no front door: a tx_id could
 * only be reached by having watched it happen, so anything that ran while you
 * were on another screen was effectively lost. Now every run is listed, newest
 * first, filterable by outcome and searchable by id or agent, and one click
 * opens its full audit trace.
 *
 * Reads GET /v1/admin/transactions, which joins proposal_txs to the settlement
 * ledger and the signed mandate — so the value column is the real approved
 * total, not a re-derivation.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { formatPaise, type OutcomeKind, type TxListRow } from "@growthagent/shared";
import { fetchTransactions } from "../lib/admin-api.js";
import { count, humanMs, formatReason } from "../lib/format.js";
import { OUTCOME_LABEL } from "../lib/viz.js";
import {
  Chip,
  DataTable,
  Mono,
  Page,
  Segmented,
  inputClass,
  type Tone,
} from "../components/ui.js";

type Filter = OutcomeKind | "ALL";

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "APPROVED", label: "Approved" },
  { value: "ESCALATED", label: "Escalated" },
  { value: "DECLINED", label: "Declined" },
  { value: "FAILED", label: "Failed" },
];

const TONE: Record<OutcomeKind, Tone> = {
  APPROVED: "ok",
  ESCALATED: "escalate",
  DECLINED: "bad",
  FAILED: "warn",
};

/** Local clock, date only when it is not today — the list is mostly "today". */
function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function TransactionsScreen(): JSX.Element {
  const nav = useNavigate();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [q, setQ] = useState("");

  const { data, error, isFetching } = useQuery({
    queryKey: ["admin", "transactions", filter, q],
    queryFn: () => fetchTransactions({ outcome: filter, q, limit: 100 }),
    refetchInterval: 5_000,
    placeholderData: (prev) => prev,
  });

  const rows = data?.transactions ?? [];

  return (
    <Page
      title="Transactions"
      description="Every proposal the pipeline has run, newest first. Select one to open its audit trace."
      actions={
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search id or agent"
            aria-label="Search transactions by id or agent"
            className={`${inputClass} w-full sm:w-52`}
          />
          <Segmented options={FILTERS} value={filter} onChange={setFilter} label="Outcome" />
        </div>
      }
    >
      {error !== null && (
        <p className="rounded-lg border border-bad/40 bg-bad/5 px-4 py-3 text-[12px] text-bad-bright">
          Could not load transactions: {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      <div className={`transition-opacity ${isFetching && data !== undefined ? "opacity-60" : ""}`}>
        <div className="rounded-xl border border-edge bg-panel px-6 py-2">
          <DataTable<TxListRow>
            rows={rows}
            rowKey={(r) => r.tx_id}
            onRowClick={(r) => nav(`/trace/${r.tx_id}`)}
            empty={
              q.trim() !== "" || filter !== "ALL"
                ? "No transaction matches this filter."
                : "No proposals yet. Run one from Simulate."
            }
            columns={[
              {
                header: "Transaction",
                cell: (r) => (
                  <div className="min-w-0">
                    <Mono value={r.tx_id} truncate className="max-w-[190px]" />
                    <div className="mt-0.5 text-[10px] text-mute">{r.agent_id}</div>
                  </div>
                ),
              },
              {
                header: "Outcome",
                cell: (r) =>
                  r.outcome === null ? (
                    <Chip tone="run" withDot>
                      {r.stage.replace(/_/g, " ").toLowerCase()}
                    </Chip>
                  ) : (
                    <Chip tone={TONE[r.outcome]}>{OUTCOME_LABEL[r.outcome]}</Chip>
                  ),
              },
              {
                header: "Reason",
                cell: (r) => (
                  <span className="text-[11px] text-mute">
                    {formatReason(r.reason)}
                  </span>
                ),
              },
              {
                header: "Settlement",
                cell: (r) => (
                  <span className="text-[11px] text-mute">
                    {r.settlement_state === null
                      ? "—"
                      : r.settlement_state.replace(/_/g, " ").toLowerCase()}
                  </span>
                ),
              },
              {
                header: "Value",
                numeric: true,
                cell: (r) => (r.value_paise === null ? "—" : formatPaise(r.value_paise)),
              },
              {
                header: "Took",
                numeric: true,
                cell: (r) => humanMs(r.duration_ms),
              },
              {
                header: "Started",
                numeric: true,
                cell: (r) => when(r.created_at),
              },
            ]}
          />
        </div>

        {rows.length > 0 && (
          <p className="mt-3 text-[11px] text-mute">
            Showing {count(rows.length)} of {count(data?.total ?? 0)}
            {(data?.total ?? 0) > rows.length ? " — narrow the search to see older runs" : ""}
          </p>
        )}
      </div>
    </Page>
  );
}
