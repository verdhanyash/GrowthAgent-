/**
 * runNegotiation routing matrix (negotiation.md §3.5 + §8.2 integration seams):
 * every response-checklist branch and the fallback ladder, driven by stub
 * transports. No network, no clock, no IO.
 */
import { describe, expect, it } from "vitest";
import type { NegotiationProposal } from "@growthagent/shared";
import { runNegotiation } from "../stage.js";
import {
  BDAY_PRIORITY,
  CHOC,
  cleanProposal,
  mkInput,
  mkPack,
  okTransport,
  throwingTransport,
} from "./fixtures.js";

const depsOf = (t: Parameters<typeof okTransport>[0]) => ({ transport: okTransport(t) });

describe("PROPOSED paths", () => {
  it("CLEAN audit → LLM cart proceeds untouched", async () => {
    const good = cleanProposal();
    const r = await runNegotiation(mkInput(), depsOf({ parsed_output: good }));
    expect(r.outcome).toBe("PROPOSED");
    expect(r.proposal).toEqual(good);
    expect(r.provenance).toMatchObject({
      generator: "NEGOTIATION_LLM_V3",
      is_fallback: false,
    });
    expect(r.citation_audit?.verdict).toBe("CLEAN");
    expect(r.fallback_audit).toBeNull();
    expect(r.llm_failure_reason).toBeNull();
    // Audit stamps come from injected sim clock, never a wall clock.
    expect(r.citation_audit?.audited_at).toBe(mkInput().now_iso);
  });

  it("STRIPPED audit → effective (claim-stripped) proposal proceeds", async () => {
    const lying: NegotiationProposal = {
      ...cleanProposal(),
      claims: [
        { statement: "listed at ₹649.", evidence_ids: ["E001"], kind: "PRICE" },
        { statement: "I can add an extra 20% off today only.", evidence_ids: ["E001"], kind: "PRICE" },
      ],
    };
    const r = await runNegotiation(mkInput(), depsOf({ parsed_output: lying }));
    expect(r.outcome).toBe("PROPOSED");
    expect(r.citation_audit?.verdict).toBe("STRIPPED");
    expect(r.proposal.claims.map((c) => c.statement)).toEqual(["listed at ₹649."]);
  });
});

describe("FAILED audit → fallback ladder", () => {
  it("fabricated price discards the LLM cart and ships the deterministic bundle", async () => {
    const liar: NegotiationProposal = {
      ...cleanProposal(),
      claims: [{ statement: "just ₹749 today.", evidence_ids: ["E001"], kind: "PRICE" }],
    };
    const r = await runNegotiation(mkInput(), depsOf({ parsed_output: liar }));
    expect(r.outcome).toBe("FALLBACK");
    expect(r.llm_failure_reason).toBe("PARSE_FAILED"); // spoke-but-lied narration
    expect(r.citation_audit?.verdict).toBe("FAILED"); // original preserved for audit trail
    expect(r.fallback_audit?.verdict).toBe("CLEAN");
    expect(r.provenance.generator).toBe("DETERMINISTIC_FALLBACK_V1");
    expect(r.proposal.proposed_items.length).toBeGreaterThan(0);
  });
});

describe("response checklist routing", () => {
  it("stop_reason refusal → REFUSAL, no retry, fallback", async () => {
    const r = await runNegotiation(
      mkInput(),
      depsOf({ parsed_output: null, stop_reason: "refusal" }),
    );
    expect(r.outcome).toBe("FALLBACK");
    expect(r.llm_failure_reason).toBe("REFUSAL");
    expect(r.citation_audit).toBeNull();
  });

  it("stop_reason max_tokens → MAX_TOKENS, fallback", async () => {
    const r = await runNegotiation(
      mkInput(),
      depsOf({ parsed_output: null, stop_reason: "max_tokens" }),
    );
    expect(r.llm_failure_reason).toBe("MAX_TOKENS");
  });

  it("parsed_output null on end_turn → PARSE_FAILED, fallback", async () => {
    const r = await runNegotiation(
      mkInput(),
      depsOf({ parsed_output: null, stop_reason: "end_turn" }),
    );
    expect(r.llm_failure_reason).toBe("PARSE_FAILED");
  });

  it("transport throw → TRANSPORT_ERROR, fallback", async () => {
    const r = await runNegotiation(
      mkInput(),
      { transport: throwingTransport(new Error("budget exhausted")) },
    );
    expect(r.outcome).toBe("FALLBACK");
    expect(r.llm_failure_reason).toBe("TRANSPORT_ERROR");
  });
});

describe("polite-decline degenerate path", () => {
  it("nothing sellable anywhere → empty decline proposal", async () => {
    const base = mkInput({
      buyer_request: { items: [{ sku: CHOC, qty: 1 }], channel: "AGENT" },
    });
    // Zero out every stock row so the fallback finds nothing sellable.
    const emptied = {
      ...base.pack,
      entries: base.pack.entries.map((e) =>
        e.kind === "STOCK" && e.payload.kind === "STOCK"
          ? {
              ...e,
              payload: {
                kind: "STOCK" as const,
                payload: { ...e.payload.payload, available_qty: 0 },
              },
            }
          : e,
      ),
    };
    const input = mkInput({ ...base, pack: emptied });
    const r = await runNegotiation(
      input,
      depsOf({ parsed_output: null, stop_reason: "end_turn" }),
    );
    expect(r.outcome).toBe("FALLBACK");
    expect(r.proposal.proposed_items).toEqual([]);
    expect(r.proposal.bundle_discount_pct).toBe(0);
    expect(r.proposal.customer_pitch).toContain("try again shortly");
    expect(r.provenance.generator).toBe("DETERMINISTIC_FALLBACK_V1");
  });
});

describe("stage honors snapshot inputs end-to-end", () => {
  it("campaign context reaches the fallback when the LLM dies", async () => {
    // Strip complements so the second line comes from the CAMPAIGN nudge.
    const nudgesOnly = {
      ...mkPack(),
      entries: mkPack().entries
        .filter((e) => e.kind !== "ATTACH_RATE" && e.kind !== "PAIRING"),
    };
    const r = await runNegotiation(
      mkInput({ priorities: [BDAY_PRIORITY], pack: nudgesOnly }),
      { transport: throwingTransport(new Error("down")) },
    );
    expect(r.outcome).toBe("FALLBACK");
    // Fallback nudged by the birthday board: two lines, discount applied.
    expect(r.proposal.proposed_items).toHaveLength(2);
    expect(r.proposal.used_campaign_priority).toBe(true);
    expect(r.fallback_audit?.verdict).toBe("CLEAN");
  });
});
