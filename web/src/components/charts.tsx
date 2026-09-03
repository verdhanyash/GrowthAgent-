/**
 * web/src/components/charts.tsx — the three chart forms this app needs.
 *
 * Deliberately three, not ten. Every panel on the analytics screen is one of:
 *  - `StackedColumns` — volume over time, split by verdict (part-to-whole over
 *    a time axis). SVG, because the geometry is the point.
 *  - `BarRows` — magnitude comparison across named rows (verdict mix, which
 *    rules bite, stage latency). Plain HTML/flex: a percentage-width fill obeys
 *    the same mark spec as an SVG rect, and text can never clip or overflow.
 *  - `Sparkline` — the 12-point trend inside a stat tile. No axes, no tooltip.
 *
 * Mark spec, applied identically in all three: marks ≤24px thick, 4px rounded
 * data-end and square at the baseline, 2px surface-coloured gap doing the
 * separating (never a stroke around a mark), hairline solid gridlines one step
 * off the surface, and no number printed on every point — the axis, the legend
 * and the tooltip carry what direct labels do not.
 */
import { useState } from "react";
import { VIZ, wash } from "../lib/viz.js";
import { AXIS_TEXT, Tip, niceTicks, useMeasure, type TipRow } from "./chart-kit.js";

export interface StackSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface StackBucket {
  /** Short axis tick (e.g. "14:00", "Sep 2"). */
  label: string;
  /** Full label for the tooltip title. */
  full: string;
  segments: readonly StackSegment[];
}

const PAD = { top: 10, right: 10, bottom: 24, left: 38 } as const;
/** Bars never fill their band — the leftover is the air the chart breathes. */
const MAX_BAR = 24;
/** The surface-coloured gap that separates stacked segments. */
const GAP = 2;

/**
 * Stacked columns on a time axis.
 *
 * The hover model is nearest-band, not hit-the-bar: the pointer only has to be
 * closest to a column, which is what makes a 20px-wide daily bucket usable. The
 * same index is driveable from the keyboard with the arrow keys, and focus shows
 * exactly what hover shows.
 */
export function StackedColumns({
  buckets,
  height = 200,
  format = (n: number) => String(n),
}: {
  buckets: readonly StackBucket[];
  height?: number;
  format?: (n: number) => string;
}): JSX.Element {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = Math.max(0, height - PAD.top - PAD.bottom);
  const totals = buckets.map((b) => b.segments.reduce((s, g) => s + g.value, 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const yMax = ticks[ticks.length - 1] ?? 1;

  const band = buckets.length > 0 ? plotW / buckets.length : plotW;
  const barW = Math.min(MAX_BAR, band * 0.62);
  const yOf = (v: number): number => PAD.top + plotH - (v / yMax) * plotH;
  const xOf = (i: number): number => PAD.left + band * i + band / 2;

  /** Every ~Nth tick only, so labels never collide at 30 buckets on mobile. */
  const tickEvery = Math.max(1, Math.ceil(buckets.length / Math.max(4, Math.floor(plotW / 70))));

  const move = (clientX: number, rect: DOMRect): void => {
    const rel = clientX - rect.left - PAD.left;
    const i = Math.floor(rel / band);
    setActive(i >= 0 && i < buckets.length ? i : null);
  };

  const activeBucket = active === null ? undefined : buckets[active];
  const rows: TipRow[] =
    activeBucket === undefined
      ? []
      : activeBucket.segments.map((g) => ({
          label: g.label,
          value: format(g.value),
          color: g.color,
        }));

  return (
    <div ref={ref} className="relative">
      <svg
        width={width || "100%"}
        height={height}
        role="img"
        aria-label="Transaction volume over time, split by outcome"
        className="block touch-none"
        tabIndex={0}
        onPointerMove={(e) => move(e.clientX, e.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          setActive((prev) => {
            const next = (prev ?? -1) + (e.key === "ArrowRight" ? 1 : -1);
            return Math.max(0, Math.min(buckets.length - 1, next));
          });
        }}
      >
        {/* Hairline grid, one step off the surface, solid — never dashed. */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={yOf(t)}
              y2={yOf(t)}
              stroke={t === 0 ? VIZ.axis : VIZ.grid}
              strokeWidth={1}
            />
            <text {...AXIS_TEXT} x={PAD.left - 8} y={yOf(t) + 3} textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}

        {buckets.map((b, i) => {
          let cursor = 0;
          return (
            <g key={b.full}>
              {active === i && (
                <rect
                  x={PAD.left + band * i}
                  y={PAD.top}
                  width={band}
                  height={plotH}
                  fill={wash(VIZ.ink, 0.04)}
                />
              )}
              {b.segments.map((g) => {
                if (g.value <= 0) return null;
                const full = (g.value / yMax) * plotH;
                const y = PAD.top + plotH - cursor - full;
                cursor += full;
                // Square at the baseline, rounded only at the data end: the top
                // segment of the stack is the one that gets the radius.
                const isTop = cursor >= (totals[i] ?? 0) / yMax * plotH - 0.5;
                const h = Math.max(1, full - GAP);
                return (
                  <rect
                    key={g.key}
                    x={xOf(i) - barW / 2}
                    y={y}
                    width={barW}
                    height={h}
                    rx={isTop ? 4 : 0}
                    fill={g.color}
                  />
                );
              })}
            </g>
          );
        })}

        {buckets.map((b, i) =>
          i % tickEvery === 0 ? (
            <text
              key={`t-${b.full}`}
              {...AXIS_TEXT}
              x={xOf(i)}
              y={height - 8}
              textAnchor="middle"
            >
              {b.label}
            </text>
          ) : null,
        )}
      </svg>

      {activeBucket !== undefined && (
        <Tip
          x={xOf(active ?? 0)}
          y={PAD.top}
          width={width}
          title={activeBucket.full}
          rows={[
            ...rows,
            { label: "Total", value: format(totals[active ?? 0] ?? 0) },
          ]}
        />
      )}
    </div>
  );
}

export interface BarRow {
  /** Row identity. Also the accessible name of the bar. */
  label: string;
  value: number;
  /** Secondary line under the label (never carries the data colour). */
  sub?: string;
  /** Omit for a single-series chart: every bar takes slot-1 and needs no legend. */
  color?: string;
  /** A second measure drawn as a thin tick, e.g. p95 behind a p50 bar. */
  marker?: { value: number; label: string };
  /** Extra tooltip rows — things worth knowing but not worth a column. */
  extra?: readonly TipRow[];
}

/**
 * Horizontal magnitude bars with the value always printed at the tip.
 *
 * Horizontal because the row names are long (`GK-PROPOSAL-FRESHNESS`,
 * `CAMPAIGN_INJECT`) and a column chart would rotate them. The value label is
 * outside the bar end, so it can never be clipped by a short bar — the failure
 * mode of in-bar labels — and it means colour is never the only channel: the
 * row reads correctly in greyscale, which is what lets the verdict colours be
 * status tokens rather than a validated categorical set.
 */
export function BarRows({
  rows,
  format = (n: number) => String(n),
  emptyNote = "Nothing recorded in this window.",
}: {
  rows: readonly BarRow[];
  format?: (n: number) => string;
  emptyNote?: string;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...rows.map((r) => Math.max(r.value, r.marker?.value ?? 0)), 1);

  if (rows.length === 0) {
    return <p className="py-6 text-center text-[12px] text-mute">{emptyNote}</p>;
  }

  return (
    <ul className="space-y-1">
      {rows.map((r, i) => {
        const pct = (r.value / max) * 100;
        const markerPct =
          r.marker === undefined ? null : Math.min(100, (r.marker.value / max) * 100);
        return (
          <li
            key={r.label}
            // 36px row keeps the pointer target well past the 24px floor even
            // though the painted bar is 12px.
            className="relative grid grid-cols-[minmax(96px,34%)_1fr] items-center gap-3 rounded-md px-1 py-2 outline-none focus-visible:ring-1 focus-visible:ring-edge-bright"
            tabIndex={0}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <div className="min-w-0">
              <div className="truncate text-[12px] text-ink" title={r.label}>
                {r.label}
              </div>
              {r.sub !== undefined && (
                <div className="truncate text-[10px] text-mute">{r.sub}</div>
              )}
            </div>

            <div className="flex items-center gap-2.5">
              <div className="relative h-3 flex-1 rounded-sm" style={{ background: wash(VIZ.ink, 0.035) }}>
                <div
                  className="absolute inset-y-0 left-0 rounded-r-[4px]"
                  style={{
                    width: `${Math.max(r.value > 0 ? 1.5 : 0, pct)}%`,
                    background: r.color ?? VIZ.quiet,
                  }}
                />
                {markerPct !== null && (
                  // 2px surface gap on each side rather than a stroke, so the
                  // tick reads as separate from the fill it sits on.
                  <span
                    aria-hidden
                    className="absolute inset-y-[-2px] w-[2px]"
                    style={{ left: `calc(${markerPct}% - 1px)`, background: VIZ.ink, opacity: 0.55 }}
                  />
                )}
              </div>
              <span className="w-14 shrink-0 text-right font-mono text-[12px] tabular-nums text-ink">
                {format(r.value)}
              </span>
            </div>

            {hover === i && (
              <div className="pointer-events-none absolute right-16 top-full z-20 mt-0.5 min-w-[140px] rounded-lg border border-edge bg-black/95 px-3 py-2 shadow-md">
                <div className="text-[10px] uppercase tracking-wider text-mute">{r.label}</div>
                <dl className="mt-1 space-y-0.5">
                  {[
                    { label: "Value", value: format(r.value), color: r.color },
                    ...(r.marker === undefined
                      ? []
                      : [{ label: r.marker.label, value: format(r.marker.value) }]),
                    ...(r.extra ?? []),
                  ].map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-3">
                      <dt className="text-[11px] text-ink-muted">{row.label}</dt>
                      <dd className="font-mono text-[12px] font-semibold tabular-nums text-ink">
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 12-point trend for a stat tile. De-emphasis stroke with the last point in the
 * accent, no axes and no tooltip: the tile's number is the value, this is only
 * the shape of how it got there.
 */
export function Sparkline({
  points,
  width = 96,
  height = 28,
  color = VIZ.ink,
}: {
  points: readonly number[];
  width?: number;
  height?: number;
  color?: string;
}): JSX.Element | null {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const step = width / (points.length - 1);
  const y = (v: number): number => height - 2 - (v / max) * (height - 4);
  const d = points.map((v, i) => `${i === 0 ? "M" : "L"}${i * step},${y(v)}`).join(" ");
  const lastX = (points.length - 1) * step;
  const lastY = y(points[points.length - 1] ?? 0);

  return (
    <svg width={width} height={height} aria-hidden className="block overflow-visible">
      <path d={`${d} L${lastX},${height} L0,${height} Z`} fill={wash(color, 0.1)} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.55} />
      {/* 2px surface ring keeps the end dot legible where it crosses the line. */}
      <circle cx={lastX} cy={lastY} r={3} fill={color} stroke={VIZ.surface} strokeWidth={2} />
    </svg>
  );
}
