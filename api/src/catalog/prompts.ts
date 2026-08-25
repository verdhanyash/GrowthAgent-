/**
 * Enrichment prompt construction (catalog agent; data-model-audit.md §2.5 +
 * negotiation.md §1.7). Same freeze discipline as the campaign prompts:
 * byte-stable system prompt, sha256 in provenance + replay key, deterministic
 * user payload (U-14).
 *
 * THE TRUST RULE AT THE SOURCE: the user payload transmits MARKETING TEXT
 * ONLY — sku, raw name/description/uom/category and the merchant's SKU list
 * for pairing allow-listing. Commercial numbers (cost, list price, stock,
 * expiry) are not fields of CatalogItemInput at all, so no code path can
 * leak them into the prompt.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@growthagent/shared";

export const SYSTEM_PROMPT = `You are the catalog copywriter for Meera's Cakes, a home bakery.
You receive one raw catalog record with messy merchant-typed text (typos, casing chaos,
marketing noise, missing descriptions). Your ONLY job is to produce clean marketing
data for the storefront.

Rules:
1. display_name: a clean, title-cased product name in natural English. Correct
   obvious typos and casing chaos. Keep the pack size wording that appears in the
   raw name or uom.
2. description: 1-3 warm sentences of selling copy. If the raw description is missing,
   write one from the product name alone.
3. category: a short shelf label like "Cakes", "Pastries", "Cookies", "Gifts & Mithai",
   "Accessories".
4. tags: up to 10 lowercase descriptive keywords (flavor, dietary, texture, audience).
5. occasions: gifting occasions drawn ONLY from this closed set: birthday, anniversary,
   diwali, rakhi, congrats. Use [] if none genuinely apply.
6. pairing_suggestions: SKUs from the provided allowed_skus list that pair naturally
   as companions (a gift box -> greeting card; a cake -> candles). Only SKUs from the
   list, exactly as spelled there.
7. NEVER mention prices, costs, discounts, stock levels, quantities available, or any
   numbers other than pack sizes already present in the raw name. You receive no such
   data and must not invent it.
8. confidence: 0-1, how confident you are in this enrichment.
9. Output only the JSON object the format requires. No markdown, no preamble.`;

export const SYSTEM_PROMPT_HASH = createHash("sha256")
  .update(SYSTEM_PROMPT)
  .digest("hex");

export interface CatalogItemInput {
  readonly sku: string;
  readonly name_raw: string;
  readonly description_raw: string | null;
  readonly uom_raw: string | null;
  readonly category_raw: string | null;
}

/** Deterministic serialization of the volatile user turn (one SKU per call —
 *  llm_calls.purpose is 'enrich_sku', singular by contract). */
export function buildUserPayload(args: {
  readonly item: CatalogItemInput;
  readonly allowedSkus: readonly string[];
}): string {
  return JSON.stringify(
    {
      sku: args.item.sku,
      name_raw: args.item.name_raw,
      description_raw: args.item.description_raw,
      uom_raw: args.item.uom_raw,
      category_raw: args.item.category_raw,
      allowed_skus: [...args.allowedSkus].sort(),
    },
    null,
    2,
  );
}

/** Canonical request body — THE replay/recording key input. */
export function buildRequestBody(args: {
  readonly item: CatalogItemInput;
  readonly allowedSkus: readonly string[];
}, model: string): {
  model: string;
  system_prompt_hash: string;
  max_tokens: number;
  user_payload: string;
} {
  return {
    model,
    system_prompt_hash: SYSTEM_PROMPT_HASH,
    max_tokens: 2048,
    user_payload: buildUserPayload(args),
  };
}

export const requestBodyKey = (body: {
  model: string;
  system_prompt_hash: string;
  max_tokens: number;
  user_payload: string;
}): string => createHash("sha256").update(canonicalJson(body)).digest("hex");
