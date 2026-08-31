/**
 * TraceScreen — the live read-only trace for one transaction. It owns the two
 * data sources and reconciles them: the SSE stream (live narration, folded by
 * traceReducer) and the poll (authoritative terminal outcome). The poll's
 * `isTerminal` flips the stream `active` flag false so the reconnect loop stops
 * cleanly once the tx is done.
 */
import { useTransactionStream } from "../hooks/useTransactionStream.js";
import { useProposalStatus } from "../hooks/useProposalStatus.js";
import { mintStreamTicket } from "../lib/api.js";
import { Chip, Mono, Panel } from "../components/ui.js";
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
import type { ConnStatus } from "../hooks/useTransactionStream.js";

async function mintTicket(txId: string): Promise<string> {
  const r = await mintStreamTicket(txId);
  return r.ticket;
}

function connTone(s: ConnStatus): "ok" | "run" | "bad" | "info" {
  if (s === "open") return "ok";
  if (s === "connecting" || s === "reconnecting") return "run";
  if (s === "error") return "bad";
  return "info";
}

export function TraceScreen({ txId }: { txId: string }): JSX.Element {
  const poll = useProposalStatus(txId);
  const stream = useTransactionStream(txId, { active: !poll.isTerminal, mintTicket });
  const { state } = stream;

  return (
    <div className="space-y-4">
      {/* header: tx id + connection + poll stage */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge bg-panel px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-mute">tx</span>
          <Mono value={txId} className="text-[13px]" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {poll.data && <Chip tone="info" title="poll stage">{poll.data.status}</Chip>}
          <Chip tone={connTone(stream.status)} title="SSE connection">
            {stream.status}{stream.reconnects > 0 && stream.status === "reconnecting" ? ` · try ${stream.reconnects}` : ""}
          </Chip>
          <Chip tone="info" title="durable events folded">{state.eventCount} events</Chip>
        </div>
      </div>

      {stream.error && (
        <div className="rounded border border-bad/50 bg-bad/[0.06] px-3 py-2 text-[12px] text-bad">{stream.error}</div>
      )}
      {poll.error && (
        <div className="rounded border border-bad/50 bg-bad/[0.06] px-3 py-2 text-[12px] text-bad">poll: {poll.error.message}</div>
      )}

      <InjectionBanner inj={state.injection} decision={state.decision} />

      {/* authoritative terminal outcome (from the poll) */}
      <OutcomePanel poll={poll.data} />

      <DecisionBadge decision={state.decision} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Panel title="Pipeline">
            <StageTimeline stages={state.stages} />
          </Panel>

          <NegotiationStream neg={state.negotiation} />

          <Panel title="Gatekeeper — rule trace">
            <RuleTable rules={state.rules} />
          </Panel>

          {state.escalationCreated && (
            <EscalationPanel created={state.escalationCreated} resolved={state.escalationResolved} />
          )}

          {state.settlement.length > 0 && (
            <Panel title="Settlement">
              <SettlementChecklist steps={state.settlement} />
            </Panel>
          )}

          <Panel title="Explanation">
            <NarrativeCard narrative={state.narrative} />
          </Panel>
        </div>

        <aside className="space-y-4">
          <Panel title="Audit log">
            <EventLogRail log={state.log} />
          </Panel>
        </aside>
      </div>
    </div>
  );
}
