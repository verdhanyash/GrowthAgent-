/**
 * Evidence Pack builder — CONTEXT_BUILD stage (negotiation.md §1). Pure
 * derivation from the ground-truth snapshot + active campaign priorities;
 * IDs allocated and pack hashed by the shared deterministic allocator, so
 * DEMO_STABLE_MODE replays byte-match.
 *
 * HONEST SCOPE (registered in BUILD_LOG M7): SALES_STAT/ATTACH_RATE entries
 * need a 90-day sales-aggregate source that arrives with the demo-fixture
 * milestone; this builder emits PRICE/STOCK/MARGIN (+OCCASION_FIT/PAIRING
 * when enrichment is provided) per SKU and one CAMPAIGN_PRIORITY entry per
 * active priority. The negotiation model's R1 rule ("propose only what the
 * pack contains") holds over exactly these entries.
 */
import {
  type CampaignPriorityPayload,
  type CatalogItemGroundTruth,
  type EvidencePackContainer,
  type GroundTruthSnapshot,
} from "@growthagent/shared";
import {
  allocateIds,
  packHash,
  type EvidencePackEntryInput,
} from "@growthagent/shared/evidence";

/** Optional enrichment rows keyed by sku (catalog-intelligence output). */
export type EnrichmentIndex = ReadonlyMap<
  string,
  { occasions?: readonly string[]; tags?: readonly string[]; pairs_with?: readonly string[] }
>;

const marginPctOf = (item: CatalogItemGroundTruth): number =>
  item.list_price_paise > 0
    ? Number(
        (
          Math.round(((item.list_price_paise - item.cost_price_paise) / item.list_price_paise) * 10_000) /
          100
        ).toFixed(2),
      )
    : 0;

export function buildEvidencePack(args: {
  gt: GroundTruthSnapshot;
  priorities: readonly CampaignPriorityPayload[];
  simToday: string;
  nowIso: string;
  enrichment?: EnrichmentIndex | undefined;
}): EvidencePackContainer {
  const { gt, priorities, simToday, nowIso, enrichment } = args;
  const raw: EvidencePackEntryInput[] = [];

  for (const it of gt.items) {
    const enr = enrichment?.get(it.sku_id);
    const available = it.stock_on_hand; // reservations tracked at settlement; pre-sale snapshot
    const expiresOn = it.sell_by_iso === null ? null : it.sell_by_iso.slice(0, 10);
    const daysToExpiry =
      expiresOn === null ? null : Math.floor((Date.parse(expiresOn) - Date.parse(simToday)) / 86_400_000);

    raw.push({
      kind: "PRICE",
      sku: it.sku_id,
      source_table: "products",
      computed_at: nowIso,
      payload: {
        kind: "PRICE",
        payload: {
          label: it.name_raw,
          category_raw: it.category_raw,
          list_price_paise: it.list_price_paise,
          cost_paise: it.cost_price_paise,
          currency: "INR",
        },
      },
    });
    raw.push({
      kind: "STOCK",
      sku: it.sku_id,
      source_table: "inventory+stock_reservations",
      computed_at: nowIso,
      payload: {
        kind: "STOCK",
        payload: {
          qty_on_hand: it.stock_on_hand,
          reserved_qty: 0,
          available_qty: available,
          expires_on: expiresOn,
          days_to_expiry: daysToExpiry,
        },
      },
    });
    raw.push({
      kind: "MARGIN",
      sku: it.sku_id,
      source_table: "products(cost)",
      computed_at: nowIso,
      payload: {
        kind: "MARGIN",
        payload: {
          margin_pct: marginPctOf(it),
          contribution_per_unit_paise: it.list_price_paise - it.cost_price_paise,
        },
      },
    });
    if (enr !== undefined && (enr.occasions?.length ?? 0) > 0) {
      raw.push({
        kind: "OCCASION_FIT",
        sku: it.sku_id,
        source_table: "sku_enrichment",
        computed_at: nowIso,
        payload: {
          kind: "OCCASION_FIT",
          payload: {
            occasions: [...(enr.occasions ?? [])].slice(0, 6),
            tags: [...(enr.tags ?? [])].slice(0, 10),
            confidence: null,
          },
        },
      });
    }
    if (enr !== undefined && (enr.pairs_with?.length ?? 0) > 0) {
      raw.push({
        kind: "PAIRING",
        sku: it.sku_id,
        source_table: "sku_enrichment",
        computed_at: nowIso,
        payload: {
          kind: "PAIRING",
          payload: {
            pairs_with: [...(enr.pairs_with ?? [])].slice(0, 6),
            pitch_line: "",
          },
        },
      });
    }
  }

  for (const p of priorities) {
    raw.push({
      kind: "CAMPAIGN_PRIORITY",
      sku: null,
      source_table: "campaign_priority_sets(active)",
      computed_at: nowIso,
      payload: {
        kind: "CAMPAIGN_PRIORITY",
        payload: {
          priority_id: p.priority_id,
          action: p.action,
          target_skus: [...p.target_skus],
          rationale_plain: p.rationale_plain,
          weight: p.weight,
          max_discount_pct_advertised: p.max_discount_pct_advertised,
        },
      },
    });
  }

  const entries = allocateIds(raw);
  return {
    pack_hash: packHash(entries),
    built_at: nowIso,
    sim_today: simToday,
    merchant_id: gt.merchant_id,
    entries,
  };
}
