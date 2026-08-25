/**
 * Deterministic post-processing of LLM enrichment output (data-model-audit.md
 * §2.5 degradation contract). The model's raw output is UNTRUSTED: this is
 * the only code that turns it into catalog_enriched field values.
 *
 * Policy: PARTIAL ACCEPT. Marketing copy degrades gracefully — unknown
 * occasions are dropped, pairings outside the merchant's catalog are dropped,
 * money-flavored tokens in prose are flagged — each as a warning on the row,
 * never a rejection. Only a missing/blank display_name (the one column
 * ce_model_required demands) forces the UNENRICHED path.
 *
 * PURE: no clock, no randomness, no IO.
 */
import { CATALOG_CONFIG } from "./config.js";
import type { EnrichmentOutput } from "./schema.js";

export type EnrichmentWarning =
  | "UNKNOWN_OCCASION"
  | "PAIRING_NOT_IN_CATALOG"
  | "MONEY_TOKEN_IN_COPY"
  | "TAGS_TRUNCATED"
  | "MODEL_WARNING";

/** Matches currency amounts and stock/quantity phrasing in prose. The copy
 *  stays (it is structurally powerless — no numeric column exists to feed),
 *  but the warning makes the attempt visible in the demo trail. */
const MONEY_TOKEN = /(?:₹|rs\.?\s?|inr\s?)\s?\d|\b\d+\s?(?:rupees?|paise)\b/i;

export interface SanitizedEnrichment {
  readonly ok: true;
  readonly display_name: string;
  readonly description: string;
  readonly category: string;
  readonly tags: string[];
  readonly occasions: string[];
  readonly pairing_suggestions: string[];
  readonly confidence: number;
  readonly warnings: string[];
}

export interface RejectedEnrichment {
  readonly ok: false;
  /** Machine-readable reason; lands in catalog_enriched.error_detail. */
  readonly error_detail: string;
}

/**
 * Normalizes verified-schema output into row fields against the merchant
 * context. `allowedSkus` is the merchant's full SKU list (pairings may only
 * point at real SKUs); `nameRawFallback` is unused for display_name by
 * design — a model that cannot name the product has failed, and raw fields
 * remain authoritative under UNENRICHED.
 */
export function normalizeEnrichment(
  output: EnrichmentOutput,
  ctx: { allowedSkus: readonly string[] },
): SanitizedEnrichment | RejectedEnrichment {
  const warnings: string[] = [];

  const display_name = output.display_name.trim();
  const description = output.description.trim();
  if (!display_name) {
    return { ok: false, error_detail: "EMPTY_DISPLAY_NAME" };
  }
  if (!description) {
    return { ok: false, error_detail: "EMPTY_DESCRIPTION" };
  }

  // Occasions → closed vocabulary, case-insensitive, dedup, order-stable.
  const closed = new Set(CATALOG_CONFIG.closedOccasions as readonly string[]);
  const occasions: string[] = [];
  for (const raw of output.occasions) {
    const key = raw.trim().toLowerCase();
    if (!closed.has(key)) {
      warnings.push(`UNKNOWN_OCCASION:${raw}`);
      continue;
    }
    if (!occasions.includes(key)) occasions.push(key);
  }

  // Pairings must reference REAL merchant SKUs (case-insensitive match;
  // canonical casing wins). Anything else is dropped with a warning.
  const allowedLower = new Map(ctx.allowedSkus.map((s) => [s.toLowerCase(), s]));
  const pairings: string[] = [];
  for (const raw of output.pairing_suggestions) {
    const canonical = allowedLower.get(raw.trim().toLowerCase());
    if (canonical === undefined) {
      warnings.push(`PAIRING_NOT_IN_CATALOG:${raw}`);
      continue;
    }
    if (!pairings.includes(canonical)) pairings.push(canonical);
  }

  // Tags: trim + lowercase + dedup, cap at maxTags with a truncation warning.
  const tags: string[] = [];
  let truncated = false;
  for (const raw of output.tags) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (tags.includes(t)) continue;
    if (tags.length >= CATALOG_CONFIG.maxTags) {
      truncated = true;
      break;
    }
    tags.push(t);
  }
  if (truncated) warnings.push("TAGS_TRUNCATED");

  if (MONEY_TOKEN.test(display_name) || MONEY_TOKEN.test(description)) {
    warnings.push("MONEY_TOKEN_IN_COPY");
  }
  for (const w of output.warnings.slice(0, CATALOG_CONFIG.maxWarnings)) {
    warnings.push(`MODEL_WARNING:${w}`);
  }

  return {
    ok: true,
    display_name,
    description,
    category: output.category.trim(),
    tags,
    occasions,
    pairing_suggestions: pairings,
    confidence: output.confidence,
    warnings,
  };
}
