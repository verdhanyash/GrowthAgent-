/**
 * web/src/components/ui.tsx — the whole design system, in one file.
 *
 * The rule this file exists to enforce: a button, a tab, a table, a card and a
 * label look the same on every screen because there is exactly ONE of each.
 * Screens compose these; they never restyle. (Before this, four screens each
 * hand-rolled their own tab pills with slightly different padding — that drift
 * is what made the app feel cluttered even where the content was fine.)
 *
 * Spacing scale, used everywhere and nowhere else:
 *   between sections      40px  (space-y-10)
 *   inside a section      16px  (space-y-4)
 *   card padding          24px  (p-6)
 *   header → body         16px
 * Type scale: 22px page title · 13px section title · 12px body · 11px meta.
 * Colour: one ink, one muted ink, one hairline. Status colour appears on data
 * and verdicts only — never on chrome, and never as the only signal.
 */
import { useState } from "react";
import clsx from "clsx";

export type Tone = "default" | "ok" | "warn" | "bad" | "escalate" | "accent" | "run";

/* ------------------------------- page chassis ------------------------------ */

/**
 * Every screen's header. One h1, one optional sentence, actions on the right.
 * No screen writes its own — which is why they all align to the same baseline.
 */
export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
          {description !== undefined && (
            <p className="mt-1 text-[13px] leading-relaxed text-mute">{description}</p>
          )}
        </div>
        {actions !== undefined && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </header>
      {children}
    </div>
  );
}

/** A titled group of related content. The only heading level below the page. */
export function Section({
  title,
  hint,
  right,
  children,
}: {
  title?: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="space-y-4">
      {(title !== undefined || right !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {title !== undefined && (
              <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
            )}
            {hint !== undefined && <p className="mt-0.5 text-[11px] text-mute">{hint}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Flat container. Kept under its original name because the trace components all
 * import it; restyled quieter (hairline border, no tinted chassis) so twelve of
 * them stacked no longer read as twelve competing boxes.
 */
export function Panel({
  title,
  subtitle,
  right,
  tone = "default",
  dashedChassis = false,
  className,
  children,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  tone?: Tone;
  dashedChassis?: boolean;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  const border = dashedChassis
    ? "border-dashed border-edge-bright"
    : tone === "bad"
      ? "border-bad/40"
      : tone === "warn"
        ? "border-warn/40"
        : tone === "ok"
          ? "border-ok/30"
          : tone === "escalate"
            ? "border-escalate/40"
            : "border-edge";

  return (
    <section className={clsx("rounded-xl border bg-panel", border, className)}>
      {(title !== undefined || right !== undefined) && (
        <header className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
          <div>
            {title !== undefined && (
              <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
            )}
            {subtitle !== undefined && (
              <p className="mt-0.5 text-[11px] text-mute">{subtitle}</p>
            )}
          </div>
          {right !== undefined && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className="p-6">{children}</div>
    </section>
  );
}

/* --------------------------------- controls -------------------------------- */

/**
 * THE tab / filter / range control. Time ranges, outcome filters and screen tabs
 * are the same interaction, so they are the same component — the reason the app
 * now has one navigation idiom instead of four.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex flex-wrap rounded-lg border border-edge bg-panel p-0.5 segmented-group"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={clsx(
              "rounded-md px-3 py-1.5 text-[12px] transition-colors segmented-btn",
              on
                ? "segmented-btn-active bg-neutral-800 text-ink shadow-sm"
                : "text-mute hover:text-ink",
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={clsx("ml-1.5 tabular-nums", on ? "text-ink-muted" : "text-mute")}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Button({
  variant = "secondary",
  className,
  children,
  ...rest
}: {
  variant?: "primary" | "secondary" | "danger";
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const styles =
    variant === "primary"
      ? "bg-ink text-black hover:bg-neutral-200"
      : variant === "danger"
        ? "border border-bad/40 text-bad-bright hover:bg-bad/10"
        : "border border-edge text-ink-muted hover:border-edge-bright hover:text-ink";
  return (
    <button
      type="button"
      className={clsx(
        "rounded-lg px-3.5 py-2 text-[12px] font-medium transition-colors disabled:opacity-40",
        styles,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Labelled input. One label style, one focus ring, everywhere. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[11px] font-medium text-ink-muted">
        {label}
        {hint !== undefined && <span className="ml-1.5 font-normal text-mute">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-edge bg-black px-3 py-2 text-[13px] text-ink placeholder:text-mute/70 outline-none transition-colors focus:border-edge-bright";

/* ------------------------------ data display ------------------------------ */

/**
 * Stat tile: label · value · optional delta · optional trend. The value uses
 * proportional figures on purpose — `tabular-nums` at 26px makes a number like
 * 121 look loose, and tabular is for columns that align vertically, not for a
 * headline.
 */
export function StatTile({
  label,
  value,
  meta,
  tone = "default",
  trend,
}: {
  label: string;
  value: React.ReactNode;
  meta?: string;
  tone?: Tone;
  trend?: React.ReactNode;
}): JSX.Element {
  const valueColor =
    tone === "ok"
      ? "text-ok-bright"
      : tone === "warn"
        ? "text-warn-bright"
        : tone === "bad"
          ? "text-bad-bright"
          : tone === "escalate"
            ? "text-escalate-bright"
            : "text-ink";

  return (
    <div className="rounded-xl border border-edge bg-panel px-5 py-4">
      <div className="text-[11px] text-mute">{label}</div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className={clsx("text-[26px] font-semibold leading-none tracking-tight", valueColor)}>
          {value}
        </div>
        {trend !== undefined && <div className="shrink-0 pb-0.5">{trend}</div>}
      </div>
      {meta !== undefined && <div className="mt-2 text-[11px] text-mute">{meta}</div>}
    </div>
  );
}

/** Retained name for the trace components; now just a StatTile. */
export function StatCard(props: {
  label: string;
  value: React.ReactNode;
  subtitle?: string;
  tone?: Tone;
}): JSX.Element {
  return (
    <StatTile
      label={props.label}
      value={props.value}
      tone={props.tone}
      {...(props.subtitle !== undefined ? { meta: props.subtitle } : {})}
    />
  );
}

/**
 * Status token. Quieter than before: no uppercase, no glow, no border on the
 * neutral case — a screen with fifteen chips should read as content, not
 * confetti. Colour is always accompanied by the word itself.
 */
export function Chip({
  tone = "default",
  withDot = false,
  className,
  title,
  children,
}: {
  tone?: Tone;
  withDot?: boolean;
  className?: string;
  title?: string;
  children: React.ReactNode;
}): JSX.Element {
  const styles: Record<Tone, string> = {
    default: "bg-neutral-900 text-ink-muted",
    ok: "bg-ok/10 text-ok-bright",
    warn: "bg-warn/10 text-warn-bright",
    bad: "bg-bad/10 text-bad-bright",
    escalate: "bg-escalate/10 text-escalate-bright",
    accent: "bg-neutral-800 text-ink",
    run: "bg-neutral-900 text-ink-muted",
  };
  const dots: Record<Tone, string> = {
    default: "bg-mute",
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    escalate: "bg-escalate",
    accent: "bg-ink",
    run: "bg-ink-muted motion-safe:animate-pulse",
  };

  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium",
        styles[tone],
        className,
      )}
    >
      {withDot && <span className={clsx("h-1.5 w-1.5 rounded-full", dots[tone])} />}
      {children}
    </span>
  );
}

export function KV({
  k,
  children,
  className,
}: {
  k: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={clsx("flex items-baseline justify-between gap-4 py-2", className)}>
      <dt className="shrink-0 text-[11px] text-mute">{k}</dt>
      <dd className="text-right font-mono text-[12px] text-ink">{children}</dd>
    </div>
  );
}

/** Copyable identifier. Reads as text until hovered — it is not a button first. */
export function Mono({
  value,
  truncate = false,
  className,
}: {
  value: string;
  truncate?: boolean;
  className?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — the value is still selectable as text */
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={copied ? "Copied" : "Click to copy"}
      className={clsx(
        "group inline-flex max-w-full items-center gap-1.5 rounded font-mono text-[11px] text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-edge-bright",
        className,
      )}
    >
      <span className={truncate ? "truncate" : ""}>{value}</span>
      <span className="text-[10px] text-mute opacity-0 transition-opacity group-hover:opacity-100">
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}

export function Empty({ children }: { icon?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return <p className="py-10 text-center text-[12px] text-mute">{children}</p>;
}

/** One table style. Headers are meta-sized, numbers are tabular and right-aligned. */
export function DataTable<R>({
  rows,
  columns,
  rowKey,
  onRowClick,
  empty = "Nothing to show.",
}: {
  rows: readonly R[];
  columns: readonly {
    header: string;
    numeric?: boolean;
    className?: string;
    cell: (row: R) => React.ReactNode;
  }[];
  rowKey: (row: R) => string;
  onRowClick?: (row: R) => void;
  empty?: string;
}): JSX.Element {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-edge text-left text-[10px] uppercase tracking-wider text-mute">
            {columns.map((c) => (
              <th
                key={c.header}
                scope="col"
                className={clsx("py-2.5 pr-4 font-medium", c.numeric === true && "text-right")}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-edge/60">
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              onClick={onRowClick === undefined ? undefined : () => onRowClick(r)}
              className={clsx(
                onRowClick !== undefined && "cursor-pointer transition-colors hover:bg-neutral-900/50",
              )}
            >
              {columns.map((c) => (
                <td
                  key={c.header}
                  className={clsx(
                    "py-3 pr-4 align-middle",
                    c.numeric === true ? "text-right font-mono tabular-nums text-ink" : "text-ink-muted",
                    c.className,
                  )}
                >
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
