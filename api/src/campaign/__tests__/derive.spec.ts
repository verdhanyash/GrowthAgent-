/**
 * Deterministic derivation core (campaign.md §6.3–§6.6): weight worked
 * examples, monotonicity/clamp properties, id stability, total-order assembly
 * with audited suppressions, and content-bound priority-set ids.
 */
import { describe, expect, it } from "vitest";
import type { Opportunity, OpportunityType } from "@growthagent/shared";
import {
  ACTION_MAP,
  TYPE_TIEBREAK,
  addSecondsIso,
  assembleEntries,
  buildPrioritySet,
  entryId,
  h10,
  opportunityId,
  opportunityWeight,
} from "../domain/derive.js";
import {
  ALL_OPPS,
  AS_OF,
  OPP_ATTACH,
  OPP_UNDER,
  RUN_ID,
} from "./campaign-fixtures.js";

describe("§6.5 worked examples", () => {
  it("UNDERSELLING: ratio 0.4643 / cover 18.5w → weight 0.44", () => {
    const w = opportunityWeight({
      type: "UNDERSELLING",
      velocityRatio: 0.4642857142857143,
      weeksOfStockCover: 60 / ((13 / 28) * 7),
    });
    expect(w).toBeCloseTo(0.4429, 4);
    expect(Number(w.toFixed(2))).toBe(0.44);
  });

  it("EXPIRY_RISK: surplus 28/30, dte 5 → weight 0.71", () => {
    const w = opportunityWeight({
      type: "EXPIRY_RISK",
      projectedSurplusUnits: 28,
      stockUnits: 30,
      daysToExpiry: 5,
    });
    expect(w).toBeCloseTo(0.7067, 4);
    expect(Number(w.toFixed(2))).toBe(0.71);
  });

  it("TIMING at exactly timingMinLift gives ~0.53; WD-1 lift 2.15 → 0.77", () => {
    expect(opportunityWeight({ type: "TIMING", lift: 1.8 })).toBeCloseTo(
      0.5333,
      4,
    );
    expect(
      Number(opportunityWeight({ type: "TIMING", lift: 2.15 }).toFixed(2)),
    ).toBe(0.77);
  });

  it("AT-1 floors included: conf 15% / support 6% → 0.58", () => {
    expect(
      Number(
        opportunityWeight({
          type: "ATTACH_BUNDLE",
          confidence: 0.15,
          support: 0.06,
        }).toFixed(2),
      ),
    ).toBe(0.58);
  });
});

describe("U-1 monotonicity sweeps", () => {
  it("lower velocity ratio never lowers the UNDERSELLING weight", () => {
    // Walk ratio DESCENDING so each step makes the SKU more underselling —
    // weight must be non-decreasing along that walk.
    let prev = -1;
    for (let r = 0.6; r >= 0.049; r -= 0.01) {
      const w = opportunityWeight({
        type: "UNDERSELLING",
        velocityRatio: r,
        weeksOfStockCover: 10,
      });
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it("more cover raises UNDERSELLING; more surplus / nearer expiry raise EXPIRY", () => {
    expect(
      opportunityWeight({
        type: "UNDERSELLING",
        velocityRatio: 0.4,
        weeksOfStockCover: 12,
      }),
    ).toBeGreaterThanOrEqual(
      opportunityWeight({
        type: "UNDERSELLING",
        velocityRatio: 0.4,
        weeksOfStockCover: 5,
      }),
    );
    const exp = (surplus: number, dte: number) =>
      opportunityWeight({
        type: "EXPIRY_RISK",
        projectedSurplusUnits: surplus,
        stockUnits: 30,
        daysToExpiry: dte,
      });
    expect(exp(29, 3)).toBeGreaterThanOrEqual(exp(20, 3));
    expect(exp(20, 1)).toBeGreaterThanOrEqual(exp(20, 6));
  });

  it("higher confidence/support/lift are monotone in their types", () => {
    expect(
      opportunityWeight({ type: "ATTACH_BUNDLE", confidence: 0.3, support: 0.06 }),
    ).toBeGreaterThanOrEqual(
      opportunityWeight({ type: "ATTACH_BUNDLE", confidence: 0.16, support: 0.06 }),
    );
    expect(
      opportunityWeight({ type: "ATTACH_BUNDLE", confidence: 0.2, support: 0.09 }),
    ).toBeGreaterThanOrEqual(
      opportunityWeight({ type: "ATTACH_BUNDLE", confidence: 0.2, support: 0.04 }),
    );
    expect(opportunityWeight({ type: "TIMING", lift: 2.5 })).toBeGreaterThanOrEqual(
      opportunityWeight({ type: "TIMING", lift: 2.0 }),
    );
  });
});

describe("U-2 clamps", () => {
  it("huge lift clamps to exactly 1; below-baseline lift clamps to 0", () => {
    expect(opportunityWeight({ type: "TIMING", lift: 100 })).toBe(1);
    expect(opportunityWeight({ type: "TIMING", lift: 0.2 })).toBe(0);
  });

  it("ratio above threshold leaves only the cover term (severity floor 0)", () => {
    // ratio ≥ undersellRatioMax ⇒ severity 0; cover 999 sentinel saturates.
    expect(
      opportunityWeight({
        type: "UNDERSELLING",
        velocityRatio: 0.9,
        weeksOfStockCover: 999,
      }),
    ).toBeCloseTo(0.4, 6);
  });

  it("expiry urgency saturates when expiring today (§14)", () => {
    // full surplus + dte 0 → 0.65·1 + 0.35·1 = 1
    expect(
      opportunityWeight({
        type: "EXPIRY_RISK",
        projectedSurplusUnits: 30,
        stockUnits: 30,
        daysToExpiry: 0,
      }),
    ).toBe(1);
  });
});

describe("U-3 id stability", () => {
  it("golden vector + regex shape", () => {
    expect(h10("hello")).toHaveLength(10);
    expect(opportunityId(RUN_ID, "UNDERSELLING", ["MANGO_PASTRY"])).toBe(
      OPP_UNDER.opportunity_id,
    );
    expect(OPP_UNDER.opportunity_id).toMatch(/^opp_underselling_[0-9a-f]{10}$/);
  });

  it("reordering the skus input yields the same id", () => {
    const a = opportunityId(RUN_ID, "ATTACH_BUNDLE", ["AAA", "BBB"]);
    const b = opportunityId(RUN_ID, "ATTACH_BUNDLE", ["BBB", "AAA"]);
    expect(a).toBe(b);
  });

  it("changed run or skus change the id", () => {
    const base = opportunityId(RUN_ID, "TIMING", ["X"]);
    expect(opportunityId("ar_other", "TIMING", ["X"])).not.toBe(base);
    expect(opportunityId(RUN_ID, "TIMING", ["Y"])).not.toBe(base);
  });

  it("entry ids bind run+opportunity deterministically", () => {
    expect(entryId(RUN_ID, OPP_UNDER.opportunity_id)).toBe(
      `pe_${h10(`${RUN_ID}|${OPP_UNDER.opportunity_id}`)}`,
    );
  });
});

describe("assembleEntries (§6.6)", () => {
  it("orders by weight desc with type tiebreak and id tiebreak", () => {
    const { entries } = assembleEntries(ALL_OPPS);
    // Fixture weights: EXPIRY .71 > TIMING .77? — TIMING 0.7667 → 0.77 ranks
    // FIRST, then EXPIRY .71, ATTACH .58, UNDER .44.
    expect(entries.map((e) => e.action)).toEqual([
      "PRIORITIZE_IN_BUNDLES", // TIMING
      "CLEAR_NEAR_EXPIRY",
      "PROMOTE_PAIR",
      "PRIORITIZE_IN_BUNDLES", // UNDERSELLING
    ]);
  });

  it("shared-SKU conflict resolves by weight, then type tiebreak, then id — suppressions recorded", () => {
    const mk = (
      id: string,
      type: OpportunityType,
      skus: string[],
      weight: number,
    ): Opportunity => ({
      opportunity_id: id,
      type,
      skus,
      metrics: [
        { key: "a", label: "A", value: 1, display: "1 units" },
        { key: "b", label: "B", value: 2, display: "2" },
      ],
      weight,
      analytics_run_id: RUN_ID,
      generated_at_sim: AS_OF,
    });
    // Same sku SHARED; equal weights ⇒ EXPIRY_RISK (tiebreak 0) wins.
    const a = mk("opp_a_0000000001", "UNDERSELLING", ["S1"], 0.5);
    const b = mk("opp_b_0000000002", "EXPIRY_RISK", ["S1"], 0.5);
    const res = assembleEntries([a, b]);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]?.opportunity_id).toBe(b.opportunity_id);
    expect(res.entries[0]?.action).toBe("CLEAR_NEAR_EXPIRY");
    expect(res.suppressed).toEqual([
      { opportunity: a, reason: "SKU_ALREADY_CLAIMED" },
    ]);
  });

  it("SET_FULL caps entries at maxEntriesPerSet (8) and audits the rest", () => {
    const opps: Opportunity[] = Array.from({ length: 11 }, (_, i) => ({
      opportunity_id: `opp_x_${String(i).padStart(10, "0")}`,
      type: "UNDERSELLING",
      skus: [`SKU-${i}`],
      metrics: [
        { key: "a", label: "A", value: i, display: `${i}` },
        { key: "b", label: "B", value: i, display: `${i}.0x` },
      ],
      weight: 0.1 * i, // distinct, ascending
      analytics_run_id: RUN_ID,
      generated_at_sim: AS_OF,
    }));
    const res = assembleEntries(opps); // input order scrambled on purpose
    expect(res.entries).toHaveLength(8);
    expect(res.suppressed).toHaveLength(3);
    expect(res.suppressed.every((s) => s.reason === "SET_FULL")).toBe(true);
    // Highest-weight eight kept (weights .3–1.0); lowest three suppressed.
    expect(res.entries[0]?.weight).toBe(1);
    expect(res.entries[7]?.weight).toBeCloseTo(0.3, 10);
  });

  it("entries carry sorted skus, rounded weights, empty rationale, provisional provenance", () => {
    const { entries } = assembleEntries([OPP_ATTACH]);
    expect(entries[0]?.skus).toEqual([
      "BUTTER_COOKIE_JAR",
      "KAJU_KATLI_250G",
    ]); // already asc; reversed input must sort
    expect(entries[0]?.weight).toBe(0.58);
    expect(entries[0]?.rationale_nl).toBe("");
    expect(entries[0]?.rationale_provenance).toBe("VERIFIED_LLM");
    expect(entries[0]?.entry_id).toMatch(/^pe_[0-9a-f]{10}$/);
  });

  it("is deterministic across shuffled inputs (byte-equal assembly)", () => {
    const shuffled = [...ALL_OPPS].reverse();
    expect(JSON.stringify(assembleEntries(shuffled))).toEqual(
      JSON.stringify(assembleEntries([...shuffled].sort(() => 0.5 - Math.random()))),
    );
  });
});

describe("ACTION_MAP / TYPE_TIEBREAK totals", () => {
  it("fixed §6.4 mapping", () => {
    expect(ACTION_MAP.UNDERSELLING).toBe("PRIORITIZE_IN_BUNDLES");
    expect(ACTION_MAP.EXPIRY_RISK).toBe("CLEAR_NEAR_EXPIRY");
    expect(ACTION_MAP.ATTACH_BUNDLE).toBe("PROMOTE_PAIR");
    expect(ACTION_MAP.TIMING).toBe("PRIORITIZE_IN_BUNDLES"); // reason lives in rationale
  });

  it("type tiebreak order is expiry < undersell < attach < timing", () => {
    expect(TYPE_TIEBREAK.EXPIRY_RISK).toBeLessThan(TYPE_TIEBREAK.UNDERSELLING);
    expect(TYPE_TIEBREAK.UNDERSELLING).toBeLessThan(TYPE_TIEBREAK.ATTACH_BUNDLE);
    expect(TYPE_TIEBREAK.ATTACH_BUNDLE).toBeLessThan(TYPE_TIEBREAK.TIMING);
  });
});

describe("buildPrioritySet + addSecondsIso", () => {
  const base = () =>
    buildPrioritySet({
      version: 3,
      analyticsRunId: RUN_ID,
      generatedAtSim: AS_OF,
      status: "FRESH",
      entries: [],
      llmInvocation: null,
    });

  it("set_id binds version + content digest, stable across identical calls", () => {
    const s1 = base();
    const s2 = base();
    expect(s1.set_id).toMatch(/^ps_v3_[0-9a-f]{8}$/);
    expect(s1.set_id).toBe(s2.set_id);
  });

  it("content sensitivity: different entries → different md8", () => {
    const other = buildPrioritySet({
      version: 3,
      analyticsRunId: RUN_ID,
      generatedAtSim: AS_OF,
      status: "FRESH",
      entries: [
        {
          entry_id: entryId(RUN_ID, OPP_UNDER.opportunity_id),
          opportunity_id: OPP_UNDER.opportunity_id,
          action: "PRIORITIZE_IN_BUNDLES",
          skus: ["MANGO_PASTRY"],
          weight: 0.44,
          rationale_nl: "deterministic template rationale text here",
          rationale_provenance: "TEMPLATE_FALLBACK",
        },
      ],
      llmInvocation: null,
    });
    expect(other.set_id).not.toBe(base().set_id);
  });

  it("valid_until_sim = generated_at_sim + ttl (21600s), schema-clean shape", () => {
    const s = base();
    expect(s.ttl_seconds).toBe(21600);
    expect(s.valid_until_sim).toBe(addSecondsIso(AS_OF, 21600));
    expect(addSecondsIso("2026-08-24T18:29:59.000Z", 1)).toBe(
      "2026-08-24T18:30:00.000Z",
    );
  });
});
