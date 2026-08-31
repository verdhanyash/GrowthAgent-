/**
 * StageTimeline — the vertical pipeline rail. One row per stage the audit log
 * announced (INTAKE→…→EXPLAIN), newest state folded by the reducer. A stage may
 * appear more than once (retries) — each StageView is its own row with its
 * attempt number. Status drives the left dot + chip; color is always paired
 * with a text label (§6).
 */
import type { StageView, StageStatus } from "../hooks/traceReducer.js";
import { humanMs } from "../lib/format.js";
import { Chip, Empty } from "./ui.js";

const DOT: Record<StageStatus, string> = {
  RUNNING: "bg-accent motion-safe:animate-pulse",
  OK: "bg-ok",
  DEGRADED: "bg-escalate",
  FAILED: "bg-bad",
};

function statusChip(s: StageStatus): JSX.Element {
  switch (s) {
    case "RUNNING":
      return <Chip tone="run">running</Chip>;
    case "OK":
      return <Chip tone="ok">ok</Chip>;
    case "DEGRADED":
      return <Chip tone="escalate">degraded</Chip>;
    case "FAILED":
      return <Chip tone="bad">failed</Chip>;
  }
}

export function StageTimeline({ stages }: { stages: StageView[] }): JSX.Element {
  if (stages.length === 0) return <Empty>Awaiting first stage…</Empty>;
  return (
    <ol className="relative ml-1 space-y-3 border-l border-edge pl-5">
      {stages.map((st, i) => (
        <li key={`${st.stage}-${st.attempt}-${i}`} className="relative">
          <span className={`absolute -left-[26px] top-1 h-3 w-3 rounded-full ring-2 ring-panel ${DOT[st.status]}`} />
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-ink">{st.stage}</span>
              {st.attempt > 1 && <span className="text-[11px] text-mute">attempt {st.attempt}</span>}
            </div>
            <div className="flex items-center gap-2">
              {st.durationMs !== null && <span className="text-[11px] text-mute">{humanMs(st.durationMs)}</span>}
              {statusChip(st.status)}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
