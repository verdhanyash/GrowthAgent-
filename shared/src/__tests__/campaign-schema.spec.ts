/**
 * Campaign domain schemas (campaign.md §6.2) + LLM-facing output bounds
 * (§7.1). Dual-track zod: validation-only v3 classic here, RationalesOutputZ
 * on zod/v4 for the SDK's zodOutputFormat.
 */
import { describe, expect, it } from "vitest";
import {
  MetricSchema,
  OpportunitySchema,
  PriorityEntrySchema,
  PrioritySetSchema,
  RationalesOutputZ,
} from "../index.js";

const METRIC = {
  key: "velocity_ratio",
  label: "Velocity vs category-peer median",
  value: 0.46,
  display: "0.46x",
};

describe("MetricSchema", () => {
  it("admits string-typed context metrics (dow_label/occ_label normalization)", () => {
    expect(
      MetricSchema.parse({
        key: "occ_label",
        label: "Occasion",
        value: "eggless",
        display: "eggless",
      }).value,
    ).toBe("eggless");
    expect(MetricSchema.parse(METRIC).value).toBe(0.46);
  });
});

describe("OpportunitySchema", () => {
  const opp = {
    opportunity_id: "opp_underselling_0123456789",
    type: "UNDERSELLING",
    skus: ["MANGO_PASTRY"],
    metrics: [METRIC, { ...METRIC, key: "stock_units", display: "60 units", value: 60 }],
    weight: 0.44,
    analytics_run_id: "ar_20260824_ab12cd34",
    generated_at_sim: "2026-08-24T18:29:59.000Z",
  };

  it("parses a well-formed opportunity", () => {
    expect(OpportunitySchema.parse(opp).type).toBe("UNDERSELLING");
  });

  it("enforces id shape and >=2 metrics; strict rejects unknown keys", () => {
    expect(
      OpportunitySchema.safeParse({ ...opp, opportunity_id: "OPP_X_ABC" }).success,
    ).toBe(false);
    expect(
      OpportunitySchema.safeParse({ ...opp, metrics: [METRIC] }).success,
    ).toBe(false);
    expect(OpportunitySchema.safeParse(opp).success).toBe(true);
    expect(OpportunitySchema.safeParse({ ...opp, extra: 1 }).success).toBe(false);
  });
});

describe("PriorityEntrySchema / PrioritySetSchema", () => {
  const entry = {
    entry_id: "pe_0123456789",
    opportunity_id: "opp_underselling_0123456789",
    action: "PRIORITIZE_IN_BUNDLES",
    skus: ["MANGO_PASTRY"],
    weight: 0.44,
    rationale_nl: "deterministic template rationale text here",
    rationale_provenance: "TEMPLATE_FALLBACK",
  };
  const set = {
    set_id: "ps_v3_0123abcd",
    priority_set_version: 3,
    analytics_run_id: "ar_20260824_ab12cd34",
    status: "FRESH",
    entries: [entry],
    generated_at_sim: "2026-08-24T18:29:59.000Z",
    ttl_seconds: 21600,
    valid_until_sim: "2026-08-25T00:29:59.000Z",
    llm_invocation: null,
  };

  it("entry: min rationale length + provenance enum", () => {
    expect(PriorityEntrySchema.parse(entry).action).toBe("PRIORITIZE_IN_BUNDLES");
    expect(
      PriorityEntrySchema.safeParse({ ...entry, rationale_nl: "too short" }).success,
    ).toBe(false);
    expect(
      PriorityEntrySchema.safeParse({
        ...entry,
        rationale_provenance: "HALLUCINATED",
      }).success,
    ).toBe(false);
  });

  it("set: id/version/status shapes + nullable llm_invocation", () => {
    expect(PrioritySetSchema.parse(set).status).toBe("FRESH");
    expect(PrioritySetSchema.safeParse({ ...set, set_id: "ps_x_1" }).success).toBe(false);
    expect(
      PrioritySetSchema.safeParse({ ...set, priority_set_version: -1 }).success,
    ).toBe(false);
    expect(
      PrioritySetSchema.safeParse({ ...set, llm_invocation: null }).success,
    ).toBe(true);
  });
});

describe("RationalesOutputZ (zod/v4 — LLM-facing)", () => {
  it("accepts well-formed index-addressed output", () => {
    expect(
      RationalesOutputZ.parse({
        rationales: [{ entry_index: 0, rationale_nl: "x".repeat(40) }],
      }).rationales[0]?.rationale_nl.length,
    ).toBe(40);
  });

  it("bounds: rationale 40..600, nonnegative int indices", () => {
    expect(
      RationalesOutputZ.safeParse({
        rationales: [{ entry_index: 0, rationale_nl: "x".repeat(39) }],
      }).success,
    ).toBe(false);
    expect(
      RationalesOutputZ.safeParse({
        rationales: [{ entry_index: 0, rationale_nl: "x".repeat(601) }],
      }).success,
    ).toBe(false);
    expect(
      RationalesOutputZ.safeParse({
        rationales: [{ entry_index: -1, rationale_nl: "x".repeat(50) }],
      }).success,
    ).toBe(false);
  });

  it("strict: unknown keys are parse failures, not silent drops", () => {
    expect(
      RationalesOutputZ.safeParse({
        rationales: [],
        suggested_discount_pct: 99,
      }).success,
    ).toBe(false);
    expect(
      RationalesOutputZ.safeParse({
        rationales: [{ entry_index: 0, rationale_nl: "x".repeat(40), weight: 5 }],
      }).success,
    ).toBe(false);
  });
});
