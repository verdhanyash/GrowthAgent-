/**
 * Catalog enrichment fixtures built on data-model-audit.md §10's nine-SKU
 * "Meera's Cakes" dataset (the messy-text rows the agent exists to clean).
 */
import type { EnrichmentOutput } from "@growthagent/shared";
import type { CatalogItemInput } from "../prompts.js";

/** All nine SKUs — the pairing allow-list context. */
export const ALL_SKUS: readonly string[] = [
  "CAKE-TRF-500",
  "CAKE-RVL-500",
  "PSTRY-BSC",
  "CAKE-RVA-750",
  "MITHAI-DIW-250",
  "COOKIE-TIN-AST",
  "ACC-CNDL-12",
  "CAKE-GFA-750",
  "JAR-GAN-200",
];

/** The showcase row: missing description → enrichment must write copy. */
export const ITEM_TIN: CatalogItemInput = {
  sku: "COOKIE-TIN-AST",
  name_raw: "assorted cookies tin",
  description_raw: null,
  uom_raw: "tin",
  category_raw: null,
};

/** Typo'd name row ("ButterScchop"). */
export const ITEM_BSC: CatalogItemInput = {
  sku: "PSTRY-BSC",
  name_raw: "ButterScchop Pastry",
  description_raw: "typo'd blurb",
  uom_raw: "pc",
  category_raw: null,
};

export const ITEM_MITHAI: CatalogItemInput = {
  sku: "MITHAI-DIW-250",
  name_raw: "Diwali dryfruit mithai box 250g",
  description_raw: "seasonal blurb",
  uom_raw: "250g",
  category_raw: null,
};

/** Honest model output for COOKIE-TIN-AST (§10 expectations: gifting/diwali
 *  tags, mithai/candles pairings). */
export const OUT_TIN: EnrichmentOutput = {
  display_name: "Assorted Cookies Tin",
  description:
    "A handpacked tin of assorted eggless cookies — buttery, crunchy and made to gift.",
  category: "Cookies",
  tags: ["eggless", "cookies", "gift", "assorted"],
  occasions: ["diwali", "congrats"],
  pairing_suggestions: ["MITHAI-DIW-250"],
  confidence: 0.72,
  warnings: [],
};

export const OUT_BSC: EnrichmentOutput = {
  display_name: "Butterscotch Pastry",
  description: "Single-serve butterscotch pastry with caramel crunch.",
  category: "Pastries",
  tags: ["butterscotch", "pastry"],
  occasions: ["birthday"],
  pairing_suggestions: ["CAKE-TRF-500"],
  confidence: 0.8,
  warnings: [],
};

/** Deliberately imperfect-but-schema-valid output exercising every
 *  normalization branch at once. */
export const OUT_ROGUE: EnrichmentOutput = {
  display_name: "Assorted Cookies Tin",
  description: "Great value tin of cookies.",
  category: "Cookies",
  tags: ["Eggless", "eggless", "", "crunchy"],
  occasions: ["diwali", "housewarming"], // second not in closed set
  pairing_suggestions: ["mithai-diw-250", "SKU-GHOST"], // case-insensitive hit + ghost
  confidence: 0.4,
  warnings: ["raw name was very short"],
};
