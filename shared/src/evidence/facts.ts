/**
 * deriveNumericFacts(entry) — the SHARED fact deriver (negotiation.md §4.3).
 * ONE implementation, used by both the pack tooling and the deterministic
 * Citation Auditor (M5), so the set of "legal numbers" has exactly one source.
 *
 * Trust rule (§1.7), enforced structurally: OCCASION_FIT / PAIRING yield zero
 * money facts — an LLM claiming "this bundle saves ₹200 because the pairing
 * suggestion says so" fails numeric reconciliation.
 */
import type {
  AttachRatePayload,
  CampaignPriorityPayload,
  EvidencePayload,
  MarginPayload,
  OccasionFitPayload,
  PricePayload,
  SalesStatPayload,
  StockPayload,
} from "../schemas.js";

export const FACT_UNITS = ["PAISE", "RUPEE", "COUNT", "DEC1", "PCT"] as const;
export type FactUnit = (typeof FACT_UNITS)[number];

export interface NumericFact {
  readonly name: string;
  readonly unit: FactUnit;
  readonly value: number;
}

/**
 * Derived numeric facts per §4.3:
 * | PRICE             | list_price_paise (PAISE), /100 (RUPEE), cost_paise (PAISE) |
 * | STOCK             | qty_on_hand, reserved_qty, available_qty, days_to_expiry (COUNT) |
 * | MARGIN            | margin_pct (PCT), contribution_per_unit_paise (PAISE + RUPEE) |
 * | SALES_STAT        | units_sold, orders_with_sku (COUNT), revenue_paise (+RUPEE),
 *                     avg_units_per_week (DEC1), window_days (COUNT), trend_pct (PCT) |
 * | ATTACH_RATE       | attach_rate_pct (PCT), co_occurrence_orders, sample_orders (COUNT) |
 * | OCCASION_FIT/PAIRING | confidence (DEC1) only — no money facts by construction
 *                      (PAIRING carries no confidence field => zero facts) |
 * | CAMPAIGN_PRIORITY | weight (COUNT), max_discount_pct_advertised (PCT) when non-null |
 */
export function deriveNumericFacts(entry: EvidencePayload): NumericFact[] {
  switch (entry.kind) {
    case "PRICE": {
      const p: PricePayload = entry.payload;
      return [
        { name: "list_price_paise", unit: "PAISE", value: p.list_price_paise },
        { name: "list_price_rupees", unit: "RUPEE", value: p.list_price_paise / 100 },
        { name: "cost_paise", unit: "PAISE", value: p.cost_paise },
        // RUPEE mirror of cost (same pattern as list/revenue) — without it a
        // true "cost is ₹342" claim can never reconcile and redaction (A16)
        // would have no observable contrast.
        { name: "cost_rupees", unit: "RUPEE", value: p.cost_paise / 100 },
      ];
    }
    case "STOCK": {
      const s: StockPayload = entry.payload;
      const facts: NumericFact[] = [
        { name: "qty_on_hand", unit: "COUNT", value: s.qty_on_hand },
        { name: "reserved_qty", unit: "COUNT", value: s.reserved_qty },
        { name: "available_qty", unit: "COUNT", value: s.available_qty },
      ];
      if (s.days_to_expiry !== null) {
        facts.push({ name: "days_to_expiry", unit: "COUNT", value: s.days_to_expiry });
      }
      return facts;
    }
    case "MARGIN": {
      const m: MarginPayload = entry.payload;
      return [
        { name: "margin_pct", unit: "PCT", value: m.margin_pct },
        { name: "contribution_per_unit_paise", unit: "PAISE", value: m.contribution_per_unit_paise },
        { name: "contribution_per_unit_rupees", unit: "RUPEE", value: m.contribution_per_unit_paise / 100 },
      ];
    }
    case "SALES_STAT": {
      const s: SalesStatPayload = entry.payload;
      const facts: NumericFact[] = [
        { name: "units_sold", unit: "COUNT", value: s.units_sold },
        { name: "orders_with_sku", unit: "COUNT", value: s.orders_with_sku },
        { name: "revenue_paise", unit: "PAISE", value: s.revenue_paise },
        { name: "revenue_rupees", unit: "RUPEE", value: s.revenue_paise / 100 },
        { name: "avg_units_per_week", unit: "DEC1", value: s.avg_units_per_week },
        { name: "window_days", unit: "COUNT", value: s.window_days },
      ];
      if (s.trend_pct !== null) {
        facts.push({ name: "trend_pct", unit: "PCT", value: s.trend_pct });
      }
      return facts;
    }
    case "ATTACH_RATE": {
      const a: AttachRatePayload = entry.payload;
      return [
        { name: "attach_rate_pct", unit: "PCT", value: a.attach_rate_pct },
        { name: "co_occurrence_orders", unit: "COUNT", value: a.co_occurrence_orders },
        { name: "sample_orders", unit: "COUNT", value: a.sample_orders },
      ];
    }
    case "OCCASION_FIT": {
      const o: OccasionFitPayload = entry.payload;
      return o.confidence !== null
        ? [{ name: "confidence", unit: "DEC1", value: o.confidence }]
        : [];
    }
    case "PAIRING": {
      // Exhaustiveness anchor: payload narrows to PairingPayload here.
      return []; // no numeric fields at all — prose only, by construction
    }
    case "CAMPAIGN_PRIORITY": {
      const c: CampaignPriorityPayload = entry.payload;
      const facts: NumericFact[] = [{ name: "weight", unit: "COUNT", value: c.weight }];
      if (c.max_discount_pct_advertised !== null) {
        facts.push({
          name: "max_discount_pct_advertised",
          unit: "PCT",
          value: c.max_discount_pct_advertised,
        });
      }
      return facts;
    }
  }
}
