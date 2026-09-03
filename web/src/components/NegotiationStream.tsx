/**
 * web/src/components/NegotiationStream.tsx — what the model proposed.
 *
 * Dashed chassis and a non-authoritative label, because this is the one panel on
 * the screen whose contents nothing trusts: the gatekeeper re-derives every
 * number from evidence regardless of what the model said here. The hidden
 * reasoning trace stays behind a toggle — it is long, ephemeral, and interesting
 * only when you are debugging the model rather than reading the outcome.
 */
import { useState } from "react";
import type { NegotiationView } from "../hooks/traceReducer.js";
import { Chip, Panel } from "./ui.js";

export function NegotiationStream({ neg }: { neg: NegotiationView }): JSX.Element | null {
  const [showThinking, setShowThinking] = useState(false);
  if (neg.text === "" && neg.thinking === "" && !neg.open) return null;

  const stillReasoning = neg.open && neg.text === "";

  return (
    <Panel
      dashedChassis
      title="AI proposal"
      subtitle="Subject to deterministic verification — nothing here moves money."
      right={
        <div className="flex items-center gap-2">
          {neg.open ? <Chip tone="run" withDot>streaming</Chip> : <Chip>complete</Chip>}
          {neg.thinking !== "" && (
            <button
              type="button"
              onClick={() => setShowThinking((v) => !v)}
              aria-expanded={showThinking}
              className="text-[11px] text-mute transition-colors hover:text-ink"
            >
              {showThinking ? "hide reasoning" : "reasoning"}
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {showThinking && neg.thinking !== "" && (
          <p className="whitespace-pre-wrap border-l-2 border-edge-bright pl-4 text-[11px] italic leading-relaxed text-mute">
            {neg.thinking}
          </p>
        )}

        {stillReasoning ? (
          <p className="flex items-center gap-2 text-[12px] text-mute">
            <span className="h-1.5 w-1.5 rounded-full bg-ink-muted motion-safe:animate-pulse" />
            Synthesising a candidate bundle…
          </p>
        ) : (
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
            {neg.text}
            {neg.open && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 bg-ink-muted align-middle motion-safe:animate-pulse" />
            )}
          </p>
        )}
      </div>
    </Panel>
  );
}
