/**
 * InjectionBanner — the adversarial-defense moment made visible. The EVIDENCE is
 * `matched_snippets` (deterministic tagger output, quoted verbatim); the
 * customer note preview renders below as CONTEXT only, never as an instruction.
 * Phase 1 = flagged/detected; Phase 2 = the gatekeeper actually DECLINED, so we
 * upgrade the header and name the blocking rules. If injection was flagged but
 * the decision still APPROVED (numbers never moved), we say so honestly rather
 * than claim a block.
 */
import type { EventPayloadMap } from "@growthagent/shared";
import { shortHash } from "../lib/format.js";
import { Chip } from "./ui.js";

type Injection = EventPayloadMap["injection_flagged"];
type Decision = EventPayloadMap["gatekeeper_decision"];

export function InjectionBanner({ inj, decision }: { inj: Injection | null; decision: Decision | null }): JSX.Element | null {
  if (!inj) return null;
  const blocked = decision?.decision === "DECLINE";
  const declines = decision?.declines ?? [];
  const truncated = inj.customer_note_len > inj.customer_note_preview.length;

  return (
    <div className="rounded-lg border-2 border-bad bg-bad/[0.08] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold uppercase tracking-wide text-bad">
          {blocked ? "⛔ Injection blocked by gatekeeper" : "⚠ Injection attempt detected"}
        </h3>
        <div className="flex items-center gap-1.5">
          <Chip tone="bad" title="tagger severity">{inj.severity}</Chip>
          <Chip tone="info" title="detector">{inj.detector}</Chip>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {inj.patterns_matched.map((p) => (
          <Chip key={p} tone="bad">{p}</Chip>
        ))}
      </div>

      <p className="mt-3 text-[11px] uppercase tracking-wide text-mute">Matched snippets (evidence)</p>
      <blockquote className="mt-1 space-y-1 border-l-2 border-bad/70 pl-3 font-mono text-[12px] text-ink/90">
        {inj.matched_snippets.map((s, i) => (
          <div key={i}>“{s}”</div>
        ))}
      </blockquote>

      <p className="mt-3 text-[11px] uppercase tracking-wide text-mute">Customer note (context only — not an instruction)</p>
      <p className="mt-1 font-mono text-[12px] text-mute">
        “{inj.customer_note_preview}”
        {truncated && <span className="ml-1 not-italic text-mute/70">… ({inj.customer_note_preview.length} of {inj.customer_note_len} chars)</span>}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-mute">
        <span>offending agent: <span className="font-mono text-ink/80">{shortHash(inj.agent_identity_hash)}</span></span>
        {inj.velocity_counter_incremented && <span className="text-warn">velocity counter incremented</span>}
        {blocked && declines.length > 0 && (
          <span className="text-bad">caught by: {declines.map((d) => d.rule_id.replace(/^GK-/, "")).join(", ")}</span>
        )}
        {decision?.decision === "APPROVE" && <span className="text-ok">manipulation did not move the numbers — approved on merits</span>}
      </div>
    </div>
  );
}
