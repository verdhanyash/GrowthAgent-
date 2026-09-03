/**
 * demo-beats.spec.ts — audit 18.3.
 *
 * The live scenario run recorded `[Beat 3] high_value_escalate: Expected
 * ESCALATED | Actual DECLINED` with its own assertion FAILING, and nothing in
 * the suite covered it. These tests drive each beat's REQUEST through the REAL
 * deterministic bundler and the REAL gatekeeper — the path the demo takes with
 * no NVIDIA key — and pin the verdict the beat is supposed to demonstrate.
 */
import { describe, expect, it } from "vitest";
import {
  MEERA_GT_V1,
  MEERA_RULES_V3,
  formatPaise,
  type AgentVelocitySnapshot,
  type BuyerRequestView,
} from "@growthagent/shared";
import { buildEvidencePack } from "../../pipeline/evidence.js";
import { buildFallbackBundle } from "../../negotiation/fallback.js";
import { toProposedCart } from "../../pipeline/cart-adapter.js";
import { evaluateProposal } from "../../gatekeeper/engine.js";
import { scanCustomerNote } from "../../pipeline/tagger.js";
import { valueBandLowerEdge } from "../../gatekeeper/rules/cartValue.js";
import { SCENARIO_REQUESTS } from "../scenario-runner.js";
import type { ScenarioName } from "@growthagent/shared";

const NOW_ISO = "2026-08-26T10:00:00.000Z";
const TX = "tx_01M1F8B4CXF6SBMZTXHHJFP1RH";

const velocity: AgentVelocitySnapshot = {
  status: "AVAILABLE",
  agent_identity_id: "buyer_demo",
  hour_window: { window_seconds: 3600, window_end_iso: NOW_ISO, request_count: 0, approved_value_paise: 0 },
  day_window: { window_seconds: 86_400, window_end_iso: NOW_ISO, request_count: 0, approved_value_paise: 0 },
  prior_escalations_24h: 0,
  prior_declines_24h: 0,
  injection_flags_24h: 0,
  source: "redis_sliding_window_v1",
};

/** Same collapse the buyer route and the scenario runner both perform. */
function itemsFor(scenario: ScenarioName): BuyerRequestView["items"] {
  const cr = SCENARIO_REQUESTS[scenario].customerRequest;
  const hint = cr.items_hint;
  if (hint === undefined || hint.length === 0) {
    return [{ label_free_text: cr.natural_language, qty: 1 }];
  }
  const counts = new Map<string, number>();
  for (const sku of hint) counts.set(sku, (counts.get(sku) ?? 0) + 1);
  return [...counts.entries()].map(([sku, qty]) => ({ sku, qty }));
}

/** Run one beat down the no-LLM path: fallback bundle → gatekeeper. */
function runBeat(scenario: ScenarioName) {
  const spec = SCENARIO_REQUESTS[scenario];
  const pack = buildEvidencePack({ gt: MEERA_GT_V1, priorities: [], simToday: NOW_ISO.slice(0, 10), nowIso: NOW_ISO });
  const request: BuyerRequestView = {
    items: itemsFor(scenario),
    channel: "AGENT",
    ...(spec.customerRequest.budget_paise !== undefined
      ? { budget_hint_paise: spec.customerRequest.budget_paise }
      : {}),
  };
  const built = buildFallbackBundle(request, pack, []);
  if (built === null) throw new Error(`${scenario}: the fallback bundler found nothing sellable`);
  const cart = toProposedCart({
    proposal: built.proposal,
    txId: TX,
    buyerAgentIdentityId: "buyer_demo",
    customerNoteRaw: spec.customerNote,
    groundTruth: MEERA_GT_V1,
    nowMs: Date.parse(NOW_ISO),
  });
  const gate = evaluateProposal({
    proposal: cart,
    rules: MEERA_RULES_V3,
    ground_truth: MEERA_GT_V1,
    velocity,
    injection: scanCustomerNote(spec.customerNote).signal,
    now_iso: NOW_ISO,
    tx_id: TX,
  });
  return { proposal: built.proposal, gate };
}

describe("demo beats — deterministic (no-LLM) outcomes", () => {
  it("Beat 1 well_behaved: APPROVE", () => {
    const { gate } = runBeat("well_behaved");
    expect(gate.outcome).toBe("APPROVE");
    expect(gate.recomputed.net_paise).toBeGreaterThan(0);
  });

  it("Beat 2 adversarial_injection: the note is flagged and the cart does not auto-approve", () => {
    const spec = SCENARIO_REQUESTS.adversarial_injection;
    const signal = scanCustomerNote(spec.customerNote).signal;
    expect(signal.suspected).toBe(true);
    expect(signal.hits.map((h) => h.pattern_id)).toContain("SYSTEM_NOTE_SPOOF");
    const { gate } = runBeat("adversarial_injection");
    expect(gate.outcome).not.toBe("APPROVE");
    expect([...gate.declines, ...gate.escalations].length).toBeGreaterThan(0);
  });

  it("Beat 3 high_value_escalate: ESCALATE on VALUE_IN_BAND, not DECLINE (audit 18.3)", () => {
    const { gate } = runBeat("high_value_escalate");
    expect(gate.outcome).toBe("ESCALATE");
    expect(gate.escalations.map((e) => e.reason_code)).toContain("VALUE_IN_BAND");
    expect(gate.declines).toEqual([]);

    // The net must sit INSIDE the band, which is what makes the beat repeatable.
    const cap = MEERA_RULES_V3.max_cart_value_paise;
    const lower = valueBandLowerEdge(cap, MEERA_RULES_V3.escalation_bands.cart_value_band_pct_below_cap);
    const net = gate.recomputed.net_paise;
    expect(net, `${formatPaise(net)} must be within [${formatPaise(lower)}, ${formatPaise(cap)})`)
      .toBeGreaterThanOrEqual(lower);
    expect(net).toBeLessThan(cap);
  });

  it("Beat 3 asks for TWO hampers, and the qty collapse is what delivers them", () => {
    // The old mapping turned items_hint into one qty-1 line per entry and the
    // bundler deduped by SKU, so a repeated SKU silently became a single unit.
    expect(itemsFor("high_value_escalate")).toEqual([
      { sku: "HAMP-DIW-05", qty: 2 },
      { sku: "CAKE-CHOC-500", qty: 1 },
    ]);
    const { proposal } = runBeat("high_value_escalate");
    expect(proposal.proposed_items.find((i) => i.sku === "HAMP-DIW-05")?.qty).toBe(2);
  });

  it("every beat resolves to a sellable cart (no beat depends on free text alone)", () => {
    for (const scenario of ["well_behaved", "adversarial_injection", "high_value_escalate", "llm_timeout_chaos", "gateway_error_chaos"] as const) {
      expect(SCENARIO_REQUESTS[scenario].customerRequest.items_hint?.length ?? 0).toBeGreaterThan(0);
      expect(() => runBeat(scenario)).not.toThrow();
    }
  });
});
