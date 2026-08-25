/**
 * Evidence-ID allocation + pack hashing (negotiation.md §1.4/§8.2):
 * determinism across input order, golden id sequence for the fixture pack,
 * hash sensitivity, and every PACK_INVARIANT_VIOLATION guard.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../canonical.js";
import {
  allocateIds,
  KIND_ORDER,
  PackInvariantViolationError,
  packHash,
  type EvidencePackEntryInput,
} from "../index.js";
import { ENTRY, testPack, VAN } from "./pack-fixture.js";

/* ------------------------------------------------------------- golden ids */

describe("allocateIds — canonical order", () => {
  it("assigns E001…E010 in KIND_ORDER then sku-ascending sequence", () => {
    expect(ENTRY.map((e) => [e.id, e.kind, e.sku])).toEqual([
      ["E001", "PRICE", "CAKE-CHOC-500"],
      ["E002", "PRICE", "CAKE-VAN-500"],
      ["E003", "STOCK", "CAKE-CHOC-500"],
      ["E004", "STOCK", "CAKE-VAN-500"],
      ["E005", "MARGIN", "CAKE-CHOC-500"],
      ["E006", "SALES_STAT", "CAKE-CHOC-500"],
      ["E007", "ATTACH_RATE", null],
      ["E008", "OCCASION_FIT", "CAKE-VAN-500"],
      ["E009", "PAIRING", "CAKE-CHOC-500"],
      ["E010", "CAMPAIGN_PRIORITY", null],
    ]);
  });

  it("is invariant under input shuffling (100 deterministic permutations)", () => {
    const fingerprint = (entries: readonly { id: string }[]) =>
      entries.map((e) => e.id).join(",");
    const golden = fingerprint(ENTRY);
    // LCG shuffle — fixed seed, no Math.random flake.
    let s = 0x2545f491;
    const rnd = (n: number): number => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return Math.abs(s) % n;
    };
    for (let i = 0; i < 100; i++) {
      const shuffled = [...testSourceEntries()];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = rnd(j + 1);
        [shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!];
      }
      expect(fingerprint(allocateIds(shuffled))).toBe(golden);
    }
  });

  it("KIND_ORDER is exported and matches §1.4", () => {
    expect(KIND_ORDER).toEqual([
      "PRICE", "STOCK", "MARGIN", "SALES_STAT",
      "ATTACH_RATE", "OCCASION_FIT", "PAIRING", "CAMPAIGN_PRIORITY",
    ]);
  });
});

/* ------------------------------------------------------------------ hash */

describe("packHash", () => {
  it("binds content AFTER allocation — ids are inside the digest", () => {
    const h = packHash(ENTRY);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(
      createHash("sha256").update(canonicalJson(ENTRY), "utf8").digest("hex"),
    );
  });

  it("changes when any payload byte changes", () => {
    const base = testPack();
    const mutated = structuredClone(base);
    const price = mutated.entries.find((e) => e.id === "E001");
    if (price?.payload.kind !== "PRICE") throw new Error("fixture drift");
    price.payload.payload.list_price_paise += 1;
    expect(packHash(mutated.entries)).not.toBe(base.pack_hash);
  });

  it("container hash equals recomputed hash of its entries", () => {
    expect(testPack().pack_hash).toBe(packHash(ENTRY));
  });
});

/* ------------------------------------------------------------ invariants */

const STAMP = {
  source_table: "t",
  computed_at: "2026-08-25T10:00:00.000Z",
} as const;

/** Minimal raw copies of the fixture entries (id-less) for permutation runs. */
function testSourceEntries(): EvidencePackEntryInput[] {
  return ENTRY.map(({ id: _id, ...rest }) => rest);
}

describe("PACK_INVARIANT_VIOLATION guards", () => {
  const priceRow = (sku: string): EvidencePackEntryInput => ({
    kind: "PRICE",
    sku,
    ...STAMP,
    payload: { kind: "PRICE", payload: { label: "x", category_raw: "C", list_price_paise: 100, cost_paise: 50, currency: "INR" } },
  });
  const stockRow = (sku: string): EvidencePackEntryInput => ({
    kind: "STOCK",
    sku,
    ...STAMP,
    payload: { kind: "STOCK", payload: { qty_on_hand: 1, reserved_qty: 0, available_qty: 1, expires_on: null, days_to_expiry: null } },
  });
  const attachRow = (): EvidencePackEntryInput => ({
    kind: "ATTACH_RATE",
    sku: null,
    ...STAMP,
    payload: { kind: "ATTACH_RATE", payload: { base_sku: "A", attach_sku: "B", attach_rate_pct: 5, co_occurrence_orders: 1, sample_orders: 2 } },
  });
  const campaignRow = (): EvidencePackEntryInput => ({
    kind: "CAMPAIGN_PRIORITY",
    sku: null,
    ...STAMP,
    payload: { kind: "CAMPAIGN_PRIORITY", payload: { priority_id: "PRI-X", action: "PROMOTE_PAIR", target_skus: ["A"], rationale_plain: "r", weight: 1, max_discount_pct_advertised: null } },
  });
  const occasionRow = (i: number): EvidencePackEntryInput => ({
    kind: "OCCASION_FIT",
    sku: `S${String(i).padStart(3, "0")}`,
    ...STAMP,
    payload: { kind: "OCCASION_FIT", payload: { occasions: [], tags: [], confidence: null } },
  });

  it("throws on duplicate PRICE rows for one sku", () => {
    expect(() => allocateIds([priceRow(VAN), priceRow(VAN)])).toThrow(PackInvariantViolationError);
  });

  it("allows same sku across DIFFERENT per-sku kinds", () => {
    expect(() => allocateIds([priceRow(VAN), stockRow(VAN)])).not.toThrow();
  });

  it("throws on duplicate ATTACH_RATE pair", () => {
    expect(() => allocateIds([attachRow(), attachRow()])).toThrow(PackInvariantViolationError);
  });

  it("throws on duplicate CAMPAIGN_PRIORITY id", () => {
    expect(() => allocateIds([campaignRow(), campaignRow()])).toThrow(PackInvariantViolationError);
  });

  it("throws past the 999-entry cap, passes at exactly 999", () => {
    const mk = (n: number): EvidencePackEntryInput[] =>
      Array.from({ length: n }, (_, i) => occasionRow(i));
    expect(allocateIds(mk(999))).toHaveLength(999);
    expect(() => allocateIds(mk(1000))).toThrow(PackInvariantViolationError);
  });
});
