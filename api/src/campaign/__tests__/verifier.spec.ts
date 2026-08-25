/**
 * Rationale verifier (campaign.md §8.1, tests U-4…U-9) + template fallback
 * self-verification (U-9). The verifier is the deterministic check that keeps
 * the phrasing-only LLM honest.
 */
import { describe, expect, it } from "vitest";
import type { Opportunity } from "@growthagent/shared";
import { assembleEntries } from "../domain/derive.js";
import { normalizeForMatch, verifyRationale } from "../verify/rationale-verifier.js";
import { templateRationale } from "../verify/template-rationales.js";
import {
  ALL_OPPS,
  HONEST_RATIONALES,
  OPP_UNDER,
} from "./campaign-fixtures.js";

function draftOf(opp: Opportunity) {
  const { entries } = assembleEntries([opp]);
  const d = entries[0];
  if (!d) throw new Error("assembly produced no draft");
  return d;
}

describe("U-9 — templates self-verify for every fixture opportunity", () => {
  for (const opp of ALL_OPPS) {
    it(`${opp.type}`, () => {
      expect(verifyRationale(opp, draftOf(opp), templateRationale(opp, draftOf(opp)))).toBe(
        "VERIFIED",
      );
    });
  }
});

describe("U-4 — honest rationales verify", () => {
  for (const opp of ALL_OPPS) {
    it(`${opp.type}`, () => {
      expect(
        verifyRationale(opp, draftOf(opp), HONEST_RATIONALES[opp.type]),
      ).toBe("VERIFIED");
    });
  }
});

describe("U-5/U-6 — invented numbers rejected", () => {
  it("percent-conversion of a ratio ('46%') trips even with every display present", () => {
    // All five displays quoted, PLUS an unauthorized conversion of 0.46x.
    const r =
      "PRIORITIZE_IN_BUNDLES for MANGO_PASTRY: selling 0.46 units/day versus peer " +
      "median 1.00 units/day — 46% below normal pace per the 0.46x ratio — while " +
      "60 units sit in stock with 18.5 weeks of cover. Bundle to close the gap.";
    expect(verifyRationale(OPP_UNDER, draftOf(OPP_UNDER), r)).toBe(
      "INVENTED_NUMBER",
    );
  });

  it("extra '50% off' invention trips (EMPLOYEE50-style, I-5 analog)", () => {
    const r =
      HONEST_RATIONALES.UNDERSELLING + " EMPLOYEE50 should also get 50% off today.";
    expect(verifyRationale(OPP_UNDER, draftOf(OPP_UNDER), r)).toBe(
      "INVENTED_NUMBER",
    );
  });
});

describe("U-7 — missing metric display rejected", () => {
  it("dropping the cover figure fails completeness before anything else", () => {
    const r =
      "PRIORITIZE_IN_BUNDLES for MANGO_PASTRY: selling 0.46 units/day versus peer " +
      "median 1.00 units/day, which is 0.46x of normal pace, with 60 units in stock. " +
      "Bundle this into hampers to close the gap.";
    expect(verifyRationale(OPP_UNDER, draftOf(OPP_UNDER), r)).toBe(
      "MISSING_METRIC",
    );
  });
});

describe("membership, not counts; raw values tolerated", () => {
  it("restating a metric twice is fine", () => {
    const r = `${HONEST_RATIONALES.TIMING} Again: 2.15x on Sundays.`;
    expect(verifyRationale(ALL_OPPS[3]!, draftOf(ALL_OPPS[3]!), r)).toBe(
      "VERIFIED",
    );
  });

  it("the full-precision raw value is allowed alongside the display", () => {
    const r = `Ratio is ${String((13 / 28).valueOf())} exactly — displayed 0.46x —
      selling 0.46 units/day vs 1.00 units/day peers, 60 units on hand,
      cover of 18.5 weeks.`;
    expect(verifyRationale(OPP_UNDER, draftOf(OPP_UNDER), r)).toBe("VERIFIED");
  });
});

describe("U-8 — normalizer robustness", () => {
  it("Indian grouping / rupee sign / unicode minus / subscripts", () => {
    expect(normalizeForMatch("₹1,23,456.00")).toContain("123456.00");
    expect(normalizeForMatch("−5 days")).toBe("-5 days");
    expect(normalizeForMatch("sales doubled to ₂₀ units")).toContain("20 units");
  });

  it("SKU-like identifiers never fabricate numbers", () => {
    expect(normalizeForMatch("KAJU_KATLI_250G")).not.toMatch(/\d/);
    expect(normalizeForMatch("CAKE-CHOC-500 since Monday")).not.toContain("500");
    // …but EMPLOYEE50 (no separator) keeps its digits — injections must trip.
    expect(normalizeForMatch("code EMPLOYEE50 works")).toContain("employee50");
  });

  it("residual unit suffixes strip after digits", () => {
    expect(normalizeForMatch("weighs 500g")).not.toContain("500g");
    expect(normalizeForMatch("weighs 500g")).toContain("500");
  });
});
