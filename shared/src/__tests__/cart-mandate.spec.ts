/**
 * cart-mandate.spec.ts — audit S5: `arithmeticConsistent` rejected honest
 * mandates because `discount_pct` is a ONE-DECIMAL display projection while the
 * tolerance was a flat ±1 paise.
 *
 * The MandateBuilder runs its own verifier before persisting and THROWS on a
 * rejection, so this was not a cosmetic warning: it turned the APPROVED poll
 * into a 500 for every cart whose discount/subtotal ratio did not happen to land
 * on a tenth of a percent.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  arithmeticConsistent,
  canonicalCartView,
  canonicalJson,
  displayPctTolerancePaise,
  signablePreimage,
  verifyCartMandate,
  type CartMandate,
  type MandateCrypto,
} from "../index.js";

const SECRET = "test-merchant-signing-secret";

const crypto: MandateCrypto = {
  sha256hex: (s) => createHash("sha256").update(s, "utf8").digest("hex"),
  hmacSha256b64: (secret, s) => createHmac("sha256", secret).update(s, "utf8").digest("base64"),
  timingSafeEqB64: (a, b) => {
    const ab = Buffer.from(a, "base64");
    const bb = Buffer.from(b, "base64");
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  },
  nowIso: () => "2026-08-26T10:00:00.000Z",
};

/** One-decimal display pct, exactly as the MandateBuilder computes it. */
function displayPct(discountPaise: number, subtotal: number): number {
  if (subtotal <= 0) return 0;
  return Math.round((discountPaise * 1000) / subtotal) / 10;
}

/** A fully signed mandate for one item at `unit × qty`, discounted by paise. */
function mandateFor(unit: number, qty: number, discountPaise: number): CartMandate {
  const subtotal = unit * qty;
  const core = {
    mandate_id: "cmd_01M1F8B4CXF6SBMZTXHHJFP1RH",
    tx_id: "tx_01M1F8B4CXF6SBMZTXHHJFP1RH",
    items: [{ sku: "BRWN-BOX-9", title: "Brownie Box (9 pc)", qty, unit_price_paise: unit }],
    subtotal_paise: subtotal,
    discount_pct: displayPct(discountPaise, subtotal),
    discount_paise: discountPaise,
    total_paise: subtotal - discountPaise,
    currency: "INR" as const,
    expires_at: "2026-08-26T10:15:00.000Z",
    nonce: "0123456789abcdef0123456789abcdef",
  };
  const cart_hash = crypto.sha256hex(canonicalJson(canonicalCartView(core as unknown as CartMandate)));
  const withHash = { ...core, cart_hash };
  const merchant_sig = crypto.hmacSha256b64(
    SECRET,
    canonicalJson(signablePreimage(withHash as unknown as CartMandate)),
  );
  return { ...withHash, merchant_sig } as CartMandate;
}

describe("arithmeticConsistent — display-pct tolerance (audit S5)", () => {
  it("accepts the case the flat ±1 tolerance rejected: ₹1,000 cart, 745 paise off", () => {
    // pct rounds to 0.7 ⇒ implied 700 paise, a 45-paise gap that is PURELY the
    // one-decimal rendering. The old check demanded |gap| <= 1.
    const m = mandateFor(100_000, 1, 745);
    expect(m.discount_pct).toBe(0.7);
    expect(Math.abs(Math.round((m.subtotal_paise * m.discount_pct) / 100) - m.discount_paise)).toBe(45);
    expect(arithmeticConsistent(m)).toBe(true);
    expect(verifyCartMandate(m, SECRET, crypto)).toEqual({ ok: true });
  });

  it("accepts the audit's own reproduction: 3 brownie boxes at 7.5%", () => {
    const m = mandateFor(24_900, 3, 5_603);
    expect(m.subtotal_paise).toBe(74_700);
    expect(m.total_paise).toBe(69_097);
    expect(arithmeticConsistent(m)).toBe(true);
  });

  it("holds for every discount from 0 to the full subtotal", () => {
    for (const [unit, qty] of [[24_900, 3], [64_900, 1], [19_900, 7], [199_900, 2]] as const) {
      const subtotal = unit * qty;
      for (let d = 0; d <= subtotal; d += Math.max(1, Math.floor(subtotal / 997))) {
        expect(arithmeticConsistent(mandateFor(unit, qty, d))).toBe(true);
      }
    }
  });

  it("still rejects a discount_pct that disagrees BEYOND display rounding", () => {
    const honest = mandateFor(100_000, 1, 745);
    // Claim 5% off a ₹1,000 cart while the paise say 745: a 4,255-paise lie,
    // far outside the ±51 the display projection can explain.
    const lying = { ...honest, discount_pct: 5 } as CartMandate;
    expect(arithmeticConsistent(lying)).toBe(false);
    // …and the signature check catches it independently.
    expect(verifyCartMandate(lying, SECRET, crypto)).not.toEqual({ ok: true });
  });

  it("still rejects broken integer arithmetic (the part that IS exact)", () => {
    const m = mandateFor(24_900, 3, 5_603);
    expect(arithmeticConsistent({ ...m, subtotal_paise: 74_701 } as CartMandate)).toBe(false);
    expect(arithmeticConsistent({ ...m, total_paise: 69_098 } as CartMandate)).toBe(false);
    expect(arithmeticConsistent({ ...m, items: [{ ...m.items[0]!, qty: 4 }] } as CartMandate)).toBe(false);
  });

  it("tolerance scales with the subtotal, because the rounding error does", () => {
    expect(displayPctTolerancePaise(0)).toBe(1);
    expect(displayPctTolerancePaise(100_000)).toBe(51); // ₹1,000 ⇒ 50 paise + 1
    expect(displayPctTolerancePaise(1_000_000)).toBe(501);
  });
});
