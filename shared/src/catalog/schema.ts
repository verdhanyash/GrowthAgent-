/**
 * Catalog-enrichment contracts (data-model-audit.md §2.5, negotiation.md
 * §1.7 trust rule).
 *
 * DUAL-TRACK ZOD (§18 register, M2): validation-only schemas on zod v3
 * classic; the LLM-facing EnrichmentOutputZ on zod/v4 strictObject for
 * `zodOutputFormat`.
 *
 * THE TRUST RULE, structurally: neither schema here has a numeric commercial
 * field. There is no price/cost/margin/stock column to write and no payload
 * field for deriveNumericFacts to read (confidence is the sole number, and
 * it is not money). The LLM is never even SHOWN commercial numbers — the
 * prompt builder transmits marketing text only.
 */
import { z } from "zod";
import { z as z4 } from "zod/v4";
import { CATALOG_CONFIG } from "./config.js";

/* ------------------------- enrichment row (v3) --------------------------- */

export const EnrichmentStatus = z.enum([
  "PENDING",
  "ENRICHED",
  "UNENRICHED",
  "FAILED",
]);
export type EnrichmentStatus = z.infer<typeof EnrichmentStatus>;

/**
 * TS-side mirror of the catalog_enriched row. The two SQL CHECK constraints
 * are reproduced as superRefine so a TS write that PG would reject fails at
 * the seam instead of at the database:
 *  • ce_model_required   — ENRICHED ⇒ updated_by_model AND display_name;
 *  • ce_failed_has_reason — FAILED ⇒ error_detail.
 */
export const EnrichedSkuSchema = z
  .object({
    merchant_id: z.string().uuid(),
    sku: z.string(),
    enrichment_status: EnrichmentStatus,
    updated_by_model: z.string().nullable(),
    display_name: z.string().nullable(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    tags: z.array(z.string()).max(CATALOG_CONFIG.maxTags),
    occasions: z.array(z.string()).max(CATALOG_CONFIG.maxOccasions),
    pairing_suggestions: z.array(z.string()).max(CATALOG_CONFIG.maxPairings),
    confidence: z.number().min(0).max(1).nullable(),
    warnings: z.array(z.string()),
    error_detail: z.string().nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (
      row.enrichment_status === "ENRICHED" &&
      (row.updated_by_model === null || row.display_name === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "ce_model_required: ENRICHED requires updated_by_model and display_name",
      });
    }
    if (row.enrichment_status === "FAILED" && row.error_detail === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ce_failed_has_reason: FAILED requires error_detail",
      });
    }
  });
export type EnrichedSku = z.infer<typeof EnrichedSkuSchema>;

/* --------------------- LLM-facing output (zod/v4) ------------------------ */

/**
 * The model's entire output surface for one SKU. Deliberately prose + tags
 * only — every field lands in a TEXT/TEXT[] column of a table with NO
 * commercial columns, so even a fully hallucinated response cannot move
 * money. Unknown occasions / rogue pairings are filtered downstream with
 * warnings rather than rejected: partial-accept beats re-request churn for
 * marketing copy.
 */
export const EnrichmentOutputZ = z4.strictObject({
  display_name: z4.string().min(1).max(120),
  description: z4.string().min(1).max(800),
  category: z4.string().min(1).max(60),
  tags: z4.array(z4.string().min(1).max(40)).max(CATALOG_CONFIG.maxTags),
  occasions: z4.array(z4.string().min(1).max(40)).max(CATALOG_CONFIG.maxOccasions),
  pairing_suggestions: z4
    .array(z4.string().min(1).max(64))
    .max(CATALOG_CONFIG.maxPairings),
  confidence: z4.number().min(0).max(1),
  warnings: z4.array(z4.string().min(1).max(200)).max(CATALOG_CONFIG.maxWarnings),
});
export type EnrichmentOutput = z4.output<typeof EnrichmentOutputZ>;
