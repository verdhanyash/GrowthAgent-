/**
 * StageTimeline — the pipeline rail.
 *
 * One row per stage the audit log announced, in the order it announced them. A
 * stage can appear twice (a retry gets its own row with its attempt number)
 * because collapsing retries would hide the thing you opened the trace to see.
 *
 * This replaced a 3D WebGL graph of the same nine stages. The graph cost ~600KB
 * of `three`, rendered decoratively on the old overview screen with no data
 * bound to it at all, and answered no question this list does not.
 *
 * Status is never colour alone — every row carries the word.
 */
import type { StageView, StageStatus } from "../hooks/traceReducer.js";
import { humanMs } from "../lib/format.js";
import { Chip, Empty } from "./ui.js";

const DOT: Record<StageStatus, string> = {
  RUNNING: "bg-ink motion-safe:animate-pulse",
  OK: "bg-ok",
  DEGRADED: "bg-warn",
  FAILED: "bg-bad",
};

const CHIP: Record<StageStatus, { tone: "run" | "ok" | "warn" | "bad"; label: string }> = {
  RUNNING: { tone: "run", label: "running" },
  OK: { tone: "ok", label: "ok" },
  DEGRADED: { tone: "warn", label: "degraded" },
  FAILED: { tone: "bad", label: "failed" },
};

export function StageTimeline({ stages }: { stages: StageView[] }): JSX.Element {
  if (stages.length === 0) return <Empty>Waiting for the first stage…</Empty>;

  return (
    <ol className="relative space-y-3 border-l border-edge pl-5">
      {stages.map((st, i) => (
        <li key={`${st.stage}-${st.attempt}-${i}`} className="relative">
          <span
            aria-hidden
            className={`absolute -left-[25px] top-1.5 h-2 w-2 rounded-full ring-4 ring-panel ${DOT[st.status]}`}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[12px] text-ink">{st.stage}</span>
              {st.attempt > 1 && (
                <span className="text-[11px] text-mute">attempt {st.attempt}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {st.durationMs !== null && (
                <span className="text-[11px] tabular-nums text-mute">
                  {humanMs(st.durationMs)}
                </span>
              )}
              <Chip tone={CHIP[st.status].tone}>{CHIP[st.status].label}</Chip>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
