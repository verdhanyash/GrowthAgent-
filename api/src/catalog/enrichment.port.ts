/**
 * EnrichmentPort — the ONLY seam where the catalog subsystem touches an LLM.
 * Mirrors the campaign rationale port's contract: tests mock the port, never
 * fetch; classification is exercised with synthetic typed throws.
 */
import Anthropic from "@anthropic-ai/sdk";
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

/** Same ladder semantics as the campaign classifier (subclass checks before
 *  the base APIError branch; unknown shapes default to NON_RETRYABLE). */
export function classify(e: unknown): EnrichmentFailureKind {
  if (e instanceof ChaosForcedTimeoutError) return "CHAOS_FORCED";
  if (e instanceof Anthropic.RateLimitError) return "RETRYABLE_EXHAUSTED";
  if (e instanceof Anthropic.InternalServerError) return "RETRYABLE_EXHAUSTED";
  if (e instanceof Anthropic.APIConnectionError) return "RETRYABLE_EXHAUSTED";
  if (e instanceof Anthropic.BadRequestError) return "NON_RETRYABLE";
  if (e instanceof Anthropic.AuthenticationError) return "NON_RETRYABLE";
  if (e instanceof EnrichmentParseError) return "PARSE_FAILED";
  if (e instanceof Anthropic.APIError) return "RETRYABLE_EXHAUSTED"; // base, LAST
  return "NON_RETRYABLE";
}
