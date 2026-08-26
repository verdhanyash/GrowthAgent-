/**
 * shared/src/api/primitives.ts — single source of truth for the HTTP contract's
 * scalar types (api-contract.md §2.2), imported by api/ and web/.
 *
 * zod-3.25 note: the design doc sketches v4-only idioms (`.datetime({offset:-1})`,
 * `.hex()`, `.base64()`, `z.exclude`). This build pins zod ^3.25, so those are
 * rewritten with v3-compatible primitives (`.datetime({offset:true})`, `.regex()`,
 * manual enum subsets). `.brand()` is v3-native and kept.
 */
import { z } from "zod";

/** Integer paise. ALL money anywhere in the system is this type. ₹1 = 100 paise. */
export const Paise = z
  .number()
  .int() // rejects 199.5 at the boundary — floats can never enter
  .min(0)
  .max(2_000_000_000) // ₹2,00,00,000 safety ceiling; far above any demo cart
  .brand<"Paise">();
export type Paise = z.infer<typeof Paise>;

/** Prefixed ULIDs: Crockford base32 (no I/L/O/U), 26 chars, lexicographically sortable. */
export const TxId = z.string().regex(/^tx_[0-9A-HJKMNP-TV-Z]{26}$/);
export const MandateId = z.string().regex(/^cm_[0-9A-HJKMNP-TV-Z]{26}$/);
export const ApprovalId = z.string().regex(/^apr_[0-9A-HJKMNP-TV-Z]{26}$/);

/**
 * SKU. The doc sketch uses `/^SKU-.../`, but the SEEDED demo catalog ships raw
 * merchant SKUs (`CAKE-CHOC-500`, `BRWN-BOX-9`, `HAMP-DIW-05`). The real catalog
 * wins (same principle as settlement's TxId reuse): an uppercase-anchored token
 * with dashes/dots/underscores, matching every fixture SKU.
 */
export const Sku = z.string().min(1).max(64).regex(/^[A-Z0-9][A-Z0-9._-]*$/);

/** RFC3339 with a `Z` or numeric offset. (v3: `{offset:true}`, not `{offset:-1}`.) */
export const IsoDateTime = z.string().datetime({ offset: true });

/** Monotonic MerchantRules version, starts at 1. */
export const RulesVersion = z.number().int().positive();

/** 64-hex-char lowercase digest (sha256). Replaces the doc's `.hex().length(64)`. */
export const HexSha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Code-point length bound (api-contract.md §2.3, edge case E-02). `.length` on a
 * JS string counts UTF-16 units; astral chars (emoji) count as 2, so a native
 * `.max()` would reject a legal 2000-glyph note. `[...s]` iterates code points.
 */
export const codePoints = (max: number): z.ZodEffects<z.ZodString, string, string> =>
  z.string().refine((s) => [...s].length <= max, { message: `exceeds ${max} code points` });
