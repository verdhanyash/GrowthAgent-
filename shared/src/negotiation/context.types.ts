/**
 * Context types for the negotiation stage (negotiation.md §0.1 context.types.ts,
 * §2.2, §7): stage input assembled by the pipeline orchestrator, the buyer
 * request view, and the provenance envelope that rides on every proposal.
 */
import type { EvidencePackContainer } from "../schemas.js";
import type { CampaignPriorityPayload } from "../schemas.js";
import type { NegotiationProposal } from "./proposal.schema.js";

/** What the buying agent asked for (§2.2 <buyer_request>). Free-text items are
 *  resolved to pack `label`s by the MODEL — that reasoning is allowed; R1 still
 *  forbids proposing anything absent from the pack. */
export interface BuyerRequestItem {
  readonly sku?: string;
  readonly label_free_text?: string;
  readonly qty: number;
}

export interface BuyerRequestView {
  readonly items: readonly BuyerRequestItem[];
  readonly budget_hint_paise?: number | undefined;
  readonly occasion_hint?: string | undefined;
  readonly channel: "AGENT" | "WEB";
}

/** Deterministic heuristic-tagger output (produced OUTSIDE this layer). */
export interface NoteHeuristicTags {
  readonly injection_suspected: boolean;
  readonly patterns: readonly {
    readonly pattern_id: string;
    readonly snippet_redacted: string;
  }[];
}

export interface NegotiationStageInput {
  readonly tx_id: string;
  readonly sim_today: string; // simulation-clock date "YYYY-MM-DD"
  /** Simulation-clock instant (ISO 8601) — stamped onto audit results; this
   *  layer owns no clock of its own. */
  readonly now_iso: string;
  readonly merchant_id: string;
  /** Full snapshotted pack (entries sorted by id ascending, hash bound). */
  readonly pack: EvidencePackContainer;
  /** Active PrioritySet payloads (already persisted by the campaign agent);
   *  empty when none — R6 covers "say so honestly". */
  readonly priorities: readonly CampaignPriorityPayload[];
  readonly buyer_request: BuyerRequestView;
  /** Raw customer note — sanitized ONLY at render time (§2.3); stored raw. */
  readonly customer_note_raw: string;
  readonly tags: NoteHeuristicTags;
}

/** Where a proposal came from — the frontend's FALLBACK badge reads this. */
export interface ProvenanceEnvelope {
  readonly generator:
    | "NEGOTIATION_LLM_V3"
    | "DETERMINISTIC_FALLBACK_V1"
    | string;
  readonly is_fallback: boolean;
  /** LLM metadata when generator is the live model; absent for fallbacks. */
  readonly llm_meta?: {
    readonly model: string;
    readonly system_prompt_hash: string;
    readonly attempts: number;
    readonly repairs: number;
    readonly latency_ms: number;
    readonly usage?: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cache_read_input_tokens?: number;
    } | null;
  } | undefined;
}

export interface ProvenancedProposal {
  readonly proposal: NegotiationProposal;
  readonly provenance: ProvenanceEnvelope;
}
