/**
 * Money-math unit specs (gatekeeper.md §8): HALF_UP boundaries, allocation
 * conservation/degeneracy, cross-margin equivalence at the exact boundary,
 * bps conversion, safe-int guards, en-IN formatting.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  allocateProportionally,
  assertSafeInt,
  crossMarginHolds,
  formatPaise,
  formatPct,
  mulDivRoundHalfUp,
  toBps,
} from "@growthagent/shared";

describe("toBps — the ONE conversion point", () => {
  it("converts percentages once: 7.5% -> 750 bps", () => {
    expect(toBps(7.5)).toBe(750);
    expect(toBps(0)).toBe(0);
    expect(toBps(100)).toBe(10_000);
    expect(toBps(15.01)).toBe(1501); // float noise rounded away deterministically
    expect(toBps(9.99)).toBe(999);
  });
  it("rejects non-finite input", () => {
    expect(() => toBps(Number.NaN)).toThrow(RangeError);
    expect(() => toBps(Infinity)).toThrow(RangeError);
  });
});

describe("mulDivRoundHalfUp — the ONLY rounding event", () => {
  it("§8.4 worked example: 114700 × 750 / 10000 = 8603 (HALF_UP of .5)", () => {
    expect(mulDivRoundHalfUp(114_700, 750, 10_000)).toBe(8603);
  });
  it("HALF_UP boundary: exactly .5 rounds UP (accounting convention)", () => {
    // 1*1/2 = 0.5 → 1 ; 3*1/2 = 1.5 → 2
    expect(mulDivRoundHalfUp(1, 1, 2)).toBe(1);
    expect(mulDivRoundHalfUp(3, 1, 2)).toBe(2);
    // just below .5 rounds down; just above rounds up
    expect(mulDivRoundHalfUp(4999, 1, 10_000)).toBe(0);
    expect(mulDivRoundHalfUp(5001, 1, 10_000)).toBe(1);
  });
  it("exact division is exact", () => {
    expect(mulDivRoundHalfUp(500_000, 1500, 10_000)).toBe(75_000);
  });
  it("guards domain: negative divisor, non-safe integers throw", () => {
    expect(() => mulDivRoundHalfUp(1, 1, 0)).toThrow(RangeError);
    expect(() => mulDivRoundHalfUp(Number.NaN, 1, 10)).toThrow(RangeError);
    expect(() => mulDivRoundHalfUp(2 ** 53, 2, 10)).toThrow(RangeError); // > MAX_SAFE
  });
});

describe("allocateProportionally — paise-conserving largest remainder", () => {
  it("conserves the total exactly on the §8.4 worked example", () => {
    const out = allocateProportionally(8603, [64_900, 49_800]);
    expect(out).toEqual([4868, 3735]);
    expect(out.reduce((s, x) => s + x, 0)).toBe(8603);
  });

  it("degenerate all-zero weights: line 1 takes everything (documented)", () => {
    expect(allocateProportionally(500, [0, 0, 0])).toEqual([500, 0, 0]);
  });

  it("empty weights → empty allocation", () => {
    expect(allocateProportionally(100, [])).toEqual([]);
  });

  it("ties broken by ascending index (deterministic)", () => {
    const out = allocateProportionally(2, [1, 1]); // both frac .0 after floor? raw=1 each, base 1+1=2 leftover 0
    expect(out).toEqual([1, 1]);
    const out2 = allocateProportionally(3, [1, 1]); // raw 1.5/1.5, bases 1,1 leftover 1 → index 0 wins tie
    expect(out2).toEqual([2, 1]);
  });

  it("property: conservation + bounds on randomized inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.array(fc.integer({ min: 0, max: 2 ** 30 }), { minLength: 1, maxLength: 30 }),
        (total, weights) => {
          const out = allocateProportionally(total, weights);
          expect(out.reduce((s, x) => s + x, 0)).toBe(total);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("crossMarginHolds — float-free floor comparison", () => {
  it("§8.4 worked example passes at 25% floor", () => {
    // M=40097 N=106097 floor 2500bps: 40097*10000=400,970,000 >= 2500*106097=265,242,500
    expect(crossMarginHolds(40_097, 106_097, 2500)).toBe(true);
  });
  it("exact equality holds (inclusive floor)", () => {
    expect(crossMarginHolds(25_000, 100_000, 2500)).toBe(true);
  });
  it("one paisa of margin less fails", () => {
    expect(crossMarginHolds(24_999, 100_000, 2500)).toBe(false);
  });
  it("zero/negative net fails closed (undefined percentage)", () => {
    expect(crossMarginHolds(0, 0, 2500)).toBe(false);
    expect(crossMarginHolds(-5, -100, 0)).toBe(false);
  });
});

describe("assertSafeInt", () => {
  it("passes safe integers, rejects everything else", () => {
    expect(assertSafeInt(0)).toBe(0);
    expect(assertSafeInt(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => assertSafeInt(1.5)).toThrow(RangeError);
    expect(() => assertSafeInt(Number.NaN)).toThrow(RangeError);
    expect(() => assertSafeInt(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe("formatPaise / formatPct", () => {
  it("formats en-IN rupees with paise", () => {
    expect(formatPaise(106_097)).toBe("₹1,060.97");
    expect(formatPaise(500_000)).toBe("₹5,000.00");
    expect(formatPaise(0)).toBe("₹0.00");
    expect(formatPaise(-123)).toBe("-₹1.23");
    expect(formatPaise(12_34_56_789)).toBe("₹12,34,567.89"); // lakh/crore grouping
  });
  it("formats fixed-dp percents", () => {
    expect(formatPct(18.1987)).toBe("18.20%");
    expect(formatPct(25)).toBe("25.00%");
  });
});
