/**
 * web/src/components/EventLogRail.tsx — the raw hash-chained audit log.
 *
 * The forensic backstop: one line per durable event, in sequence, with the seq
 * number that IS the SSE id and the actor that wrote it. Deliberately plain —
 * this is the thing you read when you distrust everything above it, so it should
 * look like a log and not like a feature.
 */
import type { LogRow } from "../hooks/traceReducer.js";
import { clockTime } from "../lib/format.js";
import { Empty } from "./ui.js";

/** Actors get a text label, not a coloured pill — there can be dozens of rows. */
const ACTOR_INK: Record<string, string> = {
  BUYER: "text-warn-bright",
  GATEKEEPER: "text-ink",
  SETTLEMENT: "text-ok-bright",
  NEGOTIATION: "text-escalate-bright",
};

export function EventLogRail({ log }: { log: LogRow[] }): JSX.Element {
  if (log.length === 0) return <Empty>No durable event has arrived yet.</Empty>;

  return (
    <ol className="max-h-[420px] space-y-0.5 overflow-y-auto font-mono text-[11px]">
      {log.map((r, i) => (
        <li key={`${r.seq}-${i}`} className="flex items-baseline gap-3 py-1">
          <span className="w-8 shrink-0 text-right text-mute">
            {r.seq === null || r.seq === undefined ? "·" : r.seq}
          </span>
          <span className="w-16 shrink-0 text-mute">{clockTime(r.ts)}</span>
          <span className="min-w-0 flex-1 truncate text-ink-muted">{r.event}</span>
          {r.actor !== null && r.actor !== undefined && (
            <span className={`shrink-0 ${ACTOR_INK[r.actor] ?? "text-mute"}`}>
              {r.actor.toLowerCase()}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
