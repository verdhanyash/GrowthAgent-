/**
 * Enrichment prompt construction: freeze discipline, byte-stability (U-14
 * analog), replay-key sensitivity, and THE TRUST RULE AT THE SOURCE — no
 * commercial number can enter the payload because CatalogItemInput has no
 * such field.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CATALOG_CONFIG } from "@growthagent/shared";
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_HASH,
  buildRequestBody,
  buildUserPayload,
  requestBodyKey,
} from "../prompts.js";
import { ALL_SKUS, ITEM_MITHAI, ITEM_TIN } from "./catalog-fixtures.js";

const ARGS = { item: ITEM_TIN, allowedSkus: ALL_SKUS };

describe("frozen system prompt", () => {
  it("hash is a stable sha256 hex digest that recomputes", () => {
    expect(SYSTEM_PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(SYSTEM_PROMPT).digest("hex")).toBe(
      SYSTEM_PROMPT_HASH,
    );
  });

  it("states the closed occasion vocabulary and the money prohibition", () => {
    for (const o of CATALOG_CONFIG.closedOccasions) {
      expect(SYSTEM_PROMPT).toContain(o);
    }
    expect(SYSTEM_PROMPT).toContain("NEVER mention prices");
  });

  it("carries no fixture data (freeze discipline)", () => {
    expect(SYSTEM_PROMPT).not.toContain("COOKIE-TIN-AST");
    // Neither the raw typo nor its correction may leak from seed rows.
    expect(SYSTEM_PROMPT).not.toContain("ButterScchop");
    expect(SYSTEM_PROMPT).not.toContain("ButterSc");
    expect(SYSTEM_PROMPT.toLowerCase()).not.toContain("mithai box");
  });
});

describe("buildUserPayload", () => {
  it("byte-equal across invocations (replay-key prerequisite)", () => {
    const a = buildUserPayload(ARGS);
    const b = buildUserPayload({ ...ARGS, allowedSkus: [...ALL_SKUS] });
    expect(a).toBe(b);
  });

  it("transmits marketing text ONLY — commercial fields cannot exist here", () => {
    const payload = buildUserPayload(ARGS);
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "allowed_skus",
      "category_raw",
      "description_raw",
      "name_raw",
      "sku",
      "uom_raw",
    ]);
    // Even a caller who stuffed numbers into raw text fields gets them through
    // as PROSE the system prompt forbids monetizing; the structured fields are
    // exactly the six above.
    expect(payload).not.toContain("cost_paise");
    expect(payload).not.toContain("list_price_paise");
    expect(payload).not.toContain("stock_units");
    expect(payload).not.toContain("expiry_date");
  });

  it("allowed_skus ride sorted regardless of input order", () => {
    const shuffled = buildUserPayload({
      item: ITEM_TIN,
      allowedSkus: [...ALL_SKUS].reverse(),
    });
    expect(shuffled).toBe(buildUserPayload(ARGS));
  });
});

describe("request body + replay key", () => {
  it("body deterministic; key its sha256 over canonical JSON", () => {
    const b1 = buildRequestBody(ARGS, "meta/llama-3.3-70b-instruct");
    const b2 = buildRequestBody(ARGS, "meta/llama-3.3-70b-instruct");
    expect(JSON.stringify(b1)).toBe(JSON.stringify(b2));
    expect(requestBodyKey(b1)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestBodyKey(b1)).toBe(requestBodyKey(b2));
  });

  it("key sensitive to item AND model changes", () => {
    const base = requestBodyKey(buildRequestBody(ARGS, "meta/llama-3.3-70b-instruct"));
    expect(
      requestBodyKey(buildRequestBody({ item: ITEM_MITHAI, allowedSkus: ALL_SKUS }, "meta/llama-3.3-70b-instruct")),
    ).not.toBe(base);
    expect(requestBodyKey(buildRequestBody(ARGS, "meta/llama-3.1-8b-instruct"))).not.toBe(base);
  });
});
