/**
 * Batch enrichment runner (data-model-audit.md §2.5 degradation contract).
 *
 * One LLM call PER SKU (llm_calls.purpose = 'enrich_sku', tx_id NULL —
 * offline pre-tx ingestion). SKUs are independent: one SKU's transport
 * failure never blocks the others. Every operational failure lands as
 * UNENRICHED + error_detail with raw fields untouched — the seeded degraded
 * path is itself part of the demo. (FAILED stays reserved for unexpected
 * internal errors; see §18 register.)
 *
 * Retry ladder ownership mirrors the campaign rationale ladder: SDK client
 * maxRetries: 0, OURS attempts=2 with backoff 500ms·2^n+jitter, sleep/jitter
 * injectable for deterministic tests; PARSE_FAILED consumes exactly one
 * re-request through the same loop.
 */
import {
  CATALOG_CONFIG,
  type EnrichmentOutput,
  normalizeEnrichment,
  type SanitizedEnrichment,
} from "@growthagent/shared";
import {
  classify,
  type EnrichmentPort,
} from "./enrichment.port.js";
import type { CatalogItemInput } from "./prompts.js";

export interface RunnerTiming {
  readonly sleep: (ms: number) => Promise<void>;
  readonly jitter: () => number; // [0,1)
}

export const defaultTiming: RunnerTiming = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  jitter: () => Math.random(),
};

function backoffDelay(attemptZeroBased: number, t: RunnerTiming): number {
  return (
    CATALOG_CONFIG.enrichmentBackoffBaseMs * 2 ** attemptZeroBased +
    Math.floor(t.jitter() * 100)
  );
}

export interface EnrichmentOutcome {
  readonly sku: string;
  readonly status: "ENRICHED" | "UNENRICHED";
  /** Present iff ENRICHED — the sanitized field values for catalog_enriched. */
  readonly fields: SanitizedEnrichment | null;
  readonly updated_by_model: string | null;
  /** Full parsed model output, debug only (raw_response jsonb column). */
  readonly raw_response: EnrichmentOutput | null;
  readonly error_detail: string | null;
}

export interface BatchResult {
  readonly results: readonly EnrichmentOutcome[];
  /** For llm_calls rows + demo narration. */
  readonly telemetry: {
    readonly live_calls: number;
    readonly parse_retries: number;
    readonly enriched_count: number;
    readonly unenriched_count: number;
  };
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Acquires one SKU's output through the retry ladder. Returns the parsed
 *  output or the final error; never throws. */
async function enrichOne(
  port: EnrichmentPort,
  item: CatalogItemInput,
  allowedSkus: readonly string[],
  timing: RunnerTiming,
): Promise<{ ok: true; output: EnrichmentOutput } | { ok: false; error: unknown }> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt < CATALOG_CONFIG.enrichmentAttempts;
    attempt++
  ) {
    if (attempt > 0) await timing.sleep(backoffDelay(attempt - 1, timing));
    try {
      return { ok: true, output: await port.enrich({ item, allowedSkus }) };
    } catch (e) {
      lastError = e;
      if (classify(e) === "NON_RETRYABLE") return { ok: false, error: e };
      if (classify(e) === "CHAOS_FORCED") break;
    }
  }
  return { ok: false, error: lastError };
}

export async function enrichCatalog(
  port: EnrichmentPort,
  items: readonly CatalogItemInput[],
  opts: { allowedSkus: readonly string[] },
  timing: RunnerTiming = defaultTiming,
): Promise<BatchResult> {
  const results: EnrichmentOutcome[] = [];
  let liveCalls = 0;
  let parseRetries = 0;

  for (const item of items) {
    // Count every call by wrapping the port per-item (telemetry only).
    let callsForItem = 0;
    const counting: EnrichmentPort = {
      enrich: async (args) => {
        callsForItem++;
        return port.enrich(args);
      },
    };
    const r = await enrichOne(counting, item, opts.allowedSkus, timing);
    liveCalls += callsForItem;

    if (!r.ok) {
      results.push({
        sku: item.sku,
        status: "UNENRICHED",
        fields: null,
        updated_by_model: null,
        raw_response: null,
        error_detail: `${classify(r.error)}: ${messageOf(r.error)}`,
      });
      continue;
    }

    const sanitized = normalizeEnrichment(r.output, {
      allowedSkus: opts.allowedSkus,
    });
    if (!sanitized.ok) {
      results.push({
        sku: item.sku,
        status: "UNENRICHED",
        fields: null,
        updated_by_model: null,
        raw_response: r.output, // kept for debug: what did the model say?
        error_detail: sanitized.error_detail,
      });
      continue;
    }

    results.push({
      sku: item.sku,
      status: "ENRICHED",
      fields: sanitized,
      updated_by_model: CATALOG_CONFIG.enrichmentModel,
      raw_response: r.output,
      error_detail: null,
    });
    if (callsForItem > 1) parseRetries += callsForItem - 1;
  }

  return {
    results,
    telemetry: {
      live_calls: liveCalls,
      parse_retries: parseRetries,
      enriched_count: results.filter((x) => x.status === "ENRICHED").length,
      unenriched_count: results.filter((x) => x.status === "UNENRICHED").length,
    },
  };
}
