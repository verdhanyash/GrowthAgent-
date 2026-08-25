/**
 * Deterministic derivation core (campaign.md §6.3–§6.6): content-derived
 * opportunity ids, fixed action mapping, monotone clamped weight functions,
 * and total-order entry assembly with audited suppressions.
 *
 * PURE: no clock, no randomness, no IO. Same opportunities ⇒ byte-identical
 * entries, actions, weights, order (determinism guarantee #2, §13).
 */
import { createHash } from "node:crypto";
import {
  CAMPAIGN_CONFIG,
  canonicalJson,
  type LlmInvocation,
  type Opportunity,
  type OpportunityType,
  type PriorityAction,
  type PriorityEntry,
  type PrioritySet,
} from "@growthagent/shared";

/* ------------------------------- identity ------------------------------- */

export const h10 = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 10);

/** Same inputs ⇒ byte-identical id; two runs over unchanged data produce the
 *  SAME ids (idempotent republication). SKU sort makes id independent of the
 *  caller's array order. */
export const opportunityId = (
  runId: string,
  type: OpportunityType,
  skus: string[],
): string =>
  `opp_${type.toLowerCase()}_${h10(
    `${runId}|${type}|${[...skus].sort().join("+")}`,
  )}`;

export const entryId = (runId: string, opportunityId: string): string =>
  `pe_${h10(`${runId}|${opportunityId}`)}`;

/* ----------------------------- action mapping --------------------------- */

/** Fixed map (§6.4) — no LLM involvement. TIMING reuses PRIORITIZE_IN_BUNDLES
 *  because the action enum is committed at three members; the timing reason
 *  rides in the metrics + rationale. */
export const ACTION_MAP: Record<OpportunityType, PriorityAction> = {
  UNDERSELLING: "PRIORITIZE_IN_BUNDLES",
  EXPIRY_RISK: "CLEAR_NEAR_EXPIRY",
  ATTACH_BUNDLE: "PROMOTE_PAIR",
  TIMING: "PRIORITIZE_IN_BUNDLES",
};

/* ---------------------------- weight functions -------------------------- */

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export type WeightInputs =
  | { type: "UNDERSELLING"; velocityRatio: number; weeksOfStockCover: number }
  | {
      type: "EXPIRY_RISK";
      projectedSurplusUnits: number;
      stockUnits: number;
      daysToExpiry: number;
    }
  | { type: "ATTACH_BUNDLE"; confidence: number; support: number }
  | { type: "TIMING"; lift: number };

/**
 * Deterministic, monotone, clamped (§6.5). Computed from UNROUNDED metrics;
 * rounding to 2 dp happens ONCE at entry emission (assembleEntries) — the
 * chosen order is pinned by derive.spec.ts.
 */
export function opportunityWeight(o: WeightInputs): number {
  switch (o.type) {
    case "UNDERSELLING": {
      const severity =
        1 - Math.min(o.velocityRatio / CAMPAIGN_CONFIG.undersellRatioMax, 1);
      const coverTerm = clamp01(
        (o.weeksOfStockCover - CAMPAIGN_CONFIG.coverWeeksMin) / 8,
      );
      return 0.6 * severity + 0.4 * coverTerm;
    }
    case "EXPIRY_RISK": {
      const surplusFraction = o.projectedSurplusUnits / o.stockUnits;
      const urgency =
        1 - o.daysToExpiry / CAMPAIGN_CONFIG.expiryHorizonDays;
      return clamp01(
        0.65 * clamp01(surplusFraction) + 0.35 * clamp01(urgency),
      );
    }
    case "ATTACH_BUNDLE":
      return clamp01(
        0.5 *
          clamp01(o.confidence / (2 * CAMPAIGN_CONFIG.attachMinConfidence)) +
          0.5 * clamp01(o.support / (3 * CAMPAIGN_CONFIG.attachMinSupport)),
      );
    case "TIMING":
      return clamp01((o.lift - 1) / 1.5);
  }
}

/* ------------------------- assembly (§6.6) ------------------------------ */

export const TYPE_TIEBREAK: Record<OpportunityType, number> = {
  EXPIRY_RISK: 0,
  UNDERSELLING: 1,
  ATTACH_BUNDLE: 2,
  TIMING: 3,
};

/** Pre-publication draft: schema-shaped except rationale fields, which stay
 *  empty/provisional until the verifier stage fills them. */
export interface EntryDraft {
  readonly entry_id: string;
  readonly opportunity_id: string;
  readonly action: PriorityAction;
  readonly skus: readonly string[];
  readonly weight: number;
  rationale_nl: string;
  rationale_provenance: "VERIFIED_LLM" | "TEMPLATE_FALLBACK";
}

export interface SuppressedOpp {
  readonly opportunity: Opportunity;
  readonly reason: "SKU_ALREADY_CLAIMED" | "SET_FULL";
}

export interface Assembly {
  readonly entries: EntryDraft[];
  readonly suppressed: SuppressedOpp[];
}

export function assembleEntries(opps: readonly Opportunity[]): Assembly {
  // Total order: weight desc → type tiebreak → id asc. Deterministic.
  const ranked = [...opps].sort(
    (a, b) =>
      b.weight - a.weight ||
      TYPE_TIEBREAK[a.type] - TYPE_TIEBREAK[b.type] ||
      (a.opportunity_id < b.opportunity_id ? -1 : 1),
  );

  const owner = new Map<string, string>(); // sku -> owning opportunity_id
  const entries: EntryDraft[] = [];
  const suppressed: SuppressedOpp[] = [];
  for (const o of ranked) {
    if (entries.length >= CAMPAIGN_CONFIG.maxEntriesPerSet) {
      suppressed.push({ opportunity: o, reason: "SET_FULL" });
      continue;
    }
    if (o.skus.some((s) => owner.has(s))) {
      suppressed.push({ opportunity: o, reason: "SKU_ALREADY_CLAIMED" });
      continue;
    }
    for (const s of o.skus) owner.set(s, o.opportunity_id);
    entries.push({
      entry_id: entryId(o.analytics_run_id, o.opportunity_id),
      opportunity_id: o.opportunity_id,
      action: ACTION_MAP[o.type],
      skus: [...o.skus].sort(),
      weight: Number(o.weight.toFixed(2)), // ONE rounding event at emission
      rationale_nl: "", // filled by the LLM-or-template stage
      rationale_provenance: "VERIFIED_LLM", // provisional
    });
  }
  return { entries, suppressed };
}

/* --------------------------- priority-set shell -------------------------- */

/** ISO instant + whole seconds → ISO instant (pure; parses caller input). */
export function addSecondsIso(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/**
 * Builds the publishable set. `set_id` binds content: ps_v<version>_<md8>,
 * where md8 = md5(canonicalJson(set-without-set_id)) sliced 8 — the TS-side
 * counterpart of §9's `left(md5(payload::text), 8)` (canonicalJson IS what we
 * persist, so the two formulations coincide).
 */
export function buildPrioritySet(args: {
  version: number;
  analyticsRunId: string | null;
  generatedAtSim: string;
  status: "FRESH" | "EMPTY" | "TEMPLATE_ONLY" | "PARTIAL_TEMPLATE";
  entries: readonly PriorityEntry[];
  llmInvocation: LlmInvocation | null;
}): PrioritySet {
  const ttl = CAMPAIGN_CONFIG.prioritySetTtlSeconds;
  const withoutId = {
    priority_set_version: args.version,
    analytics_run_id: args.analyticsRunId,
    status: args.status,
    entries: [...args.entries],
    generated_at_sim: args.generatedAtSim,
    ttl_seconds: ttl,
    valid_until_sim: addSecondsIso(args.generatedAtSim, ttl),
    llm_invocation: args.llmInvocation,
  };
  const md8 = createHash("md5")
    .update(canonicalJson(withoutId))
    .digest("hex")
    .slice(0, 8);
  return {
    set_id: `ps_v${args.version}_${md8}`,
    ...withoutId,
  };
}
