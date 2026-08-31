/**
 * web/src/components/ui.tsx — the handful of presentational primitives every
 * trace component shares (Panel shell, status/verdict Chip, KV rows, copyable
 * mono). Pure, prop-driven, no data fetching. Colors map to the §6 tokens in
 * tailwind.config.js; every chip carries a TEXT label (never color alone).
 */
import { useState, type ReactNode } from "react";

export function Panel(props: { title?: ReactNode; right?: ReactNode; children: ReactNode; tone?: "default" | "bad" | "ok" | "escalate" }): JSX.Element {
  const ring =
    props.tone === "bad" ? "border-bad/60" : props.tone === "ok" ? "border-ok/50" : props.tone === "escalate" ? "border-escalate/50" : "border-edge";
  return (
    <section className={`rounded-lg border ${ring} bg-panel`}>
      {(props.title || props.right) && (
        <header className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">{props.title}</h2>
          {props.right}
        </header>
      )}
      <div className="p-4">{props.children}</div>
    </section>
  );
}

type ChipTone = "idle" | "run" | "ok" | "bad" | "warn" | "escalate" | "info";
const CHIP: Record<ChipTone, string> = {
  idle: "bg-edge text-mute",
  run: "bg-accent/15 text-accent motion-safe:animate-pulse",
  ok: "bg-ok/15 text-ok",
  bad: "bg-bad/15 text-bad",
  warn: "bg-warn/15 text-warn",
  escalate: "bg-escalate/15 text-escalate",
  info: "bg-mute/15 text-mute",
};

export function Chip(props: { tone: ChipTone; children: ReactNode; title?: string }): JSX.Element {
  return (
    <span title={props.title} className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${CHIP[props.tone]}`}>
      {props.children}
    </span>
  );
}

/** Definition-list row: muted label left, mono value right. */
export function KV(props: { k: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-[13px]">
      <dt className="shrink-0 text-mute">{props.k}</dt>
      <dd className="text-right text-ink">{props.children}</dd>
    </div>
  );
}

/** Click-to-copy monospace token (ids, hashes). Falls back silently if the
 *  clipboard API is unavailable (non-secure context). */
export function Mono(props: { value: string; children?: ReactNode; className?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(props.value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 900);
      },
      () => undefined,
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="click to copy"
      className={`rounded font-mono text-[12px] text-ink/90 hover:bg-edge/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${props.className ?? ""}`}
    >
      {props.children ?? props.value}
      {copied && <span className="ml-1 text-ok">✓</span>}
    </button>
  );
}

export function Empty(props: { children: ReactNode }): JSX.Element {
  return <p className="py-2 text-[13px] italic text-mute">{props.children}</p>;
}
