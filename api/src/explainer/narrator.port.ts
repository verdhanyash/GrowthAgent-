/**
 * NarratorPort — the ONLY seam where the explainer subsystem touches an LLM.
 * Same contract as the other three agents: tests mock the port, never fetch.
 */
import { classifyNimTransport } from "../llm/nim.js";
import type { NarrativeOutput } from "@growthagent/shared";
import type { NarrateArgs } from "./prompts.js";

export interface NarratorPort {
  narrate(args: NarrateArgs): Promise<NarrativeOutput>;
}

/** HTTP OK but the reply was not one JSON object / failed the output schema. */
export class NarrationParseError extends Error {
  constructor(message = "parsed_output was null") {
    super(message);
    this.name = "NarrationParseError";
  }
}

/** Demo chaos toggle (CHAOS_FORCED_LLM_TIMEOUT=1). */
export class ChaosForcedTimeoutError extends Error {
  constructor() {
    super("chaos: forced narrator timeout");
    this.name = "ChaosForcedTimeoutError";
  }
}

export type NarrationFailureKind =
  | "RETRYABLE_EXHAUSTED"
  | "NON_RETRYABLE"
  | "PARSE_FAILED"
  | "CHAOS_FORCED";

/** Same ladder semantics as every other agent classifier. Transport classes
 *  ride the shared NIM classifier: NimHttpError {408,409,429,>=500} and
 *  NimNetworkError (connection failures, timeouts) are retryable; other
 *  statuses (bad request, bad key, not found, unprocessable) fail fast, as
 *  does any UNKNOWN error shape. */
export function classify(e: unknown): NarrationFailureKind {
  if (e instanceof ChaosForcedTimeoutError) return "CHAOS_FORCED";
  if (classifyNimTransport(e) === "RETRYABLE") return "RETRYABLE_EXHAUSTED";
  if (e instanceof NarrationParseError) return "PARSE_FAILED";
  return "NON_RETRYABLE";
}
