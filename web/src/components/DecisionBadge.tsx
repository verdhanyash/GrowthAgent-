/**
 * DecisionBadge — the gatekeeper's verdict stamp. Big, uppercase, one of the
 * three authoritative outcomes. Color is reinforced with text (§6: never color
 * alone). Renders nothing until the decision event lands.
 */
import type { EventPayloadMap } from "@growthagent/shared";
import { Chip } from "./ui.js";

type Decision = EventPayloadMap["gatekeeper_decision"];

export function DecisionBadge({ decision }: { decision: Decision | null }): JSX.Element | null {
  if (!decision) return null;
  const d = decision.decision;
  const tone = d === "APPROVE" ? "ok" : d === "DECLINE" ? "bad" : "escalate";
  const label = d === "APPROVE" ? "APPROVED" : d === "DECLINE" ? "DECLINED" : "ESCALATED";
  const border = tone === "ok" ? "border-ok" : tone === "bad" ? "border-bad" : "border-escalate";
  const text = tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : "text-escalate";
  return (
    <div className={`flex items-center justify-between gap-4 rounded-lg border-2 ${border} bg-panel px-5 py-3`}>
      <div className={`text-2xl font-bold uppercase tracking-widest ${text}`}>{label}</div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Chip tone="info" title="rules version evaluated">rules v{decision.rules_version_evaluated}</Chip>
        <Chip tone="info" title="total gatekeeper duration">{decision.total_duration_ms}ms</Chip>
      </div>
    </div>
  );
}
