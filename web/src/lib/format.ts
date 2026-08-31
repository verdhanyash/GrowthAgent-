/**
 * web/src/lib/format.ts — tiny display helpers used across the trace UI. Money
 * and percent formatting live in @growthagent/shared (integer-paise safe); this
 * file only holds view-layer sugar with no money math.
 */

/** Truncate a 64-hex digest for compact display: "a1b2c3d4…9f0e". */
export function shortHash(hex: string | null | undefined, head = 8, tail = 4): string {
  if (!hex) return "—";
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/** "10:04:03.120Z" → "10:04:03" for the log rail (drops date + millis). */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1]! : iso;
}

/** ms → "1.2s" / "820ms" for stage/settlement durations. */
export function humanMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** discount_percent_bps (10000 = 100%) → "12.5%". */
export function bpsToPct(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}
