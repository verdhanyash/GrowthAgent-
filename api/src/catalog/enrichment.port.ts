/**
 * EnrichmentPort — the ONLY seam where the catalog subsystem touches an LLM.
 * Mirrors the campaign rationale port's contract: tests mock the port, never
 * fetch; classification is exercised with synthetic typed throws.
 */
import { NimHttpError, NimNetworkError } from "../llm/nim.js";
import type { EnrichmentOutput } from "@growthagent/shared";
import type { CatalogItemInput } from "./prompts.js";

export interface EnrichmentArgs {
  readonly item: CatalogItemInput;
  readonly allowedSkus: readonly string[];
}

export interface EnrichmentPort {
  enrich(args: EnrichmentArgs): Promise<EnrichmentOutput>;
}

/** HTTP OK but parsed_output null / schema mismatch. */
export class EnrichmentParseError extends Error {
  constructor(message = "parsed_output was null") {
    super(message);
    this.name = "EnrichmentParseError";
  }
}

/** Demo chaos toggle (CHAOS_FORCED_LLM_TIMEOUT=1). */
export class ChaosForcedTimeoutError extends Error {
  constructor() {
    super("chaos: forced enrichment timeout");
    this.name = "ChaosForcedTimeoutError";
  }
}

export type EnrichmentFailureKind =
  | "RETRYABLE_EXHAUSTED"
  | "NON_RETRYABLE"
  | "PARSE_FAILED"
  | "CHAOS_FORCED";

/**
 * Same ladder semantics as the campaign classifier, rebased from the Anthropic
 * typed errors onto the NIM transport classes: rate limit (429) / server
 * errors (5xx) / network failures are retryable; client mistakes — bad
 * request, bad key, unknown model (any other 4xx) — and UNKNOWN error shapes
 * fail fast as NON_RETRYABLE.
 */
export function classify(e: unknown): EnrichmentFailureKind {
  if (e instanceof ChaosForcedTimeoutError) return "CHAOS_FORCED";
  if (
    e instanceof NimHttpError &&
    (e.status === 429 || e.status >= 500)
  ) {
    return "RETRYABLE_EXHAUSTED";
  }
  if (e instanceof NimNetworkError) return "RETRYABLE_EXHAUSTED";
  if (e instanceof NimHttpError) return "NON_RETRYABLE"; // other 4xx
  if (e instanceof EnrichmentParseError) return "PARSE_FAILED";
  return "NON_RETRYABLE"; // unknown shapes fail fast
}
