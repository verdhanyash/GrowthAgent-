/**
 * Deterministic evidence-ID allocation + pack hashing (negotiation.md §1.4).
 *
 * IDs must be a pure function of pack content so DEMO_STABLE_MODE replays
 * byte-match and audit trails stay meaningful across restarts:
 *   sort by (kindIndex, sku ?? "" asc, tiebreakKey) → assign E001, E002, …
 *   pack_hash = sha256(canonicalJson(entries)) AFTER allocation (IDs are inside
 *   the hashed content — any post-hoc edit breaks the hash).
 */
import { createHash } from "node:crypto";
import type {
  EvidenceKind,
  EvidencePackEntry,
} from "../schemas.js";
import { canonicalJson } from "../canonical.js";

/** Canonical kind order for allocation (§1.4 KIND_ORDER). */
export const KIND_ORDER: readonly EvidenceKind[] = [
  "PRICE",
  "STOCK",
  "MARGIN",
  "SALES_STAT",
  "ATTACH_RATE",
  "OCCASION_FIT",
  "PAIRING",
  "CAMPAIGN_PRIORITY",
];

const KIND_INDEX: ReadonlyMap<EvidenceKind, number> = new Map(
  KIND_ORDER.map((k, i) => [k, i]),
);

/** Deterministic tiebreak within (kind, sku) groups (§1.4). Accepts the
 *  id-less input shape too — allocation sorts before ids exist. */
function tiebreakKey(e: EvidencePackEntryInput): string {
  switch (e.kind) {
    case "PRICE":
    case "STOCK":
    case "MARGIN":
    case "OCCASION_FIT":
    case "PAIRING":
      return e.sku ?? "";
    case "SALES_STAT":
      // (sku ?? ""), then window_days
      return `${e.sku ?? ""}|${
        e.payload.kind === "SALES_STAT" ? e.payload.payload.window_days : 0
      }`;
    case "ATTACH_RATE":
      return e.payload.kind === "ATTACH_RATE"
        ? `${e.payload.payload.base_sku}|${e.payload.payload.attach_sku}`
        : "";
    case "CAMPAIGN_PRIORITY":
      return e.payload.kind === "CAMPAIGN_PRIORITY"
        ? e.payload.payload.priority_id
        : "";
  }
}

export class PackInvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackInvariantViolationError";
  }
}

/** Distributive Omit so the payload union survives (plain Omit collapses it). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
export type EvidencePackEntryInput = DistributiveOmit<
  EvidencePackEntry,
  "id"
>;

/**
 * Sort a copy of `entries` into canonical allocation order and assign E001…
 * Hard cap: 999 entries (E999 is the last legal id).
 * Throws PACK_INVARIANT_VIOLATION on duplicate SKUs within a per-SKU kind —
 * fail loud at build, never ship an ambiguous pack (§1.8).
 */
export function allocateIds(
  entries: readonly EvidencePackEntryInput[],
): EvidencePackEntry[] {
  const sorted = [...entries].sort((a, b) => {
    const ka = KIND_INDEX.get(a.kind) ?? Number.MAX_SAFE_INTEGER;
    const kb = KIND_INDEX.get(b.kind) ?? Number.MAX_SAFE_INTEGER;
    if (ka !== kb) return ka - kb;
    const sa = a.sku ?? "";
    const sb = b.sku ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
    const ta = tiebreakKey(a);
    const tb = tiebreakKey(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    // Final total-order fallback so equal keys never compare unstable.
    return canonicalJson(a.payload) < canonicalJson(b.payload)
      ? -1
      : canonicalJson(a.payload) > canonicalJson(b.payload)
        ? 1
        : 0;
  });

  // Per-(kind,sku) uniqueness for the per-SKU kinds (§1.8 duplicate-row guard).
  const seen = new Set<string>();
  for (const e of sorted) {
    if (
      e.kind === "PRICE" ||
      e.kind === "STOCK" ||
      e.kind === "MARGIN" ||
      e.kind === "OCCASION_FIT" ||
      e.kind === "PAIRING"
    ) {
      const key = `${e.kind}:${e.sku ?? ""}`;
      if (seen.has(key)) {
        throw new PackInvariantViolationError(
          `PACK_INVARIANT_VIOLATION: duplicate ${e.kind} row for sku ${e.sku ?? "(null)"}`,
        );
      }
      seen.add(key);
    } else if (e.kind === "ATTACH_RATE") {
      const key =
        e.payload.kind === "ATTACH_RATE"
          ? `${e.payload.payload.base_sku}|${e.payload.payload.attach_sku}`
          : "";
      if (seen.has(key)) {
        throw new PackInvariantViolationError(
          `PACK_INVARIANT_VIOLATION: duplicate ATTACH_RATE pair ${key}`,
        );
      }
      seen.add(key);
    } else if (e.kind === "CAMPAIGN_PRIORITY") {
      const pid =
        e.payload.kind === "CAMPAIGN_PRIORITY"
          ? e.payload.payload.priority_id
          : "";
      if (seen.has(pid)) {
        throw new PackInvariantViolationError(
          `PACK_INVARIANT_VIOLATION: duplicate CAMPAIGN_PRIORITY ${pid}`,
        );
      }
      seen.add(pid);
    }
  }

  if (sorted.length > 999) {
    throw new PackInvariantViolationError(
      `PACK_INVARIANT_VIOLATION: ${sorted.length} entries exceeds the 999-entry hard cap`,
    );
  }

  return sorted.map((e, i) => ({
    ...e,
    id: `E${String(i + 1).padStart(3, "0")}`,
  }));
}

/** sha256 hex of canonicalJson(entries) — computed after ID allocation (§1.4). */
export function packHash(entries: readonly EvidencePackEntry[]): string {
  return createHash("sha256").update(canonicalJson(entries), "utf8").digest("hex");
}
