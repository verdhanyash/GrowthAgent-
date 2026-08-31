/**
 * EventLogRail — the raw audit spine: one row per durable envelope the reducer
 * folded, in seq order. This is the "show your work" panel — every claim in the
 * pretty cards traces back to a seq here. Newest at the bottom (append order).
 */
import type { LogRow } from "../hooks/traceReducer.js";
import { clockTime } from "../lib/format.js";
import { Empty } from "./ui.js";

const ACTOR_TONE: Record<string, string> = {
  BUYER: "text-warn",
  GATEKEEPER: "text-accent",
  SETTLEMENT: "text-ok",
  SYSTEM: "text-mute",
};

export function EventLogRail({ log }: { log: LogRow[] }): JSX.Element {
  if (log.length === 0) return <Empty>No events yet.</Empty>;
  return (
    <div className="max-h-[420px] overflow-y-auto">
      <table className="w-full border-collapse text-[12px]">
        <tbody>
          {log.map((r, i) => (
            <tr key={`${r.seq}-${i}`} className="border-t border-edge/40">
              <td className="w-10 py-1 pr-2 text-right font-mono text-mute">{r.seq ?? "·"}</td>
              <td className="w-20 py-1 pr-2 font-mono text-mute">{clockTime(r.ts)}</td>
              <td className="py-1 pr-2 font-mono text-ink/90">{r.event}</td>
              <td className={`w-24 py-1 text-right font-mono ${r.actor ? (ACTOR_TONE[r.actor] ?? "text-mute") : "text-mute"}`}>{r.actor ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
