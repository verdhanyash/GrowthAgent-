/**
 * NarrativeCard — the explainer's prose, structurally quarantined. The narrative
 * is NON-AUTHORITATIVE (the gatekeeper decision + rule trace are ground truth);
 * we render it LAST, inside a dashed chassis with a persistent chip, and — per
 * the social-engineering firewall — as PLAIN TEXT only: markdown/HTML/link
 * syntax is stripped so no anchor or image can ride in through `body_md`. The
 * `non_authoritative: true` field is enforced at the type level in shared.
 */
import type { EventPayloadMap } from "@growthagent/shared";
import { Chip, Empty } from "./ui.js";

type Narrative = EventPayloadMap["explanation_narrative"];

/** Strip anything that could render as a link/tag/image and collapse markdown
 *  emphasis to its text. Output is inserted as a text node by React (already
 *  entity-safe), so this only needs to neutralize link/anchor SYNTAX. */
export function toPlainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")        // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")     // [text](url) → text
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")           // html tags
    .replace(/https?:\/\/\S+/g, "[link removed]") // bare urls
    .replace(/[*_`~]{1,3}/g, "")                   // emphasis/code marks
    .replace(/^#{1,6}\s+/gm, "")                   // heading markers
    .trim();
}

export function NarrativeCard({ narrative }: { narrative: Narrative | null }): JSX.Element {
  if (!narrative) return <Empty>No explanation yet.</Empty>;
  return (
    <div className="rounded-lg border border-dashed border-mute/60 bg-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-semibold text-ink">{toPlainText(narrative.title)}</span>
        <div className="flex items-center gap-1.5">
          {narrative.degraded && <Chip tone="warn">degraded</Chip>}
          <Chip tone="info" title="the rule trace is authoritative, not this text">AI commentary — non-authoritative</Chip>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-ink/90">{toPlainText(narrative.body_md)}</p>
      {narrative.grounded_on_events.length > 0 && (
        <p className="mt-3 text-[11px] text-mute">grounded on seqs: {narrative.grounded_on_events.join(", ")}</p>
      )}
    </div>
  );
}
