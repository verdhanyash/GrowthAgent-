/** Evidence pack builder: pure derivation, deterministic ids and hash. */
import { describe, expect, it } from "vitest";
import { MEERA_GT_V1, type CampaignPriorityPayload } from "@growthagent/shared";
import { buildEvidencePack, type EnrichmentIndex } from "../evidence.js";

const NOW = "2026-08-26T10:00:00.000Z";
const TODAY = "2026-08-26";

const PRIORITY: CampaignPriorityPayload = {
  priority_id: "PRI-BIRTHDAY-BUNDLE",
  action: "PRIORITIZE_IN_BUNDLES",
  target_skus: ["CAKE-CHOC-500", "BRWN-BOX-9"],
  rationale_plain: "Birthday bundles undersell vs category peers; attach brownies to cake baskets.",
  weight: 80,
  max_discount_pct_advertised: 10,
};

describe("buildEvidencePack", () => {
  it("emits PRICE/STOCK/MARGIN per sku plus one CAMPAIGN_PRIORITY per active priority", () => {
    const pack = buildEvidencePack({ gt: MEERA_GT_V1, priorities: [PRIORITY], simToday: TODAY, nowIso: NOW });
    for (const it of MEERA_GT_V1.items) {
      expect(pack.entries.some((e) => e.kind === "PRICE" && e.sku === it.sku_id)).toBe(true);
      expect(pack.entries.some((e) => e.kind === "STOCK" && e.sku === it.sku_id)).toBe(true);
      expect(pack.entries.some((e) => e.kind === "MARGIN" && e.sku === it.sku_id)).toBe(true);
    }
    const prio = pack.entries.find((e) => e.kind === "CAMPAIGN_PRIORITY");
    expect(prio).toBeDefined();
    expect(prio!.sku).toBeNull();
    expect(prio!.payload).toMatchObject({
      kind: "CAMPAIGN_PRIORITY",
      payload: { priority_id: PRIORITY.priority_id, action: "PRIORITIZE_IN_BUNDLES", weight: 80 },
    });
  });

  it("allocates sequential E-ids and binds the pack hash", () => {
    const pack = buildEvidencePack({ gt: MEERA_GT_V1, priorities: [], simToday: TODAY, nowIso: NOW });
    pack.entries.forEach((e, i) => expect(e.id).toBe(`E${String(i + 1).padStart(3, "0")}`));
    expect(pack.pack_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.merchant_id).toBe(MEERA_GT_V1.merchant_id);
    expect(pack.sim_today).toBe(TODAY);
  });

  it("is deterministic — same inputs, byte-identical pack", () => {
    const a = buildEvidencePack({ gt: MEERA_GT_V1, priorities: [PRIORITY], simToday: TODAY, nowIso: NOW });
    const b = buildEvidencePack({ gt: MEERA_GT_V1, priorities: [PRIORITY], simToday: TODAY, nowIso: NOW });
    expect(a).toEqual(b);
  });

  it("computes days_to_expiry from sim_today; null without a sell-by", () => {
    const gt = {
      ...MEERA_GT_V1,
      items: MEERA_GT_V1.items.map((it, i) => ({
        ...it,
        sell_by_iso: i === 0 ? "2026-09-05T00:00:00.000Z" : null,
      })),
    };
    const pack = buildEvidencePack({ gt, priorities: [], simToday: TODAY, nowIso: NOW });
    const stockOf = (sku: string) =>
      pack.entries.find((e) => e.kind === "STOCK" && e.sku === sku)?.payload.payload as {
        expires_on: string | null;
        days_to_expiry: number | null;
      };
    // 2026-09-05 − 2026-08-26 = 10 days
    expect(stockOf(gt.items[0]!.sku_id).days_to_expiry).toBe(10);
    expect(stockOf(gt.items[0]!.sku_id).expires_on).toBe("2026-09-05");
    expect(stockOf(gt.items[1]!.sku_id).days_to_expiry).toBeNull();
  });

  it("adds OCCASION_FIT / PAIRING only when enrichment provides them", () => {
    const enr: EnrichmentIndex = new Map([
      ["CAKE-CHOC-500", { occasions: ["BIRTHDAY"], tags: ["bestseller"], pairs_with: ["BRWN-BOX-9"] }],
      ["BRWN-BOX-9", { tags: [] }], // non-target fields only → nothing extra
    ]);
    const withEnr = buildEvidencePack({
      gt: MEERA_GT_V1,
      priorities: [],
      simToday: TODAY,
      nowIso: NOW,
      enrichment: enr,
    });
    const withoutEnr = buildEvidencePack({ gt: MEERA_GT_V1, priorities: [], simToday: TODAY, nowIso: NOW });
    expect(withoutEnr.entries.some((e) => e.kind === "OCCASION_FIT")).toBe(false);
    expect(withEnr.entries.some((e) => e.kind === "OCCASION_FIT" && e.sku === "CAKE-CHOC-500")).toBe(true);
    expect(withEnr.entries.some((e) => e.kind === "PAIRING" && e.sku === "CAKE-CHOC-500")).toBe(true);
    expect(withEnr.entries.some((e) => e.kind === "OCCASION_FIT" && e.sku === "BRWN-BOX-9")).toBe(false);
    expect(withEnr.entries.length - withoutEnr.entries.length).toBe(2);
  });

  it("derives margin facts from GT cost (the only pricing authority)", () => {
    const pack = buildEvidencePack({ gt: MEERA_GT_V1, priorities: [], simToday: TODAY, nowIso: NOW });
    const choc = MEERA_GT_V1.items.find((i) => i.sku_id === "CAKE-CHOC-500")!;
    const margin = pack.entries.find((e) => e.kind === "MARGIN" && e.sku === "CAKE-CHOC-500")!;
    expect(margin.payload.payload).toMatchObject({
      margin_pct: Number((((choc.list_price_paise - choc.cost_price_paise) / choc.list_price_paise) * 100).toFixed(2)),
      contribution_per_unit_paise: choc.list_price_paise - choc.cost_price_paise,
    });
  });
});
