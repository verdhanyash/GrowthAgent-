/**
 * web/src/components/SettlementChecklist.tsx — the money rail, step by step.
 *
 * One row per settlement_step event: stock hold, Razorpay order, payment
 * capture, webhook. Retries show as their own row with an attempt number rather
 * than silently replacing the first try — a settlement that succeeded on attempt
 * three is a different story from one that succeeded immediately.
 */
import { formatPaise, type EventPayloadMap } from "@growthagent/shared";
import { Chip, Empty, Mono } from "./ui.js";

type Step = EventPayloadMap["settlement_step"];

function tone(status: string): "ok" | "bad" | "run" | "default" {
  const s = status.toUpperCase();
  if (s === "SUCCEEDED" || s === "OK" || s === "PAID") return "ok";
  if (s === "FAILED") return "bad";
  if (s === "STARTED" || s === "PENDING") return "run";
  return "default";
}

export function SettlementChecklist({ steps }: { steps: Step[] }): JSX.Element {
  if (steps.length === 0) {
    return <Empty>Settlement runs only after the gatekeeper approves.</Empty>;
  }

  return (
    <ol className="divide-y divide-edge/60">
      {steps.map((s, i) => {
        const t = tone(s.status);
        return (
          <li key={`${s.step}-${i}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="w-4 shrink-0 text-right font-mono text-[11px] text-mute">
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="text-[12px] text-ink">
                  {s.step.replace(/_/g, " ").toLowerCase()}
                  {s.attempt > 1 && (
                    <span className="ml-2 text-[11px] text-mute">attempt {s.attempt}</span>
                  )}
                </div>
                {s.razorpay_order_id !== undefined && s.razorpay_order_id !== null && (
                  <Mono value={s.razorpay_order_id} truncate className="max-w-[180px]" />
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {typeof s.amount_paise === "number" && (
                <span className="font-mono text-[12px] text-ink">{formatPaise(s.amount_paise)}</span>
              )}
              {s.error_code !== undefined && s.error_code !== null && (
                <span className="font-mono text-[11px] text-bad-bright">{s.error_code}</span>
              )}
              <Chip tone={t} withDot={t === "run"}>
                {s.status.toLowerCase()}
              </Chip>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
