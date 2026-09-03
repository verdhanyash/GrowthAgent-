/**
 * web/src/components/DecisionBadge.tsx — the gatekeeper's verdict.
 *
 * Deliberately quiet now. The verdict used to be a 3xl black-uppercase stamp
 * with an icon tile, which shouted the one thing the reader had already learned
 * from the trace header two inches above it. What actually earns space here is
 * the *evidence* the verdict is deterministic: which policy version ran, how
 * long it took, and the digest of the exact input it ran on.
 *
 * Colour never carries the verdict alone — the word is always present.
 */
import type { EventPayloadMap } from "@growthagent/shared";
import { humanMs } from "../lib/format.js";
import { Chip, Mono } from "./ui.js";

type Decision = EventPayloadMap["gatekeeper_decision"];

export function DecisionBadge({ decision }: { decision: Decision | null }): JSX.Element | null {
  if (decision === null) return null;

  const d = decision.decision;
  const tone = d === "APPROVE" ? "ok" : d === "DECLINE" ? "bad" : "escalate";
  const label = d === "APPROVE" ? "Approved" : d === "DECLINE" ? "Declined" : "Escalated";
  const border =
    tone === "ok" ? "border-ok/30" : tone === "bad" ? "border-bad/40" : "border-escalate/40";

  return (
    <section className={`rounded-xl border bg-panel px-6 py-5 ${border}`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Chip tone={tone} withDot>
            {label}
          </Chip>
          <span className="text-[12px] text-mute">
            by the deterministic gatekeeper, on policy v{decision.rules_version_evaluated}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-[11px] text-mute">
          <span>{humanMs(decision.total_duration_ms)}</span>
          {decision.input_digest !== undefined && decision.input_digest !== null && (
            <span className="flex items-center gap-1.5">
              input
              <Mono value={decision.input_digest} truncate className="max-w-[110px]" />
            </span>
          )}
        </div>
      </div>

      {decision.declines.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-edge pt-4">
          {decision.declines.map((r) => (
            <li key={r.rule_id} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
              <span className="font-mono text-bad-bright">{r.rule_id.replace(/^GK-/, "")}</span>
              <span className="text-ink-muted">{r.human_message}</span>
            </li>
          ))}
        </ul>
      )}

      {decision.escalations.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-edge pt-4">
          {decision.escalations.map((r) => (
            <li key={r.rule_id} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
              <span className="font-mono text-escalate-bright">
                {r.rule_id.replace(/^GK-/, "")}
              </span>
              <span className="text-ink-muted">{r.human_message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
