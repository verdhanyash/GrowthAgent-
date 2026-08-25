/**
 * buildFallbackBundle — deterministic proposal generator (negotiation.md §6).
 * Invoked on LLM timeout/abort, non-retryable SDK error, exhausted retries,
 * refusal, unrepaired schema failure, or auditor FAILED. Output is a normal
 * NegotiationProposal wrapped in a ProvenanceEnvelope{is_fallback:true}.
 *
 * The fallback is NEVER exempt from auditor or gatekeeper. It deliberately
 * does NOT read gatekeeper config (hardcoded 5%) so it can never drift upward
 * with rule edits; worst case it sells the requested item at list price.
 *
 * Deterministic given (request, pack, priorities): byte-stable golden tests.
 */
import type {
  CampaignPriorityPayload,
  EvidencePackContainer,
} from "@growthagent/shared";
import type {
  BuyerRequestView,
  ProvenanceEnvelope,
} from "@growthagent/shared";
import type {
  Claim,
  NegotiationProposal,
  ProposedItem,
} from "@growthagent/shared";

export const FALLBACK_MAX_QTY = 2;
export const FALLBACK_MAX_LINES = 4;
/** Hardcoded — deliberately does NOT read gatekeeper config (§6.2). */
export const FALLBACK_DEFAULT_PCT = 5;

const RUPEES = (paise: number): string =>
  `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

interface PackIndex {
  priceBySku: Map<string, string>; // sku -> evidence id
  stockBySku: Map<string, string>;
  stockAvailable: Map<string, number>;
  labelBySku: Map<string, string>;
  marginBySku: Map<string, number>;
  marginEntryIds: Map<string, string>;
  attachEntries: { id: string; base_sku: string; attach_sku: string; rate: number }[];
  pairingEntries: { id: string; sku: string | null; candidates: string[] }[];
}

function indexPack(pack: EvidencePackContainer): PackIndex {
  const ix: PackIndex = {
    priceBySku: new Map(),
    stockBySku: new Map(),
    stockAvailable: new Map(),
    labelBySku: new Map(),
    marginBySku: new Map(),
    marginEntryIds: new Map(),
    attachEntries: [],
    pairingEntries: [],
  };
  for (const e of pack.entries) {
    switch (e.kind) {
      case "PRICE":
        if (e.sku && !ix.priceBySku.has(e.sku)) {
          ix.priceBySku.set(e.sku, e.id);
          ix.labelBySku.set(e.sku, e.payload.kind === "PRICE" ? e.payload.payload.label : "");
        }
        break;
      case "STOCK":
        if (e.sku && !ix.stockBySku.has(e.sku)) {
          ix.stockBySku.set(e.sku, e.id);
          ix.stockAvailable.set(
            e.sku,
            e.payload.kind === "STOCK" ? e.payload.payload.available_qty : 0,
          );
        }
        break;
      case "MARGIN":
        if (e.sku && !ix.marginEntryIds.has(e.sku)) {
          ix.marginEntryIds.set(e.sku, e.id);
          ix.marginBySku.set(
            e.sku,
            e.payload.kind === "MARGIN" ? e.payload.payload.margin_pct : 0,
          );
        }
        break;
      case "ATTACH_RATE":
        if (e.payload.kind === "ATTACH_RATE") {
          ix.attachEntries.push({
            id: e.id,
            base_sku: e.payload.payload.base_sku,
            attach_sku: e.payload.payload.attach_sku,
            rate: e.payload.payload.attach_rate_pct,
          });
        }
        break;
      case "PAIRING":
        ix.pairingEntries.push({
          id: e.id,
          sku: e.sku,
          candidates:
            e.payload.kind === "PAIRING"
              ? e.payload.payload.pairs_with.filter((s) => ix.priceBySku.has(s))
              : [],
        });
        break;
      default:
        break;
    }
  }
  return ix;
}

const inStock = (ix: PackIndex, sku: string): boolean =>
  (ix.stockAvailable.get(sku) ?? 0) >= 1;

/**
 * §6.3 normative algorithm. Returns null when NOTHING sellable exists — the
 * pipeline converts that into a polite decline path.
 *
 * NORMALIZATION (documented): step 4's sketch filters `action ∈ {CLEARANCE,
 * PUSH_ITEM}`; under ARCHITECTURE.md §18 the campaign enum is
 * {PRIORITIZE_IN_BUNDLES, CLEAR_NEAR_EXPIRY, PROMOTE_PAIR}, so the mapped
 * filter is `{CLEAR_NEAR_EXPIRY, PRIORITIZE_IN_BUNDLES}` — PROMOTE_PAIR is
 * excluded because pair promotion is step 3's attach-rate job.
 */
export function buildFallbackBundle(
  request: BuyerRequestView,
  pack: EvidencePackContainer,
  priorities: readonly CampaignPriorityPayload[],
): { proposal: NegotiationProposal; provenance: ProvenanceEnvelope } | null {
  const ix = indexPack(pack);
  const lines: ProposedItem[] = [];
  const pushLine = (sku: string, qty: number): boolean => {
    if (
      lines.length >= FALLBACK_MAX_LINES ||
      !inStock(ix, sku) ||
      lines.some((l) => l.sku === sku)
    ) {
      return false;
    }
    const avail = ix.stockAvailable.get(sku) ?? 0;
    lines.push({ sku, qty: Math.max(1, Math.min(FALLBACK_MAX_QTY, qty, avail)) });
    return true;
  };

  // 1. Core: resolvable, in-stock request items, clamped.
  const seenReq = new Set<string>();
  for (const item of request.items) {
    if (!item.sku || seenReq.has(item.sku)) continue;
    seenReq.add(item.sku);
    if (!ix.priceBySku.has(item.sku)) continue; // buyer asked for something we don't sell
    pushLine(item.sku, item.qty);
  }

  // 2. Courtesy best-seller when nothing resolvable was requested.
  if (lines.length === 0) {
    const salesRows = pack.entries
      .filter((e) => e.kind === "SALES_STAT" && e.sku !== null)
      .map((e) => ({
        sku: e.sku as string,
        units: e.payload.kind === "SALES_STAT" ? e.payload.payload.units_sold : 0,
      }));
    const seed = salesRows
      .filter((r) => inStock(ix, r.sku))
      .sort((a, b) => b.units - a.units || (a.sku < b.sku ? -1 : 1))[0];
    if (!seed) return null; // pipeline → polite decline
    pushLine(seed.sku, 1);
  }

  const coreSkus = () => lines.map((l) => l.sku);

  // 3. Complement via ATTACH_RATE (rate desc, attach-sku margin desc, sku asc),
  //    else PAIRING hints.
  let complementSku: string | null = null;
  let attachClaimId: string | null = null;

  const cand = ix.attachEntries
    .filter(
      (a) =>
        coreSkus().includes(a.base_sku) &&
        inStock(ix, a.attach_sku) &&
        !coreSkus().includes(a.attach_sku),
    )
    .sort(
      (x, y) =>
        y.rate - x.rate ||
        (ix.marginBySku.get(y.attach_sku) ?? 0) -
          (ix.marginBySku.get(x.attach_sku) ?? 0) ||
        (x.attach_sku < y.attach_sku ? -1 : 1),
    )[0];
  if (cand && pushLine(cand.attach_sku, 1)) {
    attachClaimId = cand.id;
    complementSku = cand.attach_sku;
  } else {
    for (const p of [...ix.pairingEntries].sort((a, b) =>
      (a.sku ?? "") < (b.sku ?? "") ? -1 : 1,
    )) {
      const hit = [...p.candidates]
        .filter((s) => inStock(ix, s) && !coreSkus().includes(s))
        .sort((a, b) => (a < b ? -1 : 1))[0];
      if (hit !== undefined && pushLine(hit, 1)) break;
    }
  }

  // 4. Campaign nudge: highest-weight CLEAR_NEAR_EXPIRY/PRIORITIZE_IN_BUNDLES
  //    with an in-stock, not-yet-in-basket target.
  let nudgePriorityId: string | null = null;
  let nudgeClaimEvidenceId: string | null = null;
  const campEntries = pack.entries
    .filter((e) => e.kind === "CAMPAIGN_PRIORITY")
    .map((e) => ({ id: e.id, payload: e.payload }));
  const rankedPriorities = [...priorities].sort(
    (a, b) => b.weight - a.weight || (a.priority_id < b.priority_id ? -1 : 1),
  );
  for (const pr of rankedPriorities) {
    if (pr.action === "PROMOTE_PAIR") continue;
    const target = pr.target_skus.find((s) => inStock(ix, s) && !coreSkus().includes(s));
    if (target === undefined) continue;
    if (pushLine(target, 1)) {
      nudgePriorityId = pr.priority_id;
      nudgeClaimEvidenceId =
        campEntries.find(
          (c) =>
            c.payload.kind === "CAMPAIGN_PRIORITY" &&
            c.payload.payload.priority_id === pr.priority_id,
        )?.id ?? null;
    }
    break;
  }

  // 5. Discount: multi-line baskets earn the flat fallback rate.
  const discount = lines.length >= 2 ? FALLBACK_DEFAULT_PCT : 0;

  // 6. Claims generated programmatically with exact pack ids — the auditor
  //    re-runs on this proposal and is trivially CLEAN.
  const claims: Claim[] = [];
  for (const l of lines) {
    const pid = ix.priceBySku.get(l.sku);
    const priceEntry = pack.entries.find((e) => e.id === pid);
    const label = ix.labelBySku.get(l.sku) ?? l.sku;
    if (pid && priceEntry?.payload.kind === "PRICE") {
      claims.push({
        statement: `${label} is listed at ${RUPEES(priceEntry.payload.payload.list_price_paise)}.`,
        evidence_ids: [pid],
        kind: "PRICE",
      });
    }
    const sid = ix.stockBySku.get(l.sku);
    if (sid) {
      claims.push({
        statement: `${label}: ${ix.stockAvailable.get(l.sku) ?? 0} units available.`,
        evidence_ids: [sid],
        kind: "STOCK",
      });
    }
  }
  if (attachClaimId && complementSku) {
    const ae = pack.entries.find((e) => e.id === attachClaimId);
    if (ae?.payload.kind === "ATTACH_RATE") {
      claims.push({
        statement: `Buyers who take ${
          ix.labelBySku.get(ae.payload.payload.base_sku) ?? ae.payload.payload.base_sku
        } often add ${
          ix.labelBySku.get(complementSku) ?? complementSku
        } (${String(ae.payload.payload.attach_rate_pct)}% attach rate).`,
        evidence_ids: [attachClaimId],
        kind: "ATTACH_RATE",
      });
    }
  }
  if (nudgeClaimEvidenceId && nudgePriorityId) {
    claims.push({
      statement: `Meera's campaign board (ref ${nudgePriorityId}) currently features one of these bakes.`,
      evidence_ids: [nudgeClaimEvidenceId],
      kind: "CAMPAIGN_PRIORITY",
    });
  }

  // 7. Deterministic two-sentence pitch, labeled as the standard offer.
  const names = lines.map((l) => ix.labelBySku.get(l.sku) ?? l.sku);
  const pitch =
    `${discount > 0 ? "Our standard bundle offer" : "Here is our standard offer"}: ` +
    `${names.join(" + ")}, fresh from Meera's kitchen` +
    `${discount > 0 ? `, with the usual ${FALLBACK_DEFAULT_PCT}% bundle saving applied` : ""}. ` +
    `Everything shown is in stock today.`;

  const proposal: NegotiationProposal = {
    proposed_items: lines,
    bundle_discount_pct: discount,
    claims,
    customer_pitch: pitch,
    upsell_reasoning_summary:
      "Deterministic fallback: primary LLM unavailable or failed audit.",
    used_campaign_priority: nudgePriorityId !== null,
    campaign_priority_ids: nudgePriorityId ? [nudgePriorityId] : [],
  };

  const provenance: ProvenanceEnvelope = {
    generator: "DETERMINISTIC_FALLBACK_V1",
    is_fallback: true,
    llm_meta: undefined,
  };
  return { proposal, provenance };
}
