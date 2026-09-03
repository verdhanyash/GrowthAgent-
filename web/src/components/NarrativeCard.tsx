/**
 * web/src/components/NarrativeCard.tsx — the explainer's plain-English summary.
 *
 * This text is LLM output, so it is treated as hostile input on the way in:
 * `toPlainText` strips markdown links, images, HTML tags and bare URLs before
 * anything renders. That is a social-engineering firewall, not cosmetics — a
 * narrative that could render a clickable link could phish the operator reading
 * it. The NON-AUTHORITATIVE label is always present for the same reason.
 */
import type { EventPayloadMap } from "@growthagent/shared";
import { Chip } from "./ui.js";

type Narrative = EventPayloadMap["explanation_narrative"];

export function toPlainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/<\/?[a-zA-Z][^>]*>/g, "") // html tags
    .replace(/https?:\/\/\S+/g, "[link removed]") // bare urls
    .replace(/[*_`~]{1,3}/g, "") // emphasis/code marks
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .trim();
}

export function NarrativeCard({ narrative }: { narrative: Narrative | null }): JSX.Element | null {
  if (narrative === null) return null;

  return (
    <section className="rounded-xl border border-dashed border-edge-bright bg-panel p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-ink">{toPlainText(narrative.title)}</h3>
        <div className="flex items-center gap-2">
          {narrative.degraded && <Chip tone="warn">degraded</Chip>}
          <Chip>AI commentary · non-authoritative</Chip>
        </div>
      </header>

      <p className="mt-4 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
        {toPlainText(narrative.body_md)}
      </p>

      {narrative.grounded_on_events.length > 0 && (
        <p className="mt-4 border-t border-edge pt-3 text-[11px] text-mute">
          Grounded on audit events {narrative.grounded_on_events.map((s) => `#${s}`).join(", ")}
        </p>
      )}
    </section>
  );
}
