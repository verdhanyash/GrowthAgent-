/**
 * Adapter: NegotiationProposal (LLM wire contract, negotiation.md §3.3) →
 * ProposedCart (gatekeeper input, ARCHITECTURE.md §6.5 "post-citation-audit").
 *
 * The two shapes are deliberately different schemas — the model speaks
 * items/claims/pitch, the gate speaks lines/totals/contract flags. This is the
 * ONLY place the translation happens, and it invents nothing:
 * - ids come from the pipeline run, never from the model;
 * - per-line citation_ids stay empty: claims are not line-scoped on the v3
 *   wire contract, and the full claim↔evidence mapping already lives on the
 *   citation_audit_result trace event;
 * - ai_supplied_totals are SYNTHESIZED from catalog prices × proposed discount
 *   (the v3 contract carries no totals field), mirroring the gatekeeper's own
 *   HALF_UP math, so GK-TOTALS-DRIFT measures real drift and reads zero here
 *   by construction while staying meaningful for totals-bearing clients;
 * - citations_audited is true because the deterministic Citation Auditor ran
 *   upstream inside the negotiation stage — a FAILED verdict never reaches the
 *   orchestrator as a live proposal (it was replaced by the fallback bundle).
 */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  type CatalogItemGroundTruth,
  type GroundTruthSnapshot,
  type NegotiationProposal,
  type ProposedCart,
} from "@growthagent/shared";

/** Proposal validity window handed to GK-PROPOSAL-FRESHNESS (fixtures use
 *  NOW+230s against a 300s max-age — 240s keeps comfortable margin). */
export const PROPOSAL_TTL_MS = 240_000;

export function toProposedCart(args: {
  proposal: NegotiationProposal;
  txId: string;
  buyerAgentIdentityId: string;
  customerNoteRaw: string;
  groundTruth: GroundTruthSnapshot;
  nowMs: number;
}): ProposedCart {
  const { proposal, groundTruth, nowMs } = args;

  const usedPriority =
    proposal.used_campaign_priority && proposal.campaign_priority_ids.length > 0;

  // Synthesized totals: gross from GT list prices, single HALF_UP discount
  // event — the same shape the gatekeeper recomputes, hence drift ≡ 0.
  const grossPaise = proposal.proposed_items.reduce((sum, it) => {
    const item = findItem(groundTruth, it.sku);
    return sum + (item?.list_price_paise ?? 0) * it.qty;
  }, 0);
  const discBps = Math.round(proposal.bundle_discount_pct * 100); // 0.5-steps ⇒ exact
  const discountPaise = Math.floor((grossPaise * discBps + 5_000) / 10_000);

  return {
    proposal_id: `prop_${createHash("sha256")
      .update(canonicalJson(proposal))
      .digest("hex")
      .slice(0, 16)}`,
    tx_id: args.txId,
    buyer_agent_identity_id: args.buyerAgentIdentityId,
    negotiation_run_id: `nrun_${args.txId}`.slice(0, 128),
    lines: proposal.proposed_items.map((it) => ({
      sku_id: it.sku,
      quantity: it.qty,
      citation_ids: [], // claims are not line-scoped on the v3 wire contract
    })),
    bundle_discount_pct: proposal.bundle_discount_pct,
    bundle_discount_reason: usedPriority
      ? "CAMPAIGN_PRIORITY"
      : proposal.bundle_discount_pct > 0
        ? "NEGOTIATION_CONCESSION"
        : "NONE",
    campaign_priority_id: usedPriority ? (proposal.campaign_priority_ids[0] ?? null) : null,
    ai_supplied_totals: {
      subtotal_paise: grossPaise,
      discount_paise: discountPaise,
      total_paise: grossPaise - discountPaise,
    },
    negotiation_summary_md: `${proposal.customer_pitch}\n\n${proposal.upsell_reasoning_summary}`,
    customer_note_raw: args.customerNoteRaw.slice(0, 2000),
    issued_at_iso: new Date(nowMs).toISOString(),
    expires_at_iso: new Date(nowMs + PROPOSAL_TTL_MS).toISOString(),
    citations_audited: true,
  };
}

function findItem(gt: GroundTruthSnapshot, skuId: string): CatalogItemGroundTruth | undefined {
  return gt.items.find((it) => it.sku_id === skuId);
}
