/**
 * NegotiationStream — the live LLM reasoning + proposal narrative, streamed via
 * ephemeral negotiation_token / negotiation_snapshot frames (no seq, not
 * persisted). The thinking trace is visually secondary (muted, collapsible); the
 * narrative is the proposal-in-progress with a blinking caret while open. Adaptive
 * thinking can delay the first visible token — we show a "reasoning…" shimmer
 * rather than an empty dead box.
 */
import { useState } from "react";
import type { NegotiationView } from "../hooks/traceReducer.js";
import { Chip } from "./ui.js";

export function NegotiationStream({ neg }: { neg: NegotiationView }): JSX.Element | null {
  const [showThinking, setShowThinking] = useState(false);
  const idle = neg.text === "" && neg.thinking === "" && !neg.open;
  if (idle) return null;

  const reasoning = neg.open && neg.text === "";
  return (
    <div className="rounded-lg border border-edge bg-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-semibold text-ink">Negotiation</span>
        <div className="flex items-center gap-1.5">
          {neg.open ? <Chip tone="run">streaming</Chip> : <Chip tone="ok">done</Chip>}
          {neg.thinking !== "" && (
            <button type="button" onClick={() => setShowThinking((v) => !v)} className="rounded px-2 py-0.5 text-[11px] text-mute hover:bg-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {showThinking ? "hide reasoning" : "show reasoning"}
            </button>
          )}
        </div>
      </div>

      {showThinking && neg.thinking !== "" && (
        <p className="mt-2 whitespace-pre-wrap border-l-2 border-edge pl-3 font-mono text-[12px] italic leading-relaxed text-mute">{neg.thinking}</p>
      )}

      {reasoning ? (
        <p className="mt-2 font-mono text-[13px] text-mute motion-safe:animate-pulse">model is reasoning…</p>
      ) : (
        <p className="mt-2 whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-ink/90">
          {neg.text}
          {neg.open && <span className="ml-0.5 inline-block motion-safe:animate-pulse">▍</span>}
        </p>
      )}
    </div>
  );
}
