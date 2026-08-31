/**
 * Shared builders for the negotiation-stage suites. Mirrors the shared
 * package's fixture pack so ids match the golden map (E001…E010); stage-level
 * tests only need a handful of entries.
 */
import {
  type CampaignPriorityPayload,
  type EvidencePackContainer,
} from "@growthagent/shared";
import {
  allocateIds,
  packHash,
  type EvidencePackEntryInput,
} from "@growthagent/shared/evidence";
import type { BuyerRequestView, NegotiationStageInput } from "@growthagent/shared";
import type { NegotiationProposal } from "@growthagent/shared";
import type { TransportResult } from "../transport.types.js";

export const CHOC = "CAKE-CHOC-500";
export const VAN = "CAKE-VAN-500";
export const SIM_TODAY = "2026-08-25";
export const NOW_ISO = "2026-08-25T10:00:00.000Z";

const RAW: EvidencePackEntryInput[] = [
  {
    kind: "PRICE", sku: CHOC, source_table: "products", computed_at: NOW_ISO,
    payload: { kind: "PRICE", payload: { label: "Chocolate Truffle Cake", category_raw: "CAKES", list_price_paise: 64_900, cost_paise: 34_200, currency: "INR" } },
  },
  {
    kind: "PRICE", sku: VAN, source_table: "products", computed_at: NOW_ISO,
    payload: { kind: "PRICE", payload: { label: "Vanilla Bean Cake", category_raw: "CAKES", list_price_paise: 49_900, cost_paise: 31_000, currency: "INR" } },
  },
  {
    kind: "STOCK", sku: CHOC, source_table: "inventory", computed_at: NOW_ISO,
    payload: { kind: "STOCK", payload: { qty_on_hand: 40, reserved_qty: 5, available_qty: 35, expires_on: null, days_to_expiry: null } },
  },
  {
    kind: "STOCK", sku: VAN, source_table: "inventory", computed_at: NOW_ISO,
    payload: { kind: "STOCK", payload: { qty_on_hand: 20, reserved_qty: 8, available_qty: 12, expires_on: "2026-09-01", days_to_expiry: 7 } },
  },
  {
    kind: "MARGIN", sku: CHOC, source_table: "costs", computed_at: NOW_ISO,
    payload: { kind: "MARGIN", payload: { margin_pct: 47.3, contribution_per_unit_paise: 30_700 } },
  },
  {
    kind: "SALES_STAT", sku: CHOC, source_table: "order_items_mv", computed_at: NOW_ISO,
    payload: { kind: "SALES_STAT", payload: { window_days: 90, units_sold: 150, revenue_paise: 1_388_860, orders_with_sku: 120, avg_units_per_week: 10.9, trend_pct: 4.2 } },
  },
  {
    kind: "ATTACH_RATE", sku: null, source_table: "basket_pairs_mv", computed_at: NOW_ISO,
    payload: { kind: "ATTACH_RATE", payload: { base_sku: CHOC, attach_sku: VAN, attach_rate_pct: 31.4, co_occurrence_orders: 55, sample_orders: 175 } },
  },
  {
    kind: "PAIRING", sku: CHOC, source_table: "catalog_enrichment", computed_at: NOW_ISO,
    payload: { kind: "PAIRING", payload: { pairs_with: [VAN], pitch_line: "Classic pairing." } },
  },
  {
    kind: "CAMPAIGN_PRIORITY", sku: null, source_table: "campaign_priority_set", computed_at: NOW_ISO,
    payload: { kind: "CAMPAIGN_PRIORITY", payload: { priority_id: "PRI-BDAY-BASH", action: "PRIORITIZE_IN_BUNDLES", target_skus: [CHOC, VAN], rationale_plain: "Birthday week.", weight: 80, max_discount_pct_advertised: 10 } },
  },
];

export const ENTRY = allocateIds(RAW);
// E001 PRICE CHOC · E002 PRICE VAN · E003 STOCK CHOC · E004 STOCK VAN
// E005 MARGIN CHOC · E006 SALES_STAT CHOC · E007 ATTACH_RATE · E008 PAIRING
// E009 CAMPAIGN_PRIORITY

export function mkPack(): EvidencePackContainer {
  return {
    pack_hash: packHash(ENTRY),
    built_at: NOW_ISO,
    sim_today: SIM_TODAY,
    merchant_id: "MEERA-001",
    entries: ENTRY,
  };
}

const CAMP_ENTRY = ENTRY.find((e) => e.kind === "CAMPAIGN_PRIORITY");
export const BDAY_PRIORITY: CampaignPriorityPayload =
  CAMP_ENTRY && CAMP_ENTRY.payload.kind === "CAMPAIGN_PRIORITY"
    ? CAMP_ENTRY.payload.payload
    : (() => { throw new Error("fixture drift"); })();

/** A trivially CLEAN proposal against mkPack(). */
export function cleanProposal(): NegotiationProposal {
  return {
    proposed_items: [{ sku: CHOC, qty: 1 }],
    bundle_discount_pct: 0,
    claims: [{
      statement: "The Chocolate Truffle Cake is listed at ₹649.",
      evidence_ids: ["E001"],
      kind: "PRICE",
    }],
    customer_pitch: "The Chocolate Truffle Cake is fresh today — one box coming right up.",
    upsell_reasoning_summary: "Straightforward single-line fulfilment.",
    used_campaign_priority: false,
    campaign_priority_ids: [],
  };
}

export function mkBuyer(partial: Partial<BuyerRequestView> = {}): BuyerRequestView {
  return {
    items: [{ sku: CHOC, qty: 1 }],
    channel: "AGENT",
    ...partial,
  };
}

export function mkInput(partial: Partial<NegotiationStageInput> = {}): NegotiationStageInput {
  return {
    tx_id: "TX-STAGE-1",
    sim_today: SIM_TODAY,
    now_iso: NOW_ISO,
    merchant_id: "MEERA-001",
    pack: mkPack(),
    priorities: [BDAY_PRIORITY],
    buyer_request: mkBuyer(),
    customer_note_raw: "Please deliver fresh.",
    tags: { injection_suspected: false, patterns: [] },
    ...partial,
  };
}

/* --------------------------------------------------------- stub transports */

import type { NegotiationTransport, TransportKeyInputs } from "../transport.types.js";
import type { RenderedRequest } from "../prompt.js";

export function okTransport(result: Partial<TransportResult> & { parsed_output?: NegotiationProposal | null }): NegotiationTransport {
  return {
    async execute(_r: RenderedRequest, _k: TransportKeyInputs): Promise<TransportResult> {
      return {
        parsed_output: result.parsed_output ?? null,
        raw_text: "{}",
        thinking_summary: "",
        usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: undefined },
        stop_reason: result.stop_reason ?? "end_turn",
        latency_ms: 42,
        attempts: [{ kind: "initial", latency_ms: 42, error_class: null, status: null, usage: null }],
      };
    },
  };
}

export function throwingTransport(err: unknown): NegotiationTransport {
  return {
    async execute(): Promise<TransportResult> {
      throw err;
    },
  };
}
