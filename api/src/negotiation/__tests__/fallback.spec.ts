/**
 * buildFallbackBundle — §6.3 branch coverage + byte-determinism property
 * (negotiation.md §8.2 fallback suite).
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  type CampaignPriorityPayload,
  type EvidencePackContainer,
} from "@growthagent/shared";
import {
  allocateIds,
  packHash,
  type EvidencePackEntryInput,
} from "@growthagent/shared/evidence";
import { FALLBACK_DEFAULT_PCT, buildFallbackBundle } from "../fallback.js";
import { CHOC, ENTRY, NOW_ISO, VAN, mkPack, BDAY_PRIORITY } from "./fixtures.js";

function packOf(raw: EvidencePackEntryInput[]): EvidencePackContainer {
  const entries = allocateIds(raw);
  return {
    pack_hash: packHash(entries),
    built_at: NOW_ISO,
    sim_today: "2026-08-25",
    merchant_id: "MEERA-001",
    entries,
  };
}

const price = (sku: string, paise: number): EvidencePackEntryInput => ({
  kind: "PRICE", sku, source_table: "products", computed_at: NOW_ISO,
  payload: { kind: "PRICE", payload: { label: sku, category_raw: "CAKES", list_price_paise: paise, cost_paise: Math.floor(paise / 2), currency: "INR" } },
});
const stock = (
  sku: string,
  available: number,
  daysToExpiry: number | null = null,
): EvidencePackEntryInput => ({
  kind: "STOCK", sku, source_table: "inventory", computed_at: NOW_ISO,
  payload: { kind: "STOCK", payload: { qty_on_hand: available, reserved_qty: 0, available_qty: available, expires_on: daysToExpiry === null ? null : "2026-08-27", days_to_expiry: daysToExpiry } },
});

const margin = (sku: string, pct: number, contribution: number): EvidencePackEntryInput => ({
  kind: "MARGIN", sku, source_table: "products(cost)", computed_at: NOW_ISO,
  payload: { kind: "MARGIN", payload: { margin_pct: pct, contribution_per_unit_paise: contribution } },
});

/* ------------------------------------------------------ §6.3 step 1–2 */

describe("core request resolution and clamping", () => {
  it("resolves known skus and clamps qty to [1, min(2, available)]", () => {
    const r = buildFallbackBundle(
      { items: [{ sku: VAN, qty: 9 }, { sku: CHOC, qty: 3 }], channel: "AGENT" },
      mkPack(),
      [],
    );
    expect(r?.proposal.proposed_items).toEqual([
      { sku: VAN, qty: 2 }, // clamp qty 9 → 2
      { sku: CHOC, qty: 2 }, // clamp 3 → 2
    ]);
  });

  it("clamps to available stock when lower than the proposal cap", () => {
    // VAN available_qty = 12 — not binding; craft a scarce sku instead.
    const p = packOf([price("SCARCE-CAKE", 10_000), stock("SCARCE-CAKE", 1)]);
    const r = buildFallbackBundle(
      { items: [{ sku: "SCARCE-CAKE", qty: 5 }], channel: "WEB" },
      p,
      [],
    );
    expect(r?.proposal.proposed_items).toEqual([{ sku: "SCARCE-CAKE", qty: 1 }]);
  });

  it("drops unknown-sku requests entirely (never proposes what we do not sell)", () => {
    const r = buildFallbackBundle(
      { items: [{ sku: "GHOST-SKU-9", qty: 1 }], channel: "AGENT" },
      mkPack(),
      [],
    );
    // No GHOST price row -> core empty -> best-seller seed CHOC (step 2),
    // then the attach complement VAN joins (step 3).
    expect(r?.proposal.proposed_items).toEqual([
      { sku: CHOC, qty: 1 },
      { sku: VAN, qty: 1 },
    ]);
    expect(r?.provenance.is_fallback).toBe(true);
  });
});

describe("step 2 — best-seller seed when nothing resolvable was requested", () => {
  it("picks highest units_sold among in-stock skus", () => {
    const r = buildFallbackBundle(
      { items: [{ label_free_text: "something chocolatey", qty: 1 }], channel: "AGENT" },
      mkPack(),
      [],
    );
    // CHOC units_sold 140 is the only SALES_STAT row; attach adds VAN after.
    expect(r?.proposal.proposed_items).toEqual([
      { sku: CHOC, qty: 1 },
      { sku: VAN, qty: 1 },
    ]);
  });

  it("seeds on MARGIN rank when the pack carries no SALES_STAT rows", () => {
    // The real evidence builder emits PRICE/STOCK/MARGIN only — no sales
    // aggregates — so this is the shape every live free-text request takes.
    // Before the degraded rank existed it returned null and the cart declined
    // as EMPTY_CART with a full shelf in stock.
    const p = packOf([
      price(CHOC, 64_900), // margin 50%, contribution 32_450
      stock(CHOC, 4),
      margin(CHOC, 50, 32_450),
      price(VAN, 19_900), // richer margin — wins the rank
      stock(VAN, 4),
      margin(VAN, 62, 12_338),
    ]);
    const r = buildFallbackBundle(
      { items: [{ label_free_text: "surprise me", qty: 1 }], channel: "AGENT" },
      p,
      [],
    );
    expect(r?.proposal.proposed_items).toEqual([{ sku: VAN, qty: 1 }]);
  });

  it("keeps the seed out of stock-outs and stays byte-stable across runs", () => {
    const p = packOf([
      price(CHOC, 64_900),
      stock(CHOC, 0), // out of stock — must never be seeded
      margin(CHOC, 90, 60_000), // …even though it is the richest line
      price(VAN, 19_900),
      stock(VAN, 2),
      margin(VAN, 10, 2_000),
    ]);
    const req = { items: [{ label_free_text: "anything", qty: 1 }], channel: "AGENT" } as const;
    const a = buildFallbackBundle(req, p, []);
    const b = buildFallbackBundle(req, p, []);
    expect(a?.proposal.proposed_items).toEqual([{ sku: VAN, qty: 1 }]);
    expect(canonicalJson(a as never)).toEqual(canonicalJson(b as never));
  });

  it("never seeds a SKU past its sell_by — GK-EXPIRY-GUARD is a hard decline", () => {
    const p = packOf([
      price(CHOC, 64_900),
      stock(CHOC, 25, -6), // richest line, but expired six days ago
      margin(CHOC, 95, 60_000),
      price(VAN, 19_900),
      stock(VAN, 4, 3), // near-expiry still sells — that is the campaign system's job
      margin(VAN, 10, 2_000),
    ]);
    const r = buildFallbackBundle(
      { items: [{ label_free_text: "surprise me", qty: 1 }], channel: "AGENT" },
      p,
      [],
    );
    expect(r?.proposal.proposed_items).toEqual([{ sku: VAN, qty: 1 }]);
  });

  it("returns null when NOTHING is sellable → polite-decline path", () => {
    const p = packOf([price(CHOC, 64_900), stock(CHOC, 0)]);
    const r = buildFallbackBundle(
      { items: [{ sku: CHOC, qty: 1 }], channel: "AGENT" },
      p,
      [],
    );
    expect(r).toBeNull();
  });
});

/* ------------------------------------------------------ §6.3 steps 3–4 */

/** Pack with ATTACH_RATE + PAIRING removed so step 3 never fires and step 4
 *  (campaign nudge) owns the second line. Ids reallocate — do not rely on them. */
function packNudgesOnly(): EvidencePackContainer {
  return packOf(
    ENTRY.filter((e) => e.kind !== "ATTACH_RATE" && e.kind !== "PAIRING").map(
      ({ id: _id, ...rest }) => rest,
    ),
  );
}

describe("step 3 — complement selection", () => {
  it("adds the top ATTACH_RATE complement and cites its evidence id", () => {
    const r = buildFallbackBundle(mkBuyerChoc(), mkPack(), []);
    const items = r!.proposal.proposed_items;
    expect(items.map((i) => i.sku)).toEqual([CHOC, VAN]);
    const attachClaim = r!.proposal.claims.find((c) => c.kind === "ATTACH_RATE");
    expect(attachClaim?.evidence_ids).toEqual(["E007"]); // fixture attach row
    expect(attachClaim?.statement).toContain("31.4%"); // exact fact, auditor-safe
  });

  it("falls back to PAIRING hints when no ATTACH_RATE applies", () => {
    // Pack without the ATTACH_RATE row: drop E007-equivalent from fixtures.
    const raw = ENTRY.filter((e) => e.kind !== "ATTACH_RATE").map(({ id: _id, ...rest }) => rest);
    const r = buildFallbackBundle(mkBuyerChoc(), packOf(raw), []);
    expect(r?.proposal.proposed_items.map((i) => i.sku)).toEqual([CHOC, VAN]); // via PAIRING pairs_with
  });

  it("does not duplicate a sku already in the basket", () => {
    // Request BOTH skus; no third complement exists → exactly two lines.
    const r = buildFallbackBundle(
      { items: [{ sku: CHOC, qty: 1 }, { sku: VAN, qty: 1 }], channel: "AGENT" },
      mkPack(),
      [],
    );
    expect(r?.proposal.proposed_items).toHaveLength(2);
  });

  function mkBuyerChoc() {
    return { items: [{ sku: CHOC, qty: 1 }], channel: "AGENT" as const };
  }
});

describe("step 4 — campaign nudge", () => {
  it("adds an in-stock target of the highest-weight actionable priority", () => {
    // Buyer asks for CHOC only; PRI-BDAY-BASH targets VAN as well → nudge adds VAN.
    const r = buildFallbackBundle(
      { items: [{ sku: CHOC, qty: 1 }], channel: "AGENT" },
      packNudgesOnly(),
      [BDAY_PRIORITY],
    );
    expect(r?.proposal.used_campaign_priority).toBe(true);
    expect(r?.proposal.campaign_priority_ids).toEqual(["PRI-BDAY-BASH"]);
    const campClaim = r?.proposal.claims.find((c) => c.kind === "CAMPAIGN_PRIORITY");
    expect(campClaim?.evidence_ids.length).toBeGreaterThan(0);
    // Numberless reference statement — nothing for the scanner to distrust.
    expect(/\d/.test(campClaim?.statement ?? "0")).toBe(false);
  });

  it("skips PROMOTE_PAIR actions in the nudge (pairing is step 3's job)", () => {
    const promotePair: CampaignPriorityPayload = {
      priority_id: "PRI-PAIR-UP",
      action: "PROMOTE_PAIR",
      target_skus: [VAN],
      rationale_plain: "Pair push.",
      weight: 99, // higher than BDAY — must still be skipped
      max_discount_pct_advertised: null,
    };
    const r = buildFallbackBundle(
      { items: [{ sku: CHOC, qty: 1 }], channel: "AGENT" },
      mkPack(),
      [promotePair],
    );
    // PROMOTE_PAIR skipped → no campaign claim, used_campaign_priority false.
    expect(r?.proposal.used_campaign_priority).toBe(false);
    expect(r?.proposal.claims.some((c) => c.kind === "CAMPAIGN_PRIORITY")).toBe(false);
  });

  it("ignores priorities whose targets are all out of stock or already chosen", () => {
    const ghost: CampaignPriorityPayload = {
      priority_id: "PRI-GHOST-TARGET",
      action: "CLEAR_NEAR_EXPIRY",
      target_skus: ["GHOST-SKU-9"],
      rationale_plain: "Clearance.",
      weight: 100,
      max_discount_pct_advertised: null,
    };
    const r = buildFallbackBundle(
      { items: [{ sku: CHOC, qty: 1 }], channel: "AGENT" },
      mkPack(),
      [ghost],
    );
    expect(r?.proposal.used_campaign_priority).toBe(false);
  });
});

/* --------------------------------------------------------- §6.3 step 5 */

describe("discount gating", () => {
  it("single-line baskets earn no discount", () => {
    const r = buildFallbackBundle(
      { items: [{ sku: VAN, qty: 1 }], channel: "AGENT" },
      mkPack(),
      [], // no priorities → no nudge → one line only
    );
    expect(r?.proposal.bundle_discount_pct).toBe(0);
    expect(r?.proposal.proposed_items).toHaveLength(1);
  });

  it("multi-line baskets earn the flat hardcoded rate", () => {
    const r = buildFallbackBundle(
      { items: [{ sku: CHOC, qty: 1 }], channel: "AGENT" },
      mkPack(),
      [BDAY_PRIORITY], // nudge adds VAN → 2 lines
    );
    expect(r?.proposal.bundle_discount_pct).toBe(FALLBACK_DEFAULT_PCT);
  });

  it("FALLBACK_DEFAULT_PCT stays 5 — hardcoded, never reads gatekeeper config", () => {
    expect(FALLBACK_DEFAULT_PCT).toBe(5);
  });
});

/* --------------------------------------------- claims + determinism */

describe("programmatic claims are auditor-clean", () => {
  it("every price/stock claim carries an evidence id and reconciles", () => {
    const r = buildFallbackBundle(
      { items: [{ sku: CHOC, qty: 1 }], channel: "AGENT" },
      mkPack(),
      [BDAY_PRIORITY],
    )!;
    for (const c of r.proposal.claims) {
      expect(c.evidence_ids.length).toBeGreaterThanOrEqual(1);
      if (c.kind === "PRICE") expect(c.statement).toMatch(/₹/);
      if (c.kind === "STOCK") expect(c.statement).toMatch(/available|units/u);
    }
    // Pitch names real products and never invents figures.
    expect(r.proposal.customer_pitch).toContain("Chocolate Truffle Cake");
  });
});

describe("byte-determinism property", () => {
  it("same inputs → identical canonicalJson across repeated calls", () => {
    const args = [
      { items: [{ sku: CHOC, qty: 4 }, { sku: VAN, qty: 1 }], channel: "AGENT" as const },
      mkPack(),
      [BDAY_PRIORITY],
    ] as const;
    const golden = canonicalJson(buildFallbackBundle(...args)?.proposal ?? {});
    for (let i = 0; i < 200; i++) {
      expect(canonicalJson(buildFallbackBundle(...args)?.proposal ?? {})).toBe(golden);
    }
  });

  it("priority ORDER does not matter (weight-sorted internally)", () => {
    const low: CampaignPriorityPayload = {
      priority_id: "PRI-LOW",
      action: "PRIORITIZE_IN_BUNDLES",
      target_skus: [VAN],
      rationale_plain: "Low.",
      weight: 1,
      max_discount_pct_advertised: null,
    };
    const args = packNudgesOnly();
    const a = buildFallbackBundle({ items: [{ sku: CHOC, qty: 1 }], channel: "AGENT" }, args, [BDAY_PRIORITY, low]);
    const b = buildFallbackBundle({ items: [{ sku: CHOC, qty: 1 }], channel: "AGENT" }, args, [low, BDAY_PRIORITY]);
    expect(canonicalJson(a!.proposal)).toBe(canonicalJson(b!.proposal));
    // Highest weight wins the single nudge slot.
    expect(a?.proposal.campaign_priority_ids).toEqual(["PRI-BDAY-BASH"]);
  });
});
