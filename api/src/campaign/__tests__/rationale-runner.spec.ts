/**
 * §10 failure-mode policy — the keep-previous vs template-fallback
 * reconciliation — plus index-addressed attachment (§7.1, §14: duplicates,
 * missing/out-of-range indices). All pure; ports are stubs.
 */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { RationalesOutput } from "@growthagent/shared";
import { assembleEntries } from "../domain/derive.js";
import {
  applyRationales,
  draftRationalesWithFallback,
  resolveOutcome,
  type PortResult,
} from "../llm/rationale-runner.js";
import { RationaleParseError } from "../llm/rationale.port.js";
import { verifyRationale } from "../verify/rationale-verifier.js";
import {
  ALL_OPPS,
  DRAFT_ARGS,
  HONEST_RATIONALES,
} from "./campaign-fixtures.js";

const assembly = assembleEntries(ALL_OPPS);
const DRAFTS = assembly.entries;
const OPP_BY_ID = new Map(ALL_OPPS.map((o) => [o.opportunity_id, o]));

const ok = (output: RationalesOutput): PortResult => ({
  ok: true,
  output,
  latencyMs: 42,
  fromCache: false,
});

/** Honest output for all four entries. */
const ALL_HONEST: RationalesOutput = {
  rationales: DRAFTS.map((d, i) => {
    const opp = OPP_BY_ID.get(d.opportunity_id)!;
    return { entry_index: i, rationale_nl: HONEST_RATIONALES[opp.type] };
  }),
};

describe("healthy LLM — statuses", () => {
  it("all verified → FRESH with invocation counters", () => {
    const r = resolveOutcome({
      drafts: DRAFTS,
      oppById: OPP_BY_ID,
      portResult: ok(ALL_HONEST),
      previousSetExists: true,
      requestHash: "deadbeef",
    });
    if (r.kind !== "PUBLISH" || r.status !== "FRESH") throw new Error(JSON.stringify(r));
    expect(r.applied.entries_verified).toBe(4);
    expect(r.applied.fallbacks).toEqual([]);
    expect(r.llm_invocation).toMatchObject({
      model: "claude-opus-5",
      request_hash: "deadbeef",
      latency_ms: 42,
      entries_verified: 4,
      entries_template_fallback: 0,
      from_cache: false,
    });
    expect(r.applied.entries.every((e) =>
      e.rationale_provenance === "VERIFIED_LLM",
    )).toBe(true);
    // Verified strings land verbatim on the right entry:
    const timing = r.applied.entries.find((e) => e.skus[0] === "EGGLESS_LOAF");
    expect(timing?.rationale_nl).toBe(HONEST_RATIONALES.TIMING);
  });

  it("some fail verification → PARTIAL_TEMPLATE; offenders templated, honest kept", () => {
    const poisoned: RationalesOutput = {
      rationales: ALL_HONEST.rationales.map((r) =>
        r.entry_index === 1 // EXPIRY entry
          ? {
              entry_index: 1,
              rationale_nl:
                HONEST_RATIONALES.EXPIRY_RISK + " Plus a surprise 50% off!",
            }
          : r,
      ),
    };
    const r = resolveOutcome({
      drafts: DRAFTS,
      oppById: OPP_BY_ID,
      portResult: ok(poisoned),
      previousSetExists: true,
    });
    if (r.kind !== "PUBLISH") throw new Error("expected publish");
    expect(r.status).toBe("PARTIAL_TEMPLATE");
    expect(r.applied.entries_verified).toBe(3);
    const fb = r.applied.fallbacks;
    expect(fb).toHaveLength(1);
    expect(fb[0]?.verdict).toBe("INVENTED_NUMBER");
    expect(fb[0]?.rejected_rationale).toContain("50% off"); // kept verbatim for explainer/demo
    const expiryEntry = r.applied.entries.find((e) => e.action === "CLEAR_NEAR_EXPIRY");
    expect(expiryEntry?.rationale_provenance).toBe("TEMPLATE_FALLBACK");
    expect(verifyRationale(
      OPP_BY_ID.get(expiryEntry!.opportunity_id)!,
      DRAFTS[1]!,
      expiryEntry!.rationale_nl,
    )).toBe("VERIFIED"); // even the fallback is auditable
  });

  it("all rationales fail → PARTIAL_TEMPLATE with every entry templated", () => {
    const garbage: RationalesOutput = {
      rationales: DRAFTS.map((_, i) => ({
        entry_index: i,
        rationale_nl: `Completely invented narrative number ${i + 97}.4 about sales.`,
      })),
    };
    const r = resolveOutcome({
      drafts: DRAFTS,
      oppById: OPP_BY_ID,
      portResult: ok(garbage),
      previousSetExists: true,
    });
    if (r.kind !== "PUBLISH") throw new Error("expected publish");
    expect(r.status).toBe("PARTIAL_TEMPLATE");
    expect(r.applied.entries.every(
      (e) => e.rationale_provenance === "TEMPLATE_FALLBACK",
    )).toBe(true);
    expect(r.applied.fallbacks).toHaveLength(4);
  });
});

describe("port-level failures — keep previous vs seed-time template", () => {
  const failureCases: [string, unknown][] = [
    ["rate-limited", new Anthropic.RateLimitError(429, { message: "rl" }, "rl", new Headers())],
    ["connection dead", new Anthropic.APIConnectionError({ message: "conn" })],
    ["bad request (our bug)", new Anthropic.BadRequestError(400, { message: "b" }, "b", new Headers())],
    ["chaos toggle", new RationaleParseError()],
  ];
  for (const [name, err] of failureCases) {
    it(`previous set exists → KEEP_PREVIOUS (${name})`, () => {
      const r = resolveOutcome({
        drafts: DRAFTS,
        oppById: OPP_BY_ID,
        portResult: { ok: false, error: err },
        previousSetExists: true,
      });
      expect(r.kind).toBe("KEEP_PREVIOUS");
      if (r.kind === "KEEP_PREVIOUS") {
        expect(r.failure.message.length).toBeGreaterThan(0);
        expect(["RETRYABLE_EXHAUSTED", "NON_RETRYABLE", "PARSE_FAILED"]).toContain(
          r.failure.kind,
        );
      }
    });

    it(`no previous set → TEMPLATE_ONLY publishes (${name})`, () => {
      const r = resolveOutcome({
        drafts: DRAFTS,
        oppById: OPP_BY_ID,
        portResult: { ok: false, error: err },
        previousSetExists: false,
      });
      expect(r.kind).toBe("PUBLISH");
      if (r.kind === "PUBLISH") {
        expect(r.status).toBe("TEMPLATE_ONLY");
        expect(r.llm_invocation).toBeNull();
        expect(r.applied.entries).toHaveLength(4);
        expect(r.applied.entries.every(
          (e) => e.rationale_provenance === "TEMPLATE_FALLBACK",
        )).toBe(true);
      }
    });
  }
});

describe("index-addressed attachment (applyRationales)", () => {
  it("missing index → that entry templated with a NO_INDEX event; others untouched", () => {
    const partial: RationalesOutput = {
      rationales: [ALL_HONEST.rationales[1]!, ALL_HONEST.rationales[2]!, ALL_HONEST.rationales[3]!],
    };
    const applied = applyRationales(DRAFTS, OPP_BY_ID, partial);
    expect(applied.entries_verified).toBe(3);
    expect(applied.fallbacks).toEqual([
      {
        entry_id: DRAFTS[0]!.entry_id,
        opportunity_id: DRAFTS[0]!.opportunity_id,
        verdict: "NO_INDEX",
        rejected_rationale: "",
      },
    ]);
    expect(applied.entries[0]?.rationale_provenance).toBe("TEMPLATE_FALLBACK");
    expect(applied.entries[1]?.rationale_provenance).toBe("VERIFIED_LLM");
  });

  it("duplicate indices — first wins; later duplicates get NO_INDEX events", () => {
    const duped: RationalesOutput = {
      rationales: [
        ALL_HONEST.rationales[0]!,
        { ...ALL_HONEST.rationales[0]!, rationale_nl: "Second take for index zero entirely different wording." },
      ],
    };
    const applied = applyRationales([DRAFTS[0]!], OPP_BY_ID, duped);
    const firstOppType = OPP_BY_ID.get(DRAFTS[0]!.opportunity_id)!.type;
    expect(applied.entries[0]?.rationale_nl).toBe(HONEST_RATIONALES[firstOppType]); // FIRST wins
    expect(applied.fallbacks).toHaveLength(1);
    expect(applied.fallbacks[0]).toMatchObject({
      verdict: "NO_INDEX",
      rejected_rationale: "Second take for index zero entirely different wording.",
    });
  });

  it("out-of-range indices are ignored without events or crashes", () => {
    const wild: RationalesOutput = {
      rationales: [...ALL_HONEST.rationales, { entry_index: 42, rationale_nl: "x".repeat(50) }],
    };
    const applied = applyRationales(DRAFTS, OPP_BY_ID, wild);
    expect(applied.entries_verified).toBe(4);
    expect(applied.fallbacks).toHaveLength(0);
  });

  it("null output (port succeeded with nothing?) → everything templated", () => {
    const applied = applyRationales(DRAFTS, OPP_BY_ID, null);
    expect(applied.entries_verified).toBe(0);
    expect(applied.fallbacks).toHaveLength(4);
    expect(applied.entries.every(
      (e) => e.rationale_provenance === "TEMPLATE_FALLBACK",
    )).toBe(true);
  });
});

describe("draftRationalesWithFallback end-to-end (async seam)", () => {
  it("parse-fail then honest success publishes FRESH", async () => {
    let calls = 0;
    const port = {
      draft: async () => {
        calls++;
        if (calls === 1) throw new RationaleParseError();
        return ALL_HONEST;
      },
    };
    const r = await draftRationalesWithFallback(
      port,
      DRAFT_ARGS,
      { previousSetExists: true, opportunities: ALL_OPPS },
      { sleep: async () => {}, jitter: () => 0 },
    );
    expect(r.kind).toBe("PUBLISH");
    if (r.kind === "PUBLISH") expect(r.status).toBe("FRESH");
    expect(calls).toBe(2);
  });

  it("exhausted retries with no prior set → TEMPLATE_ONLY", async () => {
    const port = {
      draft: async () => {
        throw new Anthropic.APIConnectionError({ message: "down" });
      },
    };
    const r = await draftRationalesWithFallback(
      port,
      DRAFT_ARGS,
      { previousSetExists: false, opportunities: ALL_OPPS },
      { sleep: async () => {}, jitter: () => 0 },
    );
    expect(r.kind).toBe("PUBLISH");
    if (r.kind === "PUBLISH") expect(r.status).toBe("TEMPLATE_ONLY");
  });
});
