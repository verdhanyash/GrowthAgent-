/**
 * Transport seam (negotiation.md §7): the stage depends on exactly ONE
 * interface. Live (SDK), replay (DEMO_STABLE_MODE), and chaos wrappers all
 * implement it; nothing above this line knows which is wired.
 */
import type {
  NegotiationProposal,
} from "@growthagent/shared";
import type { RenderedRequest } from "./prompt.js";

/** Inputs of the §7 fixture-key derivation. Computed by the stage and handed
 *  to the transport so record/replay share byte-identical keys. */
export interface TransportKeyInputs {
  readonly system_prompt_hash: string;
  readonly pack_hash: string;
  /** Canonical JSON of the buyer request view. */
  readonly buyer_request_canonical: string;
}

export interface UsageSnapshot {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens?: number | undefined;
}

export interface AttemptLog {
  readonly kind: "initial" | "retry" | "repair";
  readonly latency_ms: number;
  /** SDK error class name when the attempt threw. */
  readonly error_class: string | null;
  readonly status: number | null;
  readonly usage: UsageSnapshot | null;
}

export interface TransportResult {
  /** null on parse/validation failure (stage routes to repair-or-fallback). */
  readonly parsed_output: NegotiationProposal | null;
  readonly raw_text: string;
  readonly thinking_summary: string;
  readonly usage: UsageSnapshot | null;
  readonly stop_reason: string;
  readonly latency_ms: number;
  readonly attempts: readonly AttemptLog[];
}

export interface NegotiationTransport {
  execute(rendered: RenderedRequest, key: TransportKeyInputs): Promise<TransportResult>;
}
