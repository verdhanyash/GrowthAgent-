/**
 * RationalePort — the ONLY seam where the campaign subsystem touches an LLM
 * (campaign.md §7.3). Tests mock this port, never fetch; the real retry and
 * classification code is exercised with synthetic typed throws.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { RationalesOutput } from "@growthagent/shared";
import type { DraftArgs } from "./prompts.js";

export interface RationalePort {
  draft(args: DraftArgs): Promise<RationalesOutput>;
}

/** HTTP OK but parsed_output null / schema mismatch. */
export class RationaleParseError extends Error {
  constructor(message = "parsed_output was null") {
    super(message);
    this.name = "RationaleParseError";
  }
}

/** Demo chaos toggle (CHAOS_FORCED_LLM_TIMEOUT=1) throws this from the port. */
export class ChaosForcedTimeoutError extends Error {
  constructor() {
    super("chaos: forced rationale timeout");
    this.name = "ChaosForcedTimeoutError";
  }
}

export type RationaleFailureKind =
  | "RETRYABLE_EXHAUSTED" // rate limit / 5xx / network / timeout, retries spent
  | "NON_RETRYABLE" // BadRequestError etc. — our bug; abort cycle, keep previous set
  | "PARSE_FAILED" // HTTP OK but parsed_output null / schema mismatch
  | "CHAOS_FORCED"; // demo chaos toggle

/**
 * Typed-error classification (§7.3). Subclass checks precede the base
 * APIError branch (APIConnectionError IS an APIError); anything unrecognized
 * defaults to NON_RETRYABLE — unknown failure shapes are treated as defects,
 * not weather.
 */
export function classify(e: unknown): RationaleFailureKind {
  if (e instanceof ChaosForcedTimeoutError) return "CHAOS_FORCED";
  if (e instanceof Anthropic.RateLimitError) return "RETRYABLE_EXHAUSTED";
  if (e instanceof Anthropic.InternalServerError) return "RETRYABLE_EXHAUSTED";
  if (e instanceof Anthropic.APIConnectionError) return "RETRYABLE_EXHAUSTED"; // includes timeouts
  if (e instanceof Anthropic.BadRequestError) return "NON_RETRYABLE";
  if (e instanceof Anthropic.AuthenticationError) return "NON_RETRYABLE";
  if (e instanceof RationaleParseError) return "PARSE_FAILED";
  if (e instanceof Anthropic.APIError) return "RETRYABLE_EXHAUSTED"; // base, checked LAST
  return "NON_RETRYABLE";
}
