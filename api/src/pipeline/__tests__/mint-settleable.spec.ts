/**
 * mint-settleable.spec.ts — audit S1 (the paise-remainder crash) plus the two
 * invariants the fix has to keep: Σ qty×unit === the gatekeeper's net, and the
 * backorder flag the settlement layer needs (H2).
 *
 * Pure: no Postgres. The gate result is produced by the REAL gatekeeper over the
 * REAL ground truth, because the crash was in the handoff between the two.
 */
import { describe, expect, it } from "vitest";
import { MEERA_GT_V1, MEERA_RULES_V3, type AgentVelocitySnapshot, type MerchantRulesConfig } from "@growthagent/shared";
import { evaluateProposal } from "../../gatekeeper/engine.js";
import { toProposedCart } from "../cart-adapter.js";
import { mintSettleable } from "../orchestrator.js";
import type { NegotiationProposal } from "@growthagent/shared";

const NOW_ISO = "2026-08-26T10:00:00Z";
const TX = "tx_01M1F8B4CXF6SBMZTXHHJFP1RH";

const velocity: AgentVelocitySnapshot = {
  status: "AVAILABLE",
  agent_identity_id: "buyer_test",
  hour_window: { window_seconds: 3600, window_end_iso: NOW_ISO, request_count: 0, approved_value_paise: 0 },
  day_window: { window_seconds: 86_400, window_end_iso: NOW_ISO, request_count: 0, approved_value_paise: 0 },
  prior_escalations_24h: 0,
  prior_declines_24h: 0,
  injection_flags_24h: 0,
  source: "redis_sliding_window_v1",
};

function proposalOf(items: { sku: string; qty: number }[], discountPct: number): NegotiationProposal {
  return {
    proposed_items: items.map((i) => ({ sku: i.sku, qty: i.qty })),
    bundle_discount_pct: discountPct,
    claims: [{ statement: "listed price", evidence_ids: ["E001"], kind: "PRICE" }],
    customer_pitch: "A deterministic fixture pitch for the mint tests.",
    upsell_reasoning_summary: "fixture",
    used_campaign_priority: false,
    campaign_priority_ids: [],
  };
}

function gateFor(items: { sku: string; qty: number }[], discountPct: number, rules: MerchantRulesConfig = MEERA_RULES_V3) {
  const proposal = proposalOf(items, discountPct);
  const cart = toProposedCart({
    proposal,
    txId: TX,
    buyerAgentIdentityId: "buyer_test",
    customerNoteRaw: "",
    groundTruth: MEERA_GT_V1,
    nowMs: Date.parse(NOW_ISO),
  });
  const gate = evaluateProposal({
    proposal: cart,
    rules,
    ground_truth: MEERA_GT_V1,
    velocity,
    injection: { suspected: false, risk_score: 0, hits: [], tagger_version: "heuristic-v2" },
    now_iso: NOW_ISO,
    tx_id: TX,
  });
  return { proposal, gate };
}

describe("mintSettleable — paise remainder (audit S1)", () => {
  it("3 brownie boxes at 7.5%: net 69097 is indivisible by 3, and it still mints", () => {
    const { proposal, gate } = gateFor([{ sku: "BRWN-BOX-9", qty: 3 }], 7.5);
    // Pin the numbers the audit reproduced, so a change in the fixture cannot
    // silently turn this back into a divisible (and therefore useless) case.
    expect(gate.recomputed.net_paise).toBe(69_097);
    expect(gate.recomputed.net_paise % 3).not.toBe(0);

    const s = mintSettleable({ txId: TX, proposal, gt: MEERA_GT_V1, gate, approvalSource: "GATEKEEPER_AUTO" });

    expect(s.lines.reduce((a, l) => a + l.unit_price_paise * l.qty, 0)).toBe(69_097);
    expect(s.total_amount_paise).toBe(69_097);
    // 1 unit a paise dearer + 2 at the floor — never 3 × (floor + remainder).
    expect(s.lines).toEqual([
      { sku: "BRWN-BOX-9", qty: 1, unit_price_paise: 23_033 },
      { sku: "BRWN-BOX-9", qty: 2, unit_price_paise: 23_032 },
    ]);
    // Total quantity is preserved: the split must not sell more or fewer units.
    expect(s.lines.reduce((a, l) => a + l.qty, 0)).toBe(3);
  });

  it("Σ qty×unit === recomputed net across a sweep of quantities and discounts", () => {
    const skus = ["BRWN-BOX-9", "CAKE-CHOC-500", "CKI-KAJU-250"] as const;
    let splits = 0;
    for (const sku of skus) {
      for (let qty = 1; qty <= 7; qty++) {
        for (const pct of [0, 2.5, 5, 7.5, 9.9, 11, 13.3, 15]) {
          const { proposal, gate } = gateFor([{ sku, qty }], pct);
          if (gate.outcome === "DECLINE") continue; // over cap / under margin: never minted
          const s = mintSettleable({ txId: TX, proposal, gt: MEERA_GT_V1, gate, approvalSource: "GATEKEEPER_AUTO" });
          expect(s.lines.reduce((a, l) => a + l.unit_price_paise * l.qty, 0)).toBe(gate.recomputed.net_paise);
          expect(s.lines.reduce((a, l) => a + l.qty, 0)).toBe(qty);
          if (s.lines.length > 1) splits += 1;
        }
      }
    }
    // The sweep must actually exercise the split, or it proves nothing.
    expect(splits).toBeGreaterThan(0);
  });

  it("multi-line carts conserve the net too (proportional allocation leaves remainders)", () => {
    const { proposal, gate } = gateFor(
      [{ sku: "BRWN-BOX-9", qty: 3 }, { sku: "CKI-KAJU-250", qty: 2 }],
      7.5,
    );
    const s = mintSettleable({ txId: TX, proposal, gt: MEERA_GT_V1, gate, approvalSource: "GATEKEEPER_AUTO" });
    expect(s.lines.reduce((a, l) => a + l.unit_price_paise * l.qty, 0)).toBe(gate.recomputed.net_paise);
    for (const pl of gate.recomputed.per_line) {
      const mine = s.lines.filter((l) => l.sku === pl.sku_id);
      expect(mine.reduce((a, l) => a + l.qty, 0)).toBe(pl.quantity);
      expect(mine.reduce((a, l) => a + l.unit_price_paise * l.qty, 0)).toBe(pl.net_paise);
    }
  });

  it("the minted proposal parses as a SettleableProposal (contract enforced at mint)", () => {
    const { proposal, gate } = gateFor([{ sku: "BRWN-BOX-9", qty: 3 }], 7.5);
    const s = mintSettleable({ txId: TX, proposal, gt: MEERA_GT_V1, gate, approvalSource: "GATEKEEPER_AUTO" });
    expect(s.proposal_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.currency).toBe("INR");
    expect(s.gatekeeper.verdict).toBe("APPROVE");
  });
});

describe("mintSettleable — backorder flag (audit H2)", () => {
  const backorderRules: MerchantRulesConfig = {
    ...MEERA_RULES_V3,
    stock_policy: { ...MEERA_RULES_V3.stock_policy, backorder_allowed_skus: ["BRED-SOUR-1"] },
  };

  it("flags a line the gate exempted, so settlement records it without a hold", () => {
    // BRED-SOUR-1 has stock_on_hand 3 in the fixture; ask for 5.
    const { proposal, gate } = gateFor([{ sku: "BRED-SOUR-1", qty: 5 }], 0, backorderRules);
    expect(gate.outcome).not.toBe("DECLINE"); // the exemption is what makes this mintable
    const s = mintSettleable({
      txId: TX, proposal, gt: MEERA_GT_V1, gate,
      approvalSource: "GATEKEEPER_AUTO",
      backorderSkus: backorderRules.stock_policy.backorder_allowed_skus,
    });
    expect(s.lines.every((l) => l.backordered === true)).toBe(true);
  });

  it("does NOT flag a line that fits in stock, even for an allowlisted sku", () => {
    const { proposal, gate } = gateFor([{ sku: "BRED-SOUR-1", qty: 2 }], 0, backorderRules);
    const s = mintSettleable({
      txId: TX, proposal, gt: MEERA_GT_V1, gate,
      approvalSource: "GATEKEEPER_AUTO",
      backorderSkus: backorderRules.stock_policy.backorder_allowed_skus,
    });
    expect(s.lines.some((l) => l.backordered === true)).toBe(false);
  });

  it("omits the flag entirely when no allowlist is supplied", () => {
    const { proposal, gate } = gateFor([{ sku: "BRWN-BOX-9", qty: 3 }], 7.5);
    const s = mintSettleable({ txId: TX, proposal, gt: MEERA_GT_V1, gate, approvalSource: "GATEKEEPER_AUTO" });
    expect(s.lines.every((l) => l.backordered === undefined)).toBe(true);
  });
});
