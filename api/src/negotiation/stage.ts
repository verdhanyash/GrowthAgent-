/**
 * runNegotiation — stage orchestration (negotiation.md §3.5, §4.6, §6.1):
 * render → transport → response checklist → Citation Auditor → fallback on
 * FAILED. Emits everything the audit trail and explainer need; never touches
 * stock, orders, or Razorpay.
 */
import { canonicalJson } from "@growthagent/shared";
import type {
  NegotiationStageInput,
  ProvenanceEnvelope,
} from "@growthagent/shared";
import type {
  CitationAuditResult,
} from "@growthagent/shared";
import { auditCitations } from "@growthagent/shared";
import type { NegotiationProposal } from "@growthagent/shared";
import { renderNegotiationMessages, systemPromptHash } from "./prompt.js";
import { buildFallbackBundle } from "./fallback.js";
import type {
  NegotiationTransport,
  TransportKeyInputs,
} from "./transport.types.js";

export interface NegotiationStageDeps {
  readonly transport: NegotiationTransport;
}

export interface NegotiationStageResult {
  readonly tx_id: string;
  /** PROPOSED = an LLM (or fallback) cart proceeds to the gatekeeper path. */
  readonly outcome: "PROPOSED" | "FALLBACK";
  /** The cart the gatekeeper will see: auditor-effective proposal. */
  readonly proposal: NegotiationProposal;
  readonly provenance: ProvenanceEnvelope;
  /** Audit of the ORIGINAL LLM proposal against the snapshotted pack. */
  readonly citation_audit: CitationAuditResult | null;
  /** Audit of the FALLBACK bundle when one was built (trivially CLEAN). */
  readonly fallback_audit: CitationAuditResult | null;
  /** Set when the LLM layer failed outright (refusal/timeout/transport). */
  readonly llm_failure_reason:
    | "REFUSAL"
    | "MAX_TOKENS"
    | "PARSE_FAILED"
    | "TRANSPORT_ERROR"
    | null;
}

export class RefusalError extends Error {
  constructor(readonly stop_details: unknown) {
    super("negotiation model refused");
    this.name = "RefusalError";
  }
}

export async function runNegotiation(
  input: NegotiationStageInput,
  deps: NegotiationStageDeps,
): Promise<NegotiationStageResult> {
  const rendered = renderAndKey(input);

  // ---- transport (retry ladder + repair live INSIDE the live transport) ----
  let parsed: NegotiationProposal | null = null;
  let stopReason = "";
  let failure: NegotiationStageResult["llm_failure_reason"] = null;
  try {
    const res = await deps.transport.execute(rendered.rendered, rendered.key);
    stopReason = res.stop_reason;
    if (stopReason === "refusal") {
      failure = "REFUSAL"; // §3.5.1 — never retry a refusal
    } else if (stopReason === "max_tokens") {
      failure = "MAX_TOKENS"; // §3.5.2 — truncation is failure, not silently accepted
    } else if (res.parsed_output === null) {
      failure = "PARSE_FAILED"; // §3.5.3
    } else {
      parsed = res.parsed_output;
    }
  } catch {
    failure = "TRANSPORT_ERROR"; // budget exhausted / non-retryable SDK error
  }

  const base = {
    tx_id: input.tx_id,
    fallback_audit: null as CitationAuditResult | null,
  };

  // ---- auditor on the LLM proposal ---------------------------------------
  let audit: CitationAuditResult | null = null;
  if (parsed !== null) {
    audit = auditCitations(parsed, input.pack, {
      tx_id: input.tx_id,
      audited_at: input.now_iso,
      customer_note_raw: input.customer_note_raw,
    });
    if (audit.verdict === "FAILED") {
      return finishWithFallback(base, input, deps, audit, mapParseFailure(failure));
    }
    return {
      ...base,
      outcome: "PROPOSED",
      proposal: audit.effective_proposal as NegotiationProposal, // CLEAN/STRIPPED always non-null
      provenance: {
        generator: "NEGOTIATION_LLM_V3",
        is_fallback: false,
        llm_meta: undefined,
      },
      citation_audit: audit,
      llm_failure_reason: null,
    };
  }
  return finishWithFallback(base, input, deps, null, failure ?? "TRANSPORT_ERROR");
}

function mapParseFailure(
  f: NonNullable<NegotiationStageResult["llm_failure_reason"]> | null,
): NonNullable<NegotiationStageResult["llm_failure_reason"]> {
  // A FAILED audit means the model SPOKE but lied — narrate that distinctly.
  return f ?? "PARSE_FAILED";
}

function finishWithFallback(
  base: { tx_id: string; fallback_audit: CitationAuditResult | null },
  input: NegotiationStageInput,
  deps: NegotiationStageDeps,
  originalAudit: CitationAuditResult | null,
  reason: NonNullable<NegotiationStageResult["llm_failure_reason"]> | "AUDIT_FAILED",
): NegotiationStageResult {
  void deps; // transports are stateless here; fallback needs no IO
  const built = buildFallbackBundle(
    input.buyer_request,
    input.pack,
    input.priorities,
  );
  if (built === null) {
    // Nothing sellable at all — pipeline converts to a polite decline.
    return {
      tx_id: input.tx_id,
      outcome: "FALLBACK",
      proposal: EMPTY_DECLINE_PROPOSAL,
      provenance: { generator: "DETERMINISTIC_FALLBACK_V1", is_fallback: true, llm_meta: undefined },
      citation_audit: originalAudit,
      fallback_audit: null,
      llm_failure_reason: reason === "AUDIT_FAILED" ? "PARSE_FAILED" : reason,
    };
  }
  const fbAudit = auditCitations(built.proposal, input.pack, {
    tx_id: input.tx_id,
    audited_at: input.now_iso,
    customer_note_raw: input.customer_note_raw,
  });
  return {
    tx_id: input.tx_id,
    outcome: "FALLBACK",
    proposal: built.proposal,
    provenance: built.provenance,
    citation_audit: originalAudit,
    fallback_audit: fbAudit,
    llm_failure_reason: reason === "AUDIT_FAILED" ? "PARSE_FAILED" : reason,
  };
}

/** Degenerate last resort (§6.2 "polite decline"): structurally valid, cites
 *  nothing, proposes nothing — the gatekeeper will reject an empty cart and
 *  the explainer explains why. */
const EMPTY_DECLINE_PROPOSAL: NegotiationProposal = {
  proposed_items: [],
  bundle_discount_pct: 0,
  claims: [],
  customer_pitch:
    "We could not prepare an offer right now — please try again shortly.",
  upsell_reasoning_summary:
    "Deterministic fallback found nothing sellable in stock; polite decline.",
  used_campaign_priority: false,
  campaign_priority_ids: [],
};

/** Rendered request + §7 fixture-key inputs, computed once. */
function renderAndKey(input: NegotiationStageInput): {
  rendered: ReturnType<typeof renderNegotiationMessages>;
  key: TransportKeyInputs;
} {
  return {
    rendered: renderNegotiationMessages(input),
    key: {
      system_prompt_hash: systemPromptHash(),
      pack_hash: input.pack.pack_hash,
      buyer_request_canonical: canonicalJson(input.buyer_request),
    },
  };
}
