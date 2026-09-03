/**
 * api/src/http/mandate-builder.ts — the deterministic MandateBuilder (§6.2).
 *
 * NO numeric field originates from an LLM. Everything is recomputed from RAW
 * catalog rows (titles + list prices) and the gatekeeper-approved net that
 * settlement actually charges:
 *   subtotal_paise = Σ raw_list_price × qty     (RAW prices, not the discounted
 *                                                per-line unit settlement moves)
 *   total_paise    = transactions.approved_total_paise   (authoritative net)
 *   discount_paise = subtotal − total
 *   discount_pct   = one-decimal display projection of discount_paise/subtotal
 *
 * The three paise fields are the exact economic core; discount_pct is a display
 * value checked within a 1-paise tolerance by `arithmeticConsistent` (the
 * gatekeeper allocates the discount ROUND_HALF_UP, so a strict floor round-trip
 * of pct need not land on the unit). The mandate is lazily minted on the first
 * poll and persisted once, so expires_at + nonce stay stable across polls.
 */
import { randomBytes } from "node:crypto";
import {
  CartMandateSchema,
  canonicalCartView,
  canonicalJson,
  parsePaiseExact,
  signablePreimage,
  verifyCartMandate,
  type CartMandate,
  type CartMandateItem,
  type GroundTruthSnapshot,
} from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { hmacSha256B64, sha256Hex, nodeMandateCrypto } from "./crypto.js";
import { mintMandateId } from "./ids.js";

export const DEFAULT_MANDATE_TTL_MS = 15 * 60_000;
export const DEV_MERCHANT_SIGNING_SECRET = "ga-merchant-signing-secret-dev-only";

export interface MandateBuilderDeps {
  readonly db: PgPool;
  readonly groundTruth: () => Promise<GroundTruthSnapshot>;
  readonly nowMs: () => number;
  readonly signingSecret: string;
  readonly mandateTtlMs?: number;
}

interface SettleableRow {
  proposal_bytes: { lines?: Array<{ sku: string; qty: number; unit_price_paise: number }> };
  /** BIGINT column: node-pg hands it over as a string. */
  approved_total_paise: string | number;
}

/** One-decimal display pct of the exact paise discount (0 when subtotal is 0). */
function displayPct(discountPaise: number, subtotal: number): number {
  if (subtotal <= 0) return 0;
  return Math.round((discountPaise * 1000) / subtotal) / 10;
}

/**
 * Return the tx's signed mandate, minting + persisting it on first call. Null
 * when no settlement row exists yet (tx not APPROVED/settled) — the caller then
 * knows the APPROVED terminal body isn't renderable.
 */
export async function buildCartMandate(deps: MandateBuilderDeps, txId: string): Promise<CartMandate | null> {
  const existing = await deps.db.query(`SELECT mandate_json FROM cart_mandates WHERE tx_id=$1`, [txId]);
  if ((existing.rowCount ?? 0) > 0) {
    return (existing.rows[0] as { mandate_json: CartMandate }).mandate_json;
  }

  const txRow = await deps.db.query(
    `SELECT proposal_bytes, approved_total_paise FROM transactions WHERE tx_id=$1`,
    [txId],
  );
  if ((txRow.rowCount ?? 0) === 0) return null;
  const tx = txRow.rows[0] as SettleableRow;
  const lines = tx.proposal_bytes.lines ?? [];
  if (lines.length === 0) return null;

  const gt = await deps.groundTruth();
  // ONE item per SKU. The frozen settlement lines may carry the same SKU twice
  // (mintSettleable's paise-remainder split), and the mandate is the buyer's
  // human-readable statement of the cart — two rows for one bake at RAW list
  // price would read as a duplicate charge. Quantities sum; the RAW list price
  // is per-SKU anyway, so subtotal is unchanged either way.
  const qtyBySku = new Map<string, number>();
  for (const l of lines) qtyBySku.set(l.sku, (qtyBySku.get(l.sku) ?? 0) + l.qty);
  const items: CartMandateItem[] = [...qtyBySku.entries()].map(([sku, qty]) => {
    const item = gt.items.find((g) => g.sku_id === sku);
    if (item === undefined) throw new Error(`MandateBuilder: unresolved sku ${sku}`);
    return {
      sku,
      title: item.name_raw, // RAW merchant name, never enrichment/LLM prose
      qty,
      unit_price_paise: item.list_price_paise, // RAW list price
    } as CartMandateItem;
  });

  const subtotal = items.reduce((s, it) => s + it.unit_price_paise * it.qty, 0);
  // BIGINT ⇒ string from node-pg. Exact parse, never Number(): a value that
  // cannot round-trip would be signed into a mandate the buyer then verifies
  // against a different number (audit 10.3).
  const total = parsePaiseExact(tx.approved_total_paise); // authoritative — exactly what settlement charges
  if (total === null) {
    throw new Error(
      `MandateBuilder: approved_total_paise "${String(tx.approved_total_paise)}" is not an exact paise value for ${txId}`,
    );
  }
  const discountPaise = subtotal - total;
  if (discountPaise < 0) {
    throw new Error(`MandateBuilder: net ${total} exceeds raw subtotal ${subtotal} for ${txId}`);
  }
  const nowMs = deps.nowMs();

  const core = {
    mandate_id: mintMandateId(nowMs),
    tx_id: txId,
    items,
    subtotal_paise: subtotal,
    discount_pct: displayPct(discountPaise, subtotal),
    discount_paise: discountPaise,
    total_paise: total,
    currency: "INR" as const,
    expires_at: new Date(nowMs + (deps.mandateTtlMs ?? DEFAULT_MANDATE_TTL_MS)).toISOString(),
    nonce: randomBytes(16).toString("hex"),
  };
  const cart_hash = sha256Hex(canonicalJson(canonicalCartView(core as unknown as CartMandate)));
  const withHash = { ...core, cart_hash };
  const merchant_sig = hmacSha256B64(
    deps.signingSecret,
    canonicalJson(signablePreimage(withHash as unknown as CartMandate)),
  );
  const mandate = CartMandateSchema.parse({ ...withHash, merchant_sig });

  // Self-check: refuse to ship a mandate our own verifier would reject.
  const verdict = verifyCartMandate(
    mandate,
    deps.signingSecret,
    nodeMandateCrypto(() => new Date(nowMs).toISOString()),
  );
  if (!verdict.ok) throw new Error(`MandateBuilder produced an invalid mandate: ${verdict.reason}`);

  const ins = await deps.db.query(
    `INSERT INTO cart_mandates (tx_id, mandate_id, mandate_json)
     VALUES ($1,$2,$3) ON CONFLICT (tx_id) DO NOTHING`,
    [txId, mandate.mandate_id, JSON.stringify(mandate)],
  );
  if ((ins.rowCount ?? 0) === 0) {
    // Lost the race to a concurrent poll — return the persisted (stable) one.
    const again = await deps.db.query(`SELECT mandate_json FROM cart_mandates WHERE tx_id=$1`, [txId]);
    return (again.rows[0] as { mandate_json: CartMandate }).mandate_json;
  }
  return mandate;
}
