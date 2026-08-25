/**
 * Explainer contracts: the non_authoritative literal firewall and the
 * LLM-facing output bounds.
 */
import { describe, expect, it } from "vitest";
import {
  ExplanationNarrativeSchema,
  NarrativeOutputZ,
  TimelineEventSchema,
} from "../index.js";

const NARRATIVE = {
  audience: "DECLINE_EXPLAINER",
  title: "Declined: cap breach",
  body_md: "The discount cap blocker failed; decision is DECLINE_WITH_REASON.",
  non_authoritative: true as const,
  grounded_on_events: [1, 4],
  degraded: false,
};

describe("ExplanationNarrativeSchema", () => {
  it("parses a well-formed narrative", () => {
    expect(ExplanationNarrativeSchema.parse(NARRATIVE).audience).toBe(
      "DECLINE_EXPLAINER",
    );
  });

  it("the type system forbids an authoritative-looking narrative", () => {
    expect(
      ExplanationNarrativeSchema.safeParse({
        ...NARRATIVE,
        non_authoritative: false,
      }).success,
    ).toBe(false);
    // And the field cannot simply be omitted.
    const { non_authoritative: _omitted, ...withoutFlag } = NARRATIVE;
    void _omitted;
    expect(ExplanationNarrativeSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it("rejects unknown audiences, unknown keys, empty body", () => {
    expect(
      ExplanationNarrativeSchema.safeParse({ ...NARRATIVE, audience: "MARKETING" })
        .success,
    ).toBe(false);
    expect(
      ExplanationNarrativeSchema.safeParse({ ...NARRATIVE, authority_note: 1 })
        .success,
    ).toBe(false);
    expect(
      ExplanationNarrativeSchema.safeParse({ ...NARRATIVE, body_md: "" }).success,
    ).toBe(false);
  });
});

describe("TimelineEventSchema / NarrativeOutputZ", () => {
  it("timeline events accept open payloads but typed seqs", () => {
    expect(
      TimelineEventSchema.parse({
        seq: 3,
        type: "citation_audit_result",
        payload: { anything: ["goes", 1] },
      }).seq,
    ).toBe(3);
    expect(
      TimelineEventSchema.safeParse({
        seq: -1,
        type: "gatekeeper_decision",
        payload: {},
      }).success,
    ).toBe(false);
    expect(
      TimelineEventSchema.safeParse({ seq: 1, type: "webhook_received", payload: {} })
        .success,
    ).toBe(false); // not a groundable type
  });

  it("narrative output bounds + strictness (LLM-facing)", () => {
    const out = {
      title: "T",
      body_md: "Body text.",
      grounded_on_events: [0],
    };
    expect(NarrativeOutputZ.parse(out).title).toBe("T");
    expect(
      NarrativeOutputZ.safeParse({ ...out, grounded_on_events: [-2] }).success,
    ).toBe(false);
    expect(
      NarrativeOutputZ.safeParse({ ...out, audience: "AUDIT_TRAIL" }).success,
    ).toBe(false); // audience is NOT the model's to choose
  });
});
