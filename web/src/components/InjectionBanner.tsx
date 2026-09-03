/**
 * web/src/components/InjectionBanner.tsx — the prompt-injection record.
 *
 * Two phases, and the distinction matters: "detected" means the heuristic tagger
 * flagged the untrusted note at intake; "blocked" means the gatekeeper then
 * refused the cart on rule ground truth. The second is the claim worth making —
 * detection alone stops nothing — so the heading only upgrades once a DECLINE
 * actually exists.
 *
 * The matched snippets are quoted verbatim because that is the evidence. They
 * are untrusted text rendered as React children, so they are escaped, never
 * interpreted.
 */
import type { EventPayloadMap } from "@growthagent/shared";
import { Chip, Mono } from "./ui.js";

type Injection = EventPayloadMap["injection_flagged"];
type Decision = EventPayloadMap["gatekeeper_decision"];

export function InjectionBanner({
  inj,
  decision,
}: {
  inj: Injection | null;
  decision: Decision | null;
}): JSX.Element | null {
  if (inj === null) return null;

  const blocked = decision?.decision === "DECLINE";
  const declines = decision?.declines ?? [];
  const truncated = inj.customer_note_len > inj.customer_note_preview.length;

  return (
    <section className="rounded-xl border border-bad/40 bg-panel p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-bad-bright">
            {blocked ? "Injection blocked by gatekeeper" : "Injection attempt detected"}
          </h2>
          <p className="mt-0.5 text-[11px] text-mute">
            {blocked
              ? "The note was flagged at intake and the cart was refused on rule ground truth."
              : "Flagged at intake. The note is data — it never reached the money path."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="bad">{inj.severity.toLowerCase()} severity</Chip>
          <span className="text-[11px] text-mute">{inj.detector.toLowerCase()}</span>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
        {inj.patterns_matched.map((p) => (
          <span key={p} className="font-mono text-[11px] text-bad-bright">
            {p.replace(/_/g, " ").toLowerCase()}
          </span>
        ))}
      </div>

      <div className="mt-4 space-y-1 border-l-2 border-bad pl-4">
        {inj.matched_snippets.map((s, i) => (
          <p key={i} className="font-mono text-[12px] text-ink">
            “{s}”
          </p>
        ))}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-mute">
        Full note: “{inj.customer_note_preview}
        {truncated ? "…" : ""}”
      </p>

      <footer className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4 text-[11px]">
        <span className="flex items-center gap-2 text-mute">
          agent
          <Mono value={inj.agent_identity_hash} truncate className="max-w-[130px]" />
        </span>
        {blocked && declines.length > 0 && (
          <span className="text-bad-bright">
            caught by: {declines.map((d) => d.rule_id.replace(/^GK-/, "")).join(", ")}
          </span>
        )}
        {decision?.decision === "APPROVE" && (
          <span className="text-warn-bright">
            Approved on rule ground truth despite the flag — recorded for audit.
          </span>
        )}
      </footer>
    </section>
  );
}
