/**
 * SettlementChecklist — the post-approval money rail, step by step. Each
 * settlement_step event is appended by the reducer (retries included), so we
 * show them in arrival order with status ticks. RAZORPAY_ORDER_CREATE success
 * reveals the order id; amounts render through shared's integer-paise formatter.
 * The provider mode (mock vs razorpay_test) is shown honestly — never hidden.
 */
import { formatPaise, type EventPayloadMap } from "@growthagent/shared";
import { Chip, Empty, Mono } from "./ui.js";

type Step = EventPayloadMap["settlement_step"];

function statusChip(status: string): JSX.Element {
  const s = status.toUpperCase();
  if (s === "SUCCEEDED" || s === "OK") return <Chip tone="ok">✓ {status.toLowerCase()}</Chip>;
  if (s === "FAILED") return <Chip tone="bad">✕ failed</Chip>;
  if (s === "STARTED" || s === "PENDING") return <Chip tone="run">{status.toLowerCase()}</Chip>;
  return <Chip tone="info">{status.toLowerCase()}</Chip>;
}

export function SettlementChecklist({ steps }: { steps: Step[] }): JSX.Element {
  if (steps.length === 0) return <Empty>No settlement steps (only runs after APPROVE).</Empty>;
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => (
        <li key={`${s.step}-${i}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-edge/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-ink">{s.step}</span>
            {s.attempt > 1 && <span className="text-[11px] text-mute">try {s.attempt}</span>}
            {s.provider_mode && <Chip tone="info">{s.provider_mode}</Chip>}
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            {typeof s.amount_paise === "number" && <span className="text-ink/90">{formatPaise(s.amount_paise)}</span>}
            {s.razorpay_order_id && <Mono value={s.razorpay_order_id} />}
            {s.error_code && <span className="text-bad">{s.error_code}</span>}
            {statusChip(s.status)}
          </div>
        </li>
      ))}
    </ol>
  );
}
