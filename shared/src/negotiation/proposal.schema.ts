/**
 * NegotiationProposal — the ONLY wire contract of the LLM stage
 * (negotiation.md §3.3, verbatim). strict-object maps to additionalProperties:false:
 * a cheeky `admin_approved: true` becomes a schema failure instead of a silent pass.
 *
 * Built on `zod/v4`, NOT v3-classic: @anthropic-ai/sdk's `zodOutputFormat`
 * helper imports `zod/v4` and calls `z.toJSONSchema` on what it receives, so a
 * v3 schema would neither typecheck nor run. LLM-facing schemas live here;
 * validation-only schemas elsewhere stay on v3 classic (§18 register).
 */
import { z } from "zod/v4";

export const ProposedItemZ = z.object({
  // NORMALIZATION (ARCHITECTURE.md §18): canonical SKU shape from the
  // gatekeeper fixtures (`CAKE-CHOC-500`), not the sketched `SKU-*` form.
  sku: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, "must be a canonical SKU code"),
  qty: z.number().int().min(1).max(5),
}); // .max(5): proposal bound; gatekeeper may permit more, the proposer stays conservative

export const ClaimKindZ = z.enum([
  "PRICE",
  "STOCK",
  "MARGIN",
  "SALES_STAT",
  "ATTACH_RATE",
  "OCCASION_FIT",
  "PAIRING",
  "CAMPAIGN_PRIORITY",
]);

export const EvidenceIdZ = z.string().regex(/^E\d{3}$/);

export const ClaimZ = z.object({
  statement: z.string().min(3).max(280),
  evidence_ids: z.array(EvidenceIdZ).min(1).max(6),
  kind: ClaimKindZ,
});

export const NegotiationProposalZ = z
  .strictObject({
    proposed_items: z.array(ProposedItemZ).min(1).max(6),
    bundle_discount_pct: z.number().min(0).max(100).multipleOf(0.5),
    claims: z.array(ClaimZ).min(1).max(12),
    customer_pitch: z.string().min(10).max(900),
    upsell_reasoning_summary: z.string().min(10).max(1200),
    used_campaign_priority: z.boolean(),
    campaign_priority_ids: z
      .array(z.string().regex(/^PRI-[A-Z0-9-]{3,32}$/))
      .max(6)
      .default([]),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<string>();
    for (const [i, item] of val.proposed_items.entries()) {
      if (seen.has(item.sku)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate sku ${item.sku}`,
          path: ["proposed_items", i],
        });
      }
      seen.add(item.sku);
    }
  });

export type ProposedItem = z.infer<typeof ProposedItemZ>;
export type Claim = z.infer<typeof ClaimZ>;
export type ClaimKind = z.infer<typeof ClaimKindZ>;
export type NegotiationProposal = z.infer<typeof NegotiationProposalZ>;
