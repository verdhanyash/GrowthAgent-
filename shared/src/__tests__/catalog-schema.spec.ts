/**
 * Catalog contracts (data-model-audit.md §2.5): the SQL CHECK constraints
 * mirrored as superRefine, and the LLM-facing output bounds on zod/v4.
 */
import { describe, expect, it } from "vitest";
import {
  CATALOG_CONFIG,
  EnrichedSkuSchema,
  EnrichmentOutputZ,
} from "../index.js";

const MERCHANT = "11111111-1111-4111-8111-111111111111";

const ROW = {
  merchant_id: MERCHANT,
  sku: "COOKIE-TIN-AST",
  enrichment_status: "ENRICHED",
  updated_by_model: "claude-opus-5",
  display_name: "Assorted Cookies Tin",
  description: "A tin of cookies.",
  category: "Cookies",
  tags: ["eggless"],
  occasions: ["diwali"],
  pairing_suggestions: ["MITHAI-DIW-250"],
  confidence: 0.72,
  warnings: [],
  error_detail: null,
};

describe("EnrichedSkuSchema — SQL CHECK constraints as superRefine", () => {
  it("parses a well-formed ENRICHED row", () => {
    expect(EnrichedSkuSchema.parse(ROW).enrichment_status).toBe("ENRICHED");
  });

  it("ce_model_required: ENRICHED without model attribution or display_name fails", () => {
    expect(
      EnrichedSkuSchema.safeParse({ ...ROW, updated_by_model: null }).success,
    ).toBe(false);
    expect(
      EnrichedSkuSchema.safeParse({ ...ROW, display_name: null }).success,
    ).toBe(false);
  });

  it("ce_failed_has_reason: FAILED requires error_detail", () => {
    expect(
      EnrichedSkuSchema.safeParse({
        ...ROW,
        enrichment_status: "FAILED",
        updated_by_model: null,
        display_name: null,
        error_detail: null,
      }).success,
    ).toBe(false);
    expect(
      EnrichedSkuSchema.safeParse({
        ...ROW,
        enrichment_status: "FAILED",
        updated_by_model: null,
        display_name: null,
        error_detail: "PARSE_FAILED: parsed_output was null",
      }).success,
    ).toBe(true);
  });

  it("UNENRICHED (the seeded degraded path) needs neither model nor reason", () => {
    const row = {
      ...ROW,
      enrichment_status: "UNENRICHED",
      updated_by_model: null,
      display_name: null,
      description: null,
      category: null,
      tags: [],
      occasions: [],
      pairing_suggestions: [],
      confidence: null,
    };
    expect(EnrichedSkuSchema.safeParse(row).success).toBe(true);
    // …but it may still carry an error_detail.
    expect(
      EnrichedSkuSchema.safeParse({
        ...row,
        error_detail: "RETRYABLE_EXHAUSTED: connection dead",
      }).success,
    ).toBe(true);
  });

  it("strict: unknown keys rejected; caps mirror §2.5 columns", () => {
    expect(EnrichedSkuSchema.safeParse({ ...ROW, list_price_paise: 1 }).success).toBe(
      false,
    );
    expect(
      EnrichedSkuSchema.safeParse({ ...ROW, tags: Array(11).fill("x") }).success,
    ).toBe(false);
    expect(
      EnrichedSkuSchema.safeParse({
        ...ROW,
        occasions: Array(CATALOG_CONFIG.maxOccasions + 1).fill("diwali"),
      }).success,
    ).toBe(false);
  });
});

describe("EnrichmentOutputZ (zod/v4 — LLM-facing)", () => {
  const OUT = {
    display_name: "Butterscotch Pastry",
    description: "Caramel crunch pastry.",
    category: "Pastries",
    tags: ["butterscotch"],
    occasions: ["birthday"],
    pairing_suggestions: [],
    confidence: 0.8,
    warnings: [],
  };

  it("accepts well-formed output", () => {
    expect(EnrichmentOutputZ.parse(OUT).display_name).toContain("Butterscotch");
  });

  it("bounds: empty display/description fail, confidence clamps to [0,1]", () => {
    expect(
      EnrichmentOutputZ.safeParse({ ...OUT, display_name: "" }).success,
    ).toBe(false);
    expect(
      EnrichmentOutputZ.safeParse({ ...OUT, description: "" }).success,
    ).toBe(false);
    expect(EnrichmentOutputZ.safeParse({ ...OUT, confidence: 1.01 }).success).toBe(
      false,
    );
    expect(EnrichmentOutputZ.safeParse({ ...OUT, confidence: -0.01 }).success).toBe(
      false,
    );
  });

  it("strict: unknown top-level keys are failures, not silent drops", () => {
    expect(
      EnrichmentOutputZ.safeParse({ ...OUT, price_note: "₹299 only" }).success,
    ).toBe(false);
    expect(
      EnrichmentOutputZ.safeParse({ ...OUT, extra_tag_slot: 1 }).success,
    ).toBe(false);
  });
});
