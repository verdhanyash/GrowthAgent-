/**
 * web/src/screens/TraceScreen.tsx — one transaction, end to end.
 *
 * Two live channels reconciled: the SSE audit stream (folded by traceReducer)
 * and the authoritative poll (the signed terminal outcome). The poll always
 * wins for anything involving money; the stream is what makes it watchable.
 *
 * Restructured to a single column in reading order — what happened, what was
 * decided, what the money did, and then the evidence — because the old
 * two-column split put the audit log beside the verdict and made the page feel
 * like six dashboards competing for the same glance. The forensic panels are
 * still all here; they are just no longer all shouting at once.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTransactionStream, type ConnStatus } from "../hooks/useTransactionStream.js";
import { useProposalStatus } from "../hooks/useProposalStatus.js";
import { mintStreamTicket } from "../lib/api.js";
import { fetchTransactions } from "../lib/admin-api.js";
import { humanMs, formatReason } from "../lib/format.js";
import { Chip, Mono, Panel, Section } from "../components/ui.js";
import { StageTimeline } from "../components/StageTimeline.js";
import { RuleTable } from "../components/RuleTable.js";
import { InjectionBanner } from "../components/InjectionBanner.js";
import { DecisionBadge } from "../components/DecisionBadge.js";
import { SettlementChecklist } from "../components/SettlementChecklist.js";
import { EscalationPanel } from "../components/EscalationPanel.js";
import { NarrativeCard } from "../components/NarrativeCard.js";
import { NegotiationStream } from "../components/NegotiationStream.js";
import { EventLogRail } from "../components/EventLogRail.js";
import { OutcomePanel } from "../components/OutcomePanel.js";

async function mintTicket(txId: string): Promise<string> {
  const r = await mintStreamTicket(txId);
  return r.ticket;
}

function connTone(s: ConnStatus): "ok" | "run" | "bad" | "default" {
  if (s === "open") return "ok";
  if (s === "connecting" || s === "reconnecting") return "run";
  if (s === "error") return "bad";
  return "default";
}

export function TraceScreen({ txId }: { txId: string }): JSX.Element {
  const poll = useProposalStatus(txId);
  // Open the stream even for a finished transaction: the SSE route replays the
  // full durable history before forwarding live frames, and that replay is the
  // ONLY way this screen reconstructs a past run. Gating it on `!isTerminal` —
  // which is what it used to do — meant every trace opened from the Transactions
  // list rendered an empty pipeline, an empty rule ledger and an empty
  // settlement list, because by then the run was always over.
  const stream = useTransactionStream(txId, {
    active: poll.error === null,
    alreadyTerminal: poll.isTerminal,
    mintTicket,
  });
  const { state } = stream;
  const [showLog, setShowLog] = useState(false);

  const adminTxQuery = useQuery({
    queryKey: ["adminTx", txId],
    queryFn: async () => {
      const res = await fetchTransactions({ q: txId, limit: 1 });
      return res.transactions.find((t) => t.tx_id === txId) ?? null;
    },
    enabled: poll.error !== null,
  });

  return (
    <div className="space-y-10">
      {/* One header row: where you are, what it is, and whether it is live. */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/transactions"
            className="text-[11px] text-mute transition-colors hover:text-ink"
          >
            ← Transactions
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-[18px] font-semibold tracking-tight text-ink">Trace</h1>
            <Mono value={txId} truncate className="max-w-[260px] text-[12px]" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {poll.data != null && <Chip>{poll.data.status.toLowerCase()}</Chip>}
          <Chip tone={connTone(stream.status)} withDot={stream.status !== "closed"} title="Live audit stream">
            {stream.status}
          </Chip>
          <span className="text-[11px] text-mute">{state.eventCount} events</span>
        </div>
      </header>

      {/*
        The deep trace is BUYER-scoped: both the poll and the stream ticket
        require the agent key that owns this transaction. When the connected key
        is not that key, check if the control plane has the verified record.
      */}
      {poll.error !== null ? (
        <div className="space-y-6">
          {adminTxQuery.data ? (
            <div className="rounded-xl border border-edge bg-panel p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge pb-4">
                <div>
                  <div className="text-[11px] font-mono text-mute uppercase tracking-wider">
                    Control Plane Record
                  </div>
                  <h2 className="text-[16px] font-semibold text-ink mt-0.5">
                    Transaction {adminTxQuery.data.tx_id}
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  {adminTxQuery.data.outcome && (
                    <Chip
                      tone={
                        adminTxQuery.data.outcome === "APPROVED"
                          ? "ok"
                          : adminTxQuery.data.outcome === "ESCALATED"
                            ? "escalate"
                            : adminTxQuery.data.outcome === "DECLINED"
                              ? "bad"
                              : "warn"
                      }
                    >
                      {adminTxQuery.data.outcome}
                    </Chip>
                  )}
                  <Chip tone="default">Stage: {adminTxQuery.data.stage}</Chip>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <div className="text-[11px] text-mute">Submitting Agent</div>
                  <div className="font-mono text-[13px] text-ink mt-1 font-medium">
                    {adminTxQuery.data.agent_id}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-mute">Failure / Verdict Reason</div>
                  <div className="font-mono text-[13px] text-bad-bright font-semibold mt-1">
                    {formatReason(adminTxQuery.data.reason)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-mute">Duration</div>
                  <div className="font-mono text-[13px] text-ink mt-1">
                    {adminTxQuery.data.duration_ms !== null
                      ? humanMs(adminTxQuery.data.duration_ms)
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-mute">Settlement State</div>
                  <div className="font-mono text-[13px] text-ink mt-1">
                    {adminTxQuery.data.settlement_state ?? "—"}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-warn/40 bg-warn/5 p-4 text-[12px] text-warn-bright leading-relaxed">
                <strong>🔒 Scoped Buyer Trace:</strong> Live SSE streaming and real-time proposal polling require the private key of the submitting agent ({adminTxQuery.data.agent_id}). Above is the authoritative terminal outcome and settlement state recorded in the GrowthAgent database.
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-bad/40 bg-bad/5 p-6">
              <p className="text-[13px] text-bad-bright">Cannot read this transaction</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">
                {poll.error.message}
              </p>
              <p className="mt-3 text-[11px] leading-relaxed text-mute">
                The full trace is scoped to the agent that submitted the cart. The
                outcome, policy verdict and settlement state for every run are on the{" "}
                <Link to="/transactions" className="text-ink-muted underline hover:text-ink">
                  Transactions
                </Link>{" "}
                list, which reads the control plane rather than the buyer surface.
              </p>
            </div>
          )}
        </div>
      ) : (
        <TraceBody state={state} stream={stream} poll={poll} showLog={showLog} onToggleLog={setShowLog} />
      )}
    </div>
  );
}

/** The panels, once we know the transaction is actually readable. */
function TraceBody({
  state,
  stream,
  poll,
  showLog,
  onToggleLog,
}: {
  state: ReturnType<typeof useTransactionStream>["state"];
  stream: ReturnType<typeof useTransactionStream>;
  poll: ReturnType<typeof useProposalStatus>;
  showLog: boolean;
  onToggleLog: (fn: (v: boolean) => boolean) => void;
}): JSX.Element {
  return (
    <div className="space-y-10">
      {stream.error !== null && (
        <p className="rounded-lg border border-warn/40 bg-warn/5 px-4 py-3 text-[12px] text-warn-bright">
          Live stream unavailable ({stream.error}). The signed outcome below still
          comes from the authoritative poll.
        </p>
      )}

      {/* Security first: if the note was hostile, that frames everything below. */}
      <InjectionBanner inj={state.injection} decision={state.decision} />

      <Section title="Pipeline" hint="Stages as the audit log announced them.">
        <div className="rounded-xl border border-edge bg-panel p-6">
          <StageTimeline stages={state.stages} />
        </div>
      </Section>

      <DecisionBadge decision={state.decision} />

      <EscalationPanel created={state.escalationCreated} resolved={state.escalationResolved} />

      {/* The authoritative, signed answer. */}
      <OutcomePanel poll={poll.data} />

      {/* Settlement is a short list; the ledger is a five-column table of
          sixteen rows. Side by side, the ledger got ~470px and wrapped every
          rule id onto two lines, so they stack: what the money did, then the
          full evidence for why it was allowed to. */}
      <Panel title="Settlement" subtitle="Stock hold, Razorpay order, payment capture.">
        <SettlementChecklist steps={state.settlement} />
      </Panel>

      <Panel title="Policy ledger" subtitle="Every invariant the gatekeeper ran on this cart.">
        <RuleTable rules={state.rules} />
      </Panel>

      <NegotiationStream neg={state.negotiation} />

      <NarrativeCard narrative={state.narrative} />

      <Section>
        <button
          type="button"
          onClick={() => onToggleLog((v) => !v)}
          aria-expanded={showLog}
          className="text-[12px] text-mute transition-colors hover:text-ink"
        >
          {showLog ? "Hide" : "Show"} the raw audit log ({state.log.length} hash-chained events)
        </button>
        {showLog && (
          <div className="mt-4 rounded-xl border border-edge bg-panel p-6">
            <EventLogRail log={state.log} />
          </div>
        )}
      </Section>
    </div>
  );
}
