/**
 * shared/src/api/cart-mandate.ts — the externally verifiable artifact
 * (api-contract.md §6). AP2-*inspired*, explicitly NOT wire-compatible.
 *
 * A machine-checkable, merchant-signed statement of exactly what may be bought
 * at exactly what price. NO numeric field originates from an LLM: a deterministic
 * MandateBuilder (api/) recomputes everything from raw catalog rows + the
 * gatekeeper-approved settlement bytes.
 *
 * This module stays crypto-free (web imports shared): `verifyCartMandate` takes
 * injected hash/hmac/clock fns so the same verifier runs in Node and the browser.
 */
import { z } from "zod";
import { canonicalJson } from "../canonical.js";
import { Paise, Sku, TxId, MandateId, IsoDateTime, HexSha256 } from "./primitives.js";

export const CartMandateItemSchema = z
  .object({
    sku: Sku,
    title: z.string().min(1).max(200), // copied from RAW catalog row, never LLM prose
    qty: z.number().int().positive().max(99),
    unit_price_paise: Paise, // RAW list price at mandate-build time
  })
  .strict();
export type CartMandateItem = z.infer<typeof CartMandateItemSchema>;

export const CartMandateSchema = z
  .object({
    mandate_id: MandateId,
    tx_id: TxId,
    cart_hash: HexSha256, // SHA-256 over canonicalCartView
    items: z.array(CartMandateItemSchema).min(1).max(20),
    subtotal_paise: Paise,
    discount_pct: z.number().min(0).max(100),
    discount_paise: Paise,
    total_paise: Paise,
    currency: z.literal("INR"),
    expires_at: IsoDateTime, // sim clock + MANDATE_TTL_MS
    nonce: z.string().regex(/^[0-9a-f]{32}$/), // crypto.randomBytes(16) hex
    merchant_sig: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/), // HMAC-SHA256, base64
  })
  .strict();
export type CartMandate = z.infer<typeof CartMandateSchema>;

/** The economically meaningful core the cart_hash covers (§6.1). */
export function canonicalCartView(m: Pick<
  CartMandate,
  "items" | "subtotal_paise" | "discount_pct" | "discount_paise" | "total_paise" | "currency"
>): Record<string, unknown> {
  return {
    items: m.items,
    subtotal_paise: m.subtotal_paise,
    discount_pct: m.discount_pct,
    discount_paise: m.discount_paise,
    total_paise: m.total_paise,
    currency: m.currency,
  };
}

/** The signable preimage: the ENTIRE mandate minus merchant_sig (§6.1). */
export function signablePreimage(m: CartMandate): Record<string, unknown> {
  const { merchant_sig: _omit, ...rest } = m;
  return rest;
}

/**
 * Integer-math arithmetic self-consistency of a mandate's money fields.
 *
 * The three PAISE fields are authoritative — settlement moves exactly
 * `total_paise`, and `subtotal_paise`/`discount_paise` are recomputed by the
 * deterministic MandateBuilder from RAW catalog rows + the gatekeeper-approved
 * net (never from an LLM). So the exact economic invariants are integer:
 *   subtotal == Σ(unit×qty)   and   subtotal − discount == total.
 * `discount_pct` is a one-decimal DISPLAY projection of the exact paise
 * discount (the gatekeeper allocates with ROUND_HALF_UP, so a strict
 * floor(subtotal×pct/100) round-trip need not land on the paise to the unit);
 * it is checked only to agree with `discount_paise` within a 1-paise rounding
 * tolerance. cart_hash + merchant_sig still bind every field exactly.
 */
export function arithmeticConsistent(m: CartMandate): boolean {
  const subtotal = m.items.reduce((s, it) => s + it.unit_price_paise * it.qty, 0);
  if (subtotal !== m.subtotal_paise) return false;
  if (m.subtotal_paise - m.discount_paise !== m.total_paise) return false;
  const impliedByPct = Math.round((m.subtotal_paise * m.discount_pct) / 100);
  return Math.abs(impliedByPct - m.discount_paise) <= 1;
}

export interface MandateCrypto {
  readonly sha256hex: (s: string) => string;
  readonly hmacSha256b64: (secret: string, s: string) => string;
  readonly timingSafeEqB64: (a: string, b: string) => boolean;
  readonly nowIso: () => string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** What an external buyer-agent runs before paying (§6). Fails closed. */
export function verifyCartMandate(m: CartMandate, secret: string, c: MandateCrypto): VerifyResult {
  if (c.sha256hex(canonicalJson(canonicalCartView(m))) !== m.cart_hash)
    return { ok: false, reason: "CART_HASH_MISMATCH" };
  if (!arithmeticConsistent(m)) return { ok: false, reason: "ARITHMETIC_MISMATCH" };
  const expect = c.hmacSha256b64(secret, canonicalJson(signablePreimage(m)));
  if (!c.timingSafeEqB64(expect, m.merchant_sig)) return { ok: false, reason: "BAD_MERCHANT_SIG" };
  if (c.nowIso() >= m.expires_at) return { ok: false, reason: "MANDATE_EXPIRED" };
  return { ok: true };
}
