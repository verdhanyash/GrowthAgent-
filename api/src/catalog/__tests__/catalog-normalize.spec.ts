/**
 * normalizeEnrichment — the deterministic untrusted-output filter. Every
 * branch: closed occasions, pairing allow-list (case-insensitive), tag
 * hygiene, money-token flagging, model-warning pass-through, and the two
 * hard-reject reasons.
 */
import { describe, expect, it } from "vitest";
import { normalizeEnrichment } from "@growthagent/shared";
import {
  ALL_SKUS,
  ITEM_TIN,
  OUT_ROGUE,
  OUT_TIN,
} from "./catalog-fixtures.js";

describe("normalizeEnrichment", () => {
  it("clean honest output passes through with zero warnings", () => {
    const r = normalizeEnrichment(OUT_TIN, { allowedSkus: ALL_SKUS });
    if (!r.ok) throw new Error(`expected ok, got ${r.error_detail}`);
    expect(r.display_name).toBe("Assorted Cookies Tin");
    expect(r.occasions).toEqual(["diwali", "congrats"]);
    expect(r.pairing_suggestions).toEqual(["MITHAI-DIW-250"]);
    expect(r.warnings).toEqual([]);
  });

  it("rogue output degrades partially — every warning fires, nothing crashes", () => {
    const r = normalizeEnrichment(OUT_ROGUE, { allowedSkus: ALL_SKUS });
    if (!r.ok) throw new Error(`expected ok, got ${r.error_detail}`);

    // Occasions: closed-vocab hit kept in canonical lowercase form…
    expect(r.occasions).toEqual(["diwali"]);
    expect(r.warnings).toContain("UNKNOWN_OCCASION:housewarming");

    // Pairings: case-insensitive allow-list match canonicalizes casing; the
    // ghost SKU is dropped and named.
    expect(r.pairing_suggestions).toEqual(["MITHAI-DIW-250"]);
    expect(r.warnings).toContain("PAIRING_NOT_IN_CATALOG:SKU-GHOST");

    // Tags: lowercased + deduped; empty tag skipped.
    expect(r.tags).toEqual(["eggless", "crunchy"]);

    // Model warnings ride through prefixed.
    expect(r.warnings).toContain("MODEL_WARNING:raw name was very short");
  });

  it("money tokens are flagged, not stripped — copy is structurally powerless", () => {
    const r = normalizeEnrichment(
      { ...OUT_ROGUE, description: "Great value tin of cookies for ₹299 only." },
      { allowedSkus: ALL_SKUS },
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.description).toContain("₹299"); // content kept
    expect(r.warnings).toContain("MONEY_TOKEN_IN_COPY");
  });

  it("blank display name is a HARD reject → UNENRICHED path", () => {
    const r = normalizeEnrichment(
      { ...OUT_TIN, display_name: "   " },
      { allowedSkus: ALL_SKUS },
    );
    expect(r).toEqual({ ok: false, error_detail: "EMPTY_DISPLAY_NAME" });
  });

  it("pairings against an empty catalog all drop — never invent companions", () => {
    const r = normalizeEnrichment(OUT_TIN, { allowedSkus: [ITEM_TIN.sku] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.pairing_suggestions).toEqual([]);
    expect(r.warnings).toContain("PAIRING_NOT_IN_CATALOG:MITHAI-DIW-250");
  });
});
