/**
 * buildContext — pure pre-processing before any rule runs (gatekeeper.md §7):
 * duplicate-SKU merge, bps conversion ONCE, defensive numeric audit, SKU
 * resolution against ground truth, totals recomputation from RAW prices,
 * drift computation vs AI-claimed totals. No IO, no clock, no mutation of
 * any input object.
 */
import type {
  AiSuppliedTotals,
  AgentVelocitySnapshot,
  CatalogItemGroundTruth,
  GroundTruthSnapshot,
  InjectionSignal,
  MerchantRulesConfig,
  ProposedCart,
  ProposedCartLine,
  RecomputedTotals,
} from "@growthagent/shared";
import {
  allocateProportionally,
  assertSafeInt,
  mulDivRoundHalfUp,
  toBps,
} from "@growthagent/shared";

/** Public API input tuple (gatekeeper.md §4) — declared here, re-exported by
 *  the barrel. */
export interface EvaluateProposalInput {
  readonly proposal: ProposedCart; // POST citation-audit
  readonly rules: MerchantRulesConfig; // versioned; coordinator selects effective version
  readonly ground_truth: GroundTruthSnapshot; // RAW catalog/stock/cost (only pricing authority)
  readonly velocity: AgentVelocitySnapshot; // history projected OUTSIDE, passed IN (purity)
  readonly injection: InjectionSignal; // deterministic tagger output
  readonly now_iso: string; // injected clock — the function owns none
  readonly tx_id: string; // assigned by the pipeline orchestrator
}

export interface GateContext {
  readonly tx_id: string;
  readonly now_iso: string;
  readonly rules: MerchantRulesConfig;
  readonly rules_bps: {
    readonly cartCap: number;
    readonly discCapBps: number;
    readonly marginFloorBps: number;
    readonly valBandLowerEdgePaise: number;
    readonly discBandLowerBps: number;
  };
  /** Bundle-discount percentage as integer bps — converted ONCE here so no
   *  downstream code ever touches the float again (invariant I-3).
   *  (Documented addition to §4: the rules need the converted value.) */
  readonly discount_bps: number;
  /** Defensive structural audit flags from §7 step 2, consumed by
   *  GK-CART-STRUCTURE (documented addition to §4). */
  readonly structural: {
    readonly emptyCart: boolean;
    readonly badNumeric: boolean;
    readonly badQty: boolean;
    readonly badDisc: boolean;
    readonly mergedCount: number;
  };
  /** Drift threshold paise = max(2, round(net * ppm / 1e6)) — evidence twin
   *  of drift_material. */
  readonly drift_threshold_paise: number;
  readonly proposal: ProposedCart;
  /** Duplicates merged (§7); original proposal untouched (purity). */
  readonly merged_lines: readonly ProposedCartLine[];
  readonly sku_index: ReadonlyMap<string, CatalogItemGroundTruth>;
  readonly unresolved_skus: readonly string[];
  readonly totals: RecomputedTotals; // §8 math
  readonly ai_totals: AiSuppliedTotals;
  readonly drift_paise: number;
  readonly drift_material: boolean;
  readonly velocity: AgentVelocitySnapshot;
  readonly injection: InjectionSignal;
  /** ADVISORY PRICE_ECHO_MISMATCH observations (claim vs RAW list price). */
  readonly price_echo_mismatches: readonly {
    readonly sku_id: string;
    readonly claimed_paise: number;
    readonly actual_paise: number;
  }[];
}

/** Merge duplicate SKU lines deterministically: sum quantities; union of
 *  citation_ids preserving first-seen order; claimed_unit_price kept from the
 *  FIRST occurrence only. Returns the merge count (occurrences beyond first)
 *  for the LINES_MERGED advisory. */
export function mergeLines(
  lines: readonly ProposedCartLine[],
): { merged: ProposedCartLine[]; mergedCount: number } {
  const merged: ProposedCartLine[] = [];
  const indexOf = new Map<string, number>();
  let mergedCount = 0;
  for (const l of lines) {
    const i = indexOf.get(l.sku_id);
    if (i !== undefined && merged[i] !== undefined) {
      const prior = merged[i];
      const seen = new Set(prior.citation_ids);
      const unionCitations = [...prior.citation_ids];
      for (const c of l.citation_ids) {
        if (!seen.has(c)) {
          seen.add(c);
          unionCitations.push(c);
        }
      }
      merged[i] = {
        ...prior,
        quantity: prior.quantity + l.quantity,
        citation_ids: unionCitations,
      };
      mergedCount += 1;
    } else {
      indexOf.set(l.sku_id, merged.length);
      merged.push({ ...l });
    }
  }
  return { merged, mergedCount };
}

export function buildContext(input: EvaluateProposalInput): GateContext {
  const { proposal, rules, ground_truth } = input;

  // 1. Merge duplicate SKU lines.
  const { merged, mergedCount } = mergeLines(proposal.lines);

  // 2. Defensive numeric audit (schema already rejected most; belt & suspenders —
  //    a hand-built object bypassing zod must STILL fail closed, not crash).
  const anyNonSafeIntQty = merged.some((l) => !Number.isSafeInteger(l.quantity));
  const badNumeric = anyNonSafeIntQty || !Number.isFinite(proposal.bundle_discount_pct);
  // NaN quantities report as MALFORMED_NUMERIC (numeric sanity outranks the
  // secondary range comparison), never as INVALID_QUANTITY.
  const badQty = !anyNonSafeIntQty && merged.some((l) => l.quantity <= 0);
  const emptyCart = merged.length === 0;
  const badDisc =
    proposal.bundle_discount_pct < 0 || proposal.bundle_discount_pct > 100;

  // 3. Resolve SKUs against ground truth.
  const sku_index = new Map(ground_truth.items.map((it) => [it.sku_id, it]));
  const unresolved_skus = merged
    .filter((l) => !sku_index.has(l.sku_id))
    .map((l) => l.sku_id);

  // 4. Recompute totals from RAW prices (§8) over resolved lines.
  //    Structurally INVALID carts (NaN qty, bad range, …) never reach money
  //    math at all — every product below is zeroed so assertSafeInt cannot be
  //    reached with hostile numerics (fail closed via GK-CART-STRUCTURE FAIL,
  //    never a thrown RangeError — row NAN-DEFENSE).
  const structurallyValid = !badNumeric && !emptyCart && !badQty && !badDisc;
  const resolved = merged.filter((l) => sku_index.has(l.sku_id));
  const weights = resolved.map((l) => {
    if (!structurallyValid) return 0;
    const item = sku_index.get(l.sku_id);
    return assertSafeInt(
      (item?.list_price_paise ?? 0) * l.quantity,
      "line gross",
    );
  });
  const gross = weights.reduce((s, w) => s + w, 0);
  const discBps = structurallyValid ? toBps(proposal.bundle_discount_pct) : 0; // ONE conversion point
  const discount = structurallyValid
    ? mulDivRoundHalfUp(gross, discBps, 10_000) // single HALF_UP event
    : 0;
  const allocs = allocateProportionally(discount, weights); // conserves paise exactly
  const perLine = resolved.map((l, i) => {
    const it = sku_index.get(l.sku_id);
    const g = weights[i] ?? 0;
    const alloc = allocs[i] ?? 0;
    const net = g - alloc;
    const c = structurallyValid
      ? assertSafeInt((it?.cost_price_paise ?? 0) * l.quantity, "line cost")
      : 0;
    return {
      sku_id: l.sku_id,
      quantity: l.quantity,
      gross_paise: g,
      discount_alloc_paise: alloc,
      net_paise: net,
      cost_paise: c,
      margin_paise: net - c,
    };
  });
  const net = perLine.reduce((s, p) => s + p.net_paise, 0); // == gross - discount
  const cost = perLine.reduce((s, p) => s + p.cost_paise, 0);
  const margin = net - cost;
  const totals: RecomputedTotals = {
    line_count: merged.length,
    gross_paise: gross,
    discount_paise: discount,
    net_paise: net,
    cost_paise: cost,
    margin_paise: margin,
    blended_margin_bps:
      net > 0 ? Math.floor((margin * 10_000) / net) : 0, // display only
    per_line: perLine,
  };

  // 5. Drift vs AI-claimed totals (diffed, never obeyed — I-2).
  const drift = Math.abs(input.proposal.ai_supplied_totals.total_paise - net);
  const materialThreshold = Math.max(
    2,
    mulDivRoundHalfUp(net, rules.totals_drift_material_frac_ppm, 1_000_000),
  );
  const drift_material = drift > materialThreshold;

  // 6. Escalation-band edges, computed in integers ONCE (§8.5).
  const cartCap = rules.max_cart_value_paise;
  const discCapBps = toBps(rules.max_discount_pct);
  const marginFloorBps = toBps(rules.margin_floor_pct);
  const valBandBps = toBps(rules.escalation_bands.cart_value_band_pct_below_cap);
  const valBandLowerEdgePaise =
    cartCap - mulDivRoundHalfUp(cartCap, valBandBps, 10_000);
  const discBandLowerBps =
    discCapBps - Math.round(rules.escalation_bands.discount_band_pp_below_cap * 100);

  // 7. Price-echo advisories (recompute wins; mismatch recorded, never obeyed).
  const price_echo_mismatches = merged
    .filter(
      (l) =>
        l.claimed_unit_price_paise !== undefined &&
        sku_index.get(l.sku_id)?.list_price_paise !== l.claimed_unit_price_paise,
    )
    .map((l) => ({
      sku_id: l.sku_id,
      claimed_paise: l.claimed_unit_price_paise as number,
      actual_paise: sku_index.get(l.sku_id)?.list_price_paise ?? -1,
    }));

  return {
    tx_id: input.tx_id,
    now_iso: input.now_iso,
    rules,
    rules_bps: { cartCap, discCapBps, marginFloorBps, valBandLowerEdgePaise, discBandLowerBps },
    discount_bps: discBps,
    structural: { emptyCart, badNumeric, badQty, badDisc, mergedCount },
    drift_threshold_paise: materialThreshold,
    proposal,
    merged_lines: merged,
    sku_index,
    unresolved_skus,
    totals,
    ai_totals: proposal.ai_supplied_totals,
    drift_paise: drift,
    drift_material,
    velocity: input.velocity,
    injection: input.injection,
    price_echo_mismatches,
  };
}
