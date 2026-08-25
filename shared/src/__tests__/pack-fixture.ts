/**
 * Deterministic test pack shared by the negotiation suites. Deliberately
 * shuffled input order — allocation must normalize it. The resulting IDs are
 * STABLE GOLDEN VALUES every matrix row references:
 *
 *   E001 PRICE   CAKE-CHOC-500  ₹649.00 / cost ₹342.00
 *   E002 PRICE   CAKE-VAN-500   ₹499.00 / cost ₹310.00
 *   E003 STOCK   CHOC           available 35
 *   E004 STOCK   VAN            available 12, expires in 7d
 *   E005 MARGIN  CHOC           47.3%
 *   E006 SALES_STAT CHOC        units 150, orders 120, revenue ₹13,888.60
 *   E007 ATTACH_RATE CHOC→VAN   31.4%
 *   E008 OCCASION_FIT VAN       confidence 0.82
 *   E009 PAIRING CHOC           pairs_with [CAKE-VAN-500]
 *   E010 CAMPAIGN_PRIORITY PRI-BDAY-BASH advertised 10%
 */
import {
  allocateIds,
  packHash,
  type EvidencePackContainer,
  type EvidencePackEntryInput,
} from "../index.js";

export const CHOC = "CAKE-CHOC-500";
export const VAN = "CAKE-VAN-500";
export const SIM_TODAY = "2026-08-25";
export const NOW_ISO = "2026-08-25T10:00:00.000Z";

const RAW_ENTRIES: EvidencePackEntryInput[] = [
  // (order here is NOT canonical — allocateIds sorts)
  {
    kind: "SALES_STAT",
    sku: CHOC,
    source_table: "order_items_mv",
    computed_at: NOW_ISO,
    payload: {
      kind: "SALES_STAT",
      payload: {
        window_days: 90,
        units_sold: 150,
        revenue_paise: 1_388_860,
        orders_with_sku: 120,
        avg_units_per_week: 10.9,
        trend_pct: 4.2,
      },
    },
  },
  {
    kind: "CAMPAIGN_PRIORITY",
    sku: null,
    source_table: "campaign_priority_set",
    computed_at: NOW_ISO,
    payload: {
      kind: "CAMPAIGN_PRIORITY",
      payload: {
        priority_id: "PRI-BDAY-BASH",
        action: "PRIORITIZE_IN_BUNDLES",
        target_skus: [CHOC, VAN],
        rationale_plain: "Birthday-week push; both cakes featured on the board.",
        weight: 80,
        max_discount_pct_advertised: 10,
      },
    },
  },
  {
    kind: "PRICE",
    sku: VAN,
    source_table: "products",
    computed_at: NOW_ISO,
    payload: {
      kind: "PRICE",
      payload: {
        label: "Vanilla Bean Cake",
        category_raw: "CAKES",
        list_price_paise: 49_900,
        cost_paise: 31_000,
        currency: "INR",
      },
    },
  },
  {
    kind: "STOCK",
    sku: CHOC,
    source_table: "inventory+stock_reservations",
    computed_at: NOW_ISO,
    payload: {
      kind: "STOCK",
      payload: { qty_on_hand: 40, reserved_qty: 5, available_qty: 35, expires_on: null, days_to_expiry: null },
    },
  },
  {
    kind: "PAIRING",
    sku: CHOC,
    source_table: "catalog_enrichment",
    computed_at: NOW_ISO,
    payload: {
      kind: "PAIRING",
      payload: { pairs_with: [VAN], pitch_line: "A bakery classic alongside the house favourite." },
    },
  },
  {
    kind: "PRICE",
    sku: CHOC,
    source_table: "products",
    computed_at: NOW_ISO,
    payload: {
      kind: "PRICE",
      payload: {
        label: "Chocolate Truffle Cake",
        category_raw: "CAKES",
        list_price_paise: 64_900,
        cost_paise: 34_200,
        currency: "INR",
      },
    },
  },
  {
    kind: "ATTACH_RATE",
    sku: null,
    source_table: "basket_pairs_mv",
    computed_at: NOW_ISO,
    payload: {
      kind: "ATTACH_RATE",
      payload: { base_sku: CHOC, attach_sku: VAN, attach_rate_pct: 31.4, co_occurrence_orders: 55, sample_orders: 175 },
    },
  },
  {
    kind: "OCCASION_FIT",
    sku: VAN,
    source_table: "catalog_enrichment",
    computed_at: NOW_ISO,
    payload: {
      kind: "OCCASION_FIT",
      payload: { occasions: ["BIRTHDAY"], tags: ["kids"], confidence: 0.82 },
    },
  },
  {
    kind: "MARGIN",
    sku: CHOC,
    source_table: "products+costs",
    computed_at: NOW_ISO,
    payload: {
      kind: "MARGIN",
      payload: { margin_pct: 47.3, contribution_per_unit_paise: 30_700 },
    },
  },
  {
    kind: "STOCK",
    sku: VAN,
    source_table: "inventory+stock_reservations",
    computed_at: NOW_ISO,
    payload: {
      kind: "STOCK",
      payload: { qty_on_hand: 20, reserved_qty: 8, available_qty: 12, expires_on: "2026-09-01", days_to_expiry: 7 },
    },
  },
];

/** Golden id map asserted by ids.spec.ts and relied on everywhere else. */
export const ENTRY = allocateIds(RAW_ENTRIES);

export function testPack(): EvidencePackContainer {
  return {
    pack_hash: packHash(ENTRY),
    built_at: NOW_ISO,
    sim_today: SIM_TODAY,
    merchant_id: "MEERA-001",
    entries: ENTRY,
  };
}

/** The campaign priority payload matching E010 (for stage/fallback inputs). */
export const BDAY_PRIORITY = ENTRY[9]!.payload.kind === "CAMPAIGN_PRIORITY"
  ? ENTRY[9]!.payload.payload
  : (() => { throw new Error("fixture drift: E010 must be CAMPAIGN_PRIORITY"); })();
