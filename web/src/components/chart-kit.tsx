/**
 * web/src/components/chart-kit.tsx — the shared chassis every chart sits in.
 *
 * Three jobs, so no individual chart has to reinvent them:
 *  - `useMeasure` gives real pixel width, so SVG text stays 11px at every
 *    breakpoint (a scaled viewBox would stretch the type with the plot).
 *  - `ChartCard` owns the title, the legend, and the table-view toggle. Tooltips
 *    enhance but never gate: every chart ships a table twin holding the same
 *    numbers, reachable without a pointer.
 *  - `Tip` is one tooltip implementation — value first, series name second,
 *    keyed by a short stroke of the series colour rather than a filled box.
 *
 * Labels arrive from the API, so they are untrusted text: everything here
 * renders them as React children (escaped), never through innerHTML.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { VIZ } from "../lib/viz.js";

/** Container width in CSS pixels, tracked across resizes. */
export function useMeasure<T extends HTMLElement>(): [
  React.RefObject<T>,
  number,
] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // jsdom has no ResizeObserver; fall back to the one-shot measurement so
    // component tests render a real plot instead of an empty frame.
    if (typeof ResizeObserver === "undefined") {
      setWidth(el.clientWidth || 640);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

export interface LegendItem {
  label: string;
  color: string;
  /** Lines key with a stroke, bars/areas with a rect (mirror the mark). */
  shape?: "rect" | "line";
}

/** A legend is mandatory for two or more series and pointless for one. */
export function Legend({ items }: { items: readonly LegendItem[] }): JSX.Element | null {
  if (items.length < 2) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5 text-[11px] text-mute">
          <span
            aria-hidden
            style={{ background: it.color }}
            className={
              it.shape === "line"
                ? "h-[2px] w-3 rounded-full"
                : "h-2 w-2 rounded-[2px]"
            }
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export interface TableColumn<R> {
  header: string;
  /** Right-align + tabular figures for numbers; left for names. */
  numeric?: boolean;
  cell: (row: R) => React.ReactNode;
}

/**
 * The table twin. Not a fallback — the WCAG-clean equivalent of the chart, so
 * no value in this app is reachable only by hovering.
 */
export function TableView<R>({
  rows,
  columns,
}: {
  rows: readonly R[];
  columns: readonly TableColumn<R>[];
}): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-edge text-left text-[10px] uppercase tracking-wider text-mute">
            {columns.map((c) => (
              <th
                key={c.header}
                scope="col"
                className={`py-2 pr-4 font-medium ${c.numeric === true ? "text-right" : ""}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-edge/60">
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td
                  key={c.header}
                  className={`py-2 pr-4 ${
                    c.numeric === true
                      ? "text-right font-mono tabular-nums text-ink"
                      : "text-ink-muted"
                  }`}
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

export interface TipRow {
  label: string;
  value: string;
  color?: string;
}

/** Hover/focus readout. Values lead, series names follow. */
export function Tip({
  x,
  y,
  title,
  rows,
  width,
}: {
  x: number;
  y: number;
  title: string;
  rows: readonly TipRow[];
  width: number;
}): JSX.Element {
  // Flip before the right edge so the readout never leaves the card.
  const flip = x > width - 150;
  return (
    <div
      role="tooltip"
      style={{
        left: flip ? undefined : x + 12,
        right: flip ? Math.max(8, width - x + 12) : undefined,
        top: Math.max(4, y - 8),
      }}
      className="pointer-events-none absolute z-20 min-w-[130px] rounded-lg border border-edge bg-black/95 px-3 py-2 shadow-md backdrop-blur"
    >
      <div className="text-[10px] uppercase tracking-wider text-mute">{title}</div>
      <dl className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              {r.color !== undefined && (
                <span
                  aria-hidden
                  style={{ background: r.color }}
                  className="h-[2px] w-2.5 rounded-full"
                />
              )}
              {r.label}
            </dt>
            <dd className="font-mono text-[12px] font-semibold text-ink tabular-nums">
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The chassis: one title row, one legend, one toggle, generous padding. Every
 * chart on every screen sits in this so spacing and hierarchy cannot drift
 * between screens.
 *
 * `empty` is rendered instead of the plot when there is genuinely nothing to
 * show — an honest "no data in this window" beats an axis around thin air.
 */
export function ChartCard({
  title,
  hint,
  legend,
  right,
  table,
  empty,
  children,
}: {
  title: string;
  hint?: string;
  legend?: readonly LegendItem[];
  right?: React.ReactNode;
  /** The WCAG-clean twin. Omit only for a chart that has no values (rare). */
  table?: React.ReactNode;
  empty?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const [asTable, setAsTable] = useState(false);
  const toggle = useCallback(() => setAsTable((v) => !v), []);

  return (
    <section className="rounded-xl border border-edge bg-panel">
      <header className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
          {hint !== undefined && <p className="mt-0.5 text-[11px] text-mute">{hint}</p>}
        </div>
        <div className="flex items-center gap-3">
          {right}
          {table !== undefined && !empty && (
            <button
              type="button"
              onClick={toggle}
              aria-pressed={asTable}
              className="rounded-md border border-edge px-2 py-1 text-[11px] text-mute transition-colors hover:border-edge-bright hover:text-ink"
            >
              {asTable ? "Chart" : "Table"}
            </button>
          )}
        </div>
      </header>

      {legend !== undefined && !empty && (
        <div className="px-6 pt-3">
          <Legend items={legend} />
        </div>
      )}

      <div className="px-6 pb-6 pt-4">
        {empty === true ? (
          <p className="py-10 text-center text-[12px] text-mute">
            No activity in this window.
          </p>
        ) : asTable && table !== undefined ? (
          table
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/**
 * Shared y-axis ticks: clean round numbers, never 0/3.33/6.67.
 *
 * `integral` forbids fractional steps, which matters more than it sounds: a
 * count of transactions cannot be 7.5, and an axis that offers 2.5 as a
 * gridline invites the reader to read a value that cannot exist.
 */
export function niceTicks(max: number, count = 4, integral = true): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const candidates = (integral ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]).map((m) => m * mag);
  let step = candidates.find((s) => s >= raw) ?? mag * 10;
  if (integral) step = Math.max(1, Math.round(step));
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/** Axis + gridline styling, identical in every plot. */
export const AXIS_TEXT = {
  fill: VIZ.muted,
  fontSize: 10,
} as const;
