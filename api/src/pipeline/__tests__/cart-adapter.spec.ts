/** Cart adapter: NegotiationProposal → ProposedCart, inventing nothing. */
import { describe, expect, it } from "vitest";
import { MEERA_GT_V1 } from "@growthagent/shared";
import { PROPOSAL_TTL_MS, toProposedCart } from "../cart-adapter.js";
import { makeProposal } from "./harness.js";

const NOW_MS = Date.parse("2026-08-26T10:00:00.000Z");

function adapt(proposal = makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]), nowMs = NOW_MS) {
  return toProposedCart({
    proposal,
    txId: "tx_adapter_test_0001",
    buyerAgentIdentityId: "agent_buyer_01",
    customerNoteRaw: "Friday delivery please",
    groundTruth: MEERA_GT_V1,
    nowMs,
  });
}

describe("toProposedCart", () => {
  it("maps items to lines with empty per-line citations (claims are not line-scoped)", () => {
    const cart = adapt(makeProposal([{ sku: "CAKE-CHOC-500", qty: 2 }, { sku: "BRWN-BOX-9", qty: 1 }]));
    expect(cart.lines).toEqual([
      { sku_id: "CAKE-CHOC-500", quantity: 2, citation_ids: [] },
      { sku_id: "BRWN-BOX-9", quantity: 1, citation_ids: [] },
    ]);
  });

  it("derives identity/run ids from the run — never from the model", () => {
    const cart = adapt();
    expect(cart.tx_id).toBe("tx_adapter_test_0001");
    expect(cart.buyer_agent_identity_id).toBe("agent_buyer_01");
    expect(cart.negotiation_run_id).toBe(`nrun_tx_adapter_test_0001`);
  });

  it("mints a content-derived deterministic proposal_id", () => {
    const a = adapt(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]), NOW_MS);
    const b = adapt(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]), NOW_MS + 5_000);
    const other = adapt(makeProposal([{ sku: "CAKE-CHOC-500", qty: 2 }]), NOW_MS);
    expect(a.proposal_id).toBe(b.proposal_id); // clock-independent
    expect(a.proposal_id).not.toBe(other.proposal_id);
    expect(a.proposal_id).toMatch(/^prop_[0-9a-f]{16}$/);
  });

  it("classifies the discount reason honestly", () => {
    const none = adapt(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }], 0));
    expect(none.bundle_discount_reason).toBe("NONE");
    expect(none.campaign_priority_id).toBeNull();

    const concession = adapt(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }], 5));
    expect(concession.bundle_discount_reason).toBe("NEGOTIATION_CONCESSION");
    expect(concession.campaign_priority_id).toBeNull();

    const priority = adapt({
      ...makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }], 10),
      used_campaign_priority: true,
      campaign_priority_ids: ["PRI-BIRTHDAY-BUNDLE", "PRI-CLEARANCE"],
    });
    expect(priority.bundle_discount_reason).toBe("CAMPAIGN_PRIORITY");
    expect(priority.campaign_priority_id).toBe("PRI-BIRTHDAY-BUNDLE"); // first id wins

    // claimed-but-unused priority stays NONE (the flag lies, the ids are empty)
    const bareFlag = adapt({ ...makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }], 0), used_campaign_priority: true });
    expect(bareFlag.bundle_discount_reason).toBe("NONE");
  });

  it("synthesizes ai_supplied_totals from GT prices with HALF_UP discount math", () => {
    const cart = adapt(makeProposal([{ sku: "CAKE-CHOC-500", qty: 2 }, { sku: "BRWN-BOX-9", qty: 1 }], 7.5));
    const gross = 64_900 * 2 + 24_900; // 154700
    const expectedDiscount = Math.floor((gross * 750 + 5_000) / 10_000); // HALF_UP single event
    expect(cart.ai_supplied_totals).toEqual({
      subtotal_paise: gross,
      discount_paise: expectedDiscount,
      total_paise: gross - expectedDiscount,
    });
    expect(cart.bundle_discount_pct).toBe(7.5);
  });

  it("copies the pitch verbatim into negotiation_summary_md and clamps the note", () => {
    const p = makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]);
    const cart = adapt(p);
    expect(cart.negotiation_summary_md).toBe(`${p.customer_pitch}\n\n${p.upsell_reasoning_summary}`);
    const longNote = "n".repeat(5000);
    const clamped = toProposedCart({
      proposal: p,
      txId: "tx_adapter_test_0002",
      buyerAgentIdentityId: "agent_buyer_01",
      customerNoteRaw: longNote,
      groundTruth: MEERA_GT_V1,
      nowMs: NOW_MS,
    });
    expect(clamped.customer_note_raw.length).toBe(2000);
  });

  it("stamps the freshness window the gate's staleness rule reads", () => {
    const cart = adapt();
    expect(cart.issued_at_iso).toBe(new Date(NOW_MS).toISOString());
    expect(cart.expires_at_iso).toBe(new Date(NOW_MS + PROPOSAL_TTL_MS).toISOString());
    expect(PROPOSAL_TTL_MS).toBeLessThan(300_000); // inside rules v3 max-age
  });

  it("always asserts citations_audited=true (FAILED audits never reach this point)", () => {
    expect(adapt().citations_audited).toBe(true);
  });

  it("adapts the empty decline proposal into an empty cart the gate will block", () => {
    const emptyDecline = {
      ...makeProposal([]),
      proposed_items: [],
      claims: [],
      bundle_discount_pct: 0,
    };
    // No zod parse here by design: the wire schema demands ≥1 item, but the
    // pipeline must still carry a nothing-sellable fallback to the GATE,
    // which fails it closed as an empty cart.
    const cart = adapt(emptyDecline);
    expect(cart.lines).toEqual([]);
    expect(cart.ai_supplied_totals.total_paise).toBe(0);
  });
});
