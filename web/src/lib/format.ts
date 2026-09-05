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

/** Whole counts with thousands separators: 1284 → "1,284". */
export function count(n: number): string {
  return n.toLocaleString("en-IN");
}

/** Rupees, no paise tail — for figures where two decimals are noise. */
export function rupeesShort(paise: number): string {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`;
  return `₹${Math.round(r).toLocaleString("en-IN")}`;
}

/** A percentage the API may not have been able to compute. */
export function pctOrDash(v: number | null): string {
  return v === null ? "—" : `${v}%`;
}

/**
 * Bucket start → axis tick + full tooltip title, for the window's granularity.
 * Hourly buckets show the clock; daily buckets show the date.
 */
export function bucketLabels(iso: string, bucket: "hour" | "day"): { short: string; full: string } {
  const d = new Date(iso);
  if (bucket === "hour") {
    return {
      short: d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }),
      full: d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }),
    };
  }
  return {
    short: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    full: d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }),
  };
}

/** Human-readable enterprise failure and decline reasons. */
export function formatReason(reason: string | null | undefined): string {
  if (!reason) return "—";
  const normalized = reason.trim();
  if (normalized === "demo_reset" || normalized === "SYSTEM_RESET") {
    return "System Maintenance Abort";
  }
  if (normalized === "ESCALATION_REJECTED_BY_HUMAN") {
    return "Supervisor Rejected";
  }
  if (normalized === "ESCALATION_EXPIRED") {
    return "Supervisor Review Expired";
  }
  if (normalized === "INJECTION_BLOCKED") {
    return "Security Guard: Prompt Injection";
  }
  if (normalized === "STOCK_EXHAUSTED") {
    return "Inventory Depleted";
  }
  if (normalized === "CATALOG_MISMATCH") {
    return "Catalog SKU Mismatch";
  }
  if (normalized === "TIMEOUT") {
    return "Pipeline Gateway Timeout";
  }
  return normalized.replace(/^GK-/, "").replace(/_/g, " ");
}

/** Formats pipeline failure stages into natural English. */
export function formatFailureStage(stage: string | null | undefined): string {
  if (!stage) return "pipeline execution";
  if (stage === "TERMINAL") return "pipeline execution";
  return stage.replace(/_/g, " ").toLowerCase();
}

