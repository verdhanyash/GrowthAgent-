/**
 * RationalePort — the ONLY seam where the campaign subsystem touches an LLM
 * (campaign.md §7.3). Tests mock this port, never fetch; the real retry and
 * classification code is exercised with synthetic typed throws.
 */
import { classifyNimTransport } from "../../llm/nim.js";
import type { RationalesOutput } from "@growthagent/shared";
import type { DraftArgs } from "./prompts.js";

export interface RationalePort {
  draft(args: DraftArgs): Promise<RationalesOutput>;
}

/** HTTP OK but the reply was unparseable / failed RationalesOutputZ validation. */
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
  | "NON_RETRYABLE" // NimHttpError 4xx etc. — our bug; abort cycle, keep previous set
  | "PARSE_FAILED" // HTTP OK but reply unparseable / schema mismatch
  | "CHAOS_FORCED"; // demo chaos toggle

/**
 * Typed-error classification (§7.3), rebased onto the NIM seam and DELEGATING
 * to its classifyNimTransport so all four modules share one taxonomy: rate
 * limit (429), request-timeout (408), conflict (409), server errors (5xx),
 * and transport failures (NimNetworkError — fetch throws AND timeout aborts)
 * are weather; every other HTTP status (400 bad request, 401 bad key, 404
 * unsupported model field, 422 …) and any unrecognized failure shape is our
 * bug → NON_RETRYABLE.
 */
export function classify(e: unknown): RationaleFailureKind {
  if (e instanceof ChaosForcedTimeoutError) return "CHAOS_FORCED";
  if (e instanceof RationaleParseError) return "PARSE_FAILED";
  return classifyNimTransport(e) === "RETRYABLE"
    ? "RETRYABLE_EXHAUSTED"
    : "NON_RETRYABLE";
}
