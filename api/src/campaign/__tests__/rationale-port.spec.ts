/**
 * Failure classification (campaign.md §7.3, U-13) against REAL SDK error
 * instances — never string-matching — plus the retry ladder's observable
 * behavior with injected timing (no real sleeps).
 */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { RationalesOutput } from "@growthagent/shared";
import {
  ChaosForcedTimeoutError,
  RationaleParseError,
  classify,
  type RationalePort,
} from "../llm/rationale.port.js";
import { backoffDelay, draftRationales } from "../llm/rationale-runner.js";
import { ALL_OPPS } from "./campaign-fixtures.js";
import { assembleEntries } from "../domain/derive.js";

const headers = new Headers();

describe("U-13 classification table", () => {
  const cases: [string, () => unknown, string][] = [
    ["RateLimitError(429)", () => new Anthropic.RateLimitError(429, { message: "rl" }, "rl", headers), "RETRYABLE_EXHAUSTED"],
    ["InternalServerError(500)", () => new Anthropic.InternalServerError(500, { message: "ise" }, "ise", headers), "RETRYABLE_EXHAUSTED"],
    ["APIConnectionError", () => new Anthropic.APIConnectionError({ message: "conn" }), "RETRYABLE_EXHAUSTED"],
    ["APIConnectionTimeoutError ⊂ connection", () => new Anthropic.APIConnectionTimeoutError(), "RETRYABLE_EXHAUSTED"],
    ["BadRequestError(400) is our bug", () => new Anthropic.BadRequestError(400, { message: "bad" }, "bad", headers), "NON_RETRYABLE"],
    ["AuthenticationError(401)", () => new Anthropic.AuthenticationError(401, { message: "auth" }, "auth", headers), "NON_RETRYABLE"],
    ["base APIError → retryable (subclass order honored)", () => new Anthropic.APIError(418, { message: "teapot" }, "teapot", headers), "RETRYABLE_EXHAUSTED"],
    ["RationaleParseError", () => new RationaleParseError(), "PARSE_FAILED"],
    ["ChaosForcedTimeoutError", () => new ChaosForcedTimeoutError(), "CHAOS_FORCED"],
    ["plain Error defaults to NON_RETRYABLE (defect, not weather)", () => new Error("boom"), "NON_RETRYABLE"],
  ];
  for (const [name, make, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classify(make())).toBe(expected);
    });
  }
});

/* ------------------------------- ladder ---------------------------------- */

const ARGS = (() => {
  const a = assembleEntries([ALL_OPPS[0]!]);
  return { entries: a.entries, metricsByEntry: [ALL_OPPS[0]!.metrics] };
})();

const NO_SLEEP = { sleep: async () => {}, jitter: () => 0 };

function countingPort(behavior: (call: number) => Promise<unknown>): {
  readonly calls: number;
  readonly port: RationalePort;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    port: {
      draft: async () => (await behavior(++calls)) as RationalesOutput,
    },
  };
}

describe("draftRationales ladder", () => {
  it("retryable failure exhausts rationaleAttempts (2) with one backoff between", async () => {
    const sleeps: number[] = [];
    const t = { sleep: async (ms: number) => void sleeps.push(ms), jitter: () => 0 };
    const { port } = countingPort(async () => {
      throw new Anthropic.InternalServerError(500, { message: "down" }, "d", headers);
    });
    const r = await draftRationales(port, ARGS, t);
    expect(r.ok).toBe(false);
    expect(sleeps).toEqual([backoffDelay(0, t)]);
    expect(sleeps[0]).toBe(500); // 500·2^0 + 0 jitter
  });

  it("success on the second attempt wins after one retryable blip", async () => {
    const { port } = countingPort(async (n) => {
      if (n === 1) throw new Anthropic.RateLimitError(429, { message: "rl" }, "r", headers);
      return { rationales: [{ entry_index: 0, rationale_nl: "x".repeat(50) }] };
    });
    const r = await draftRationales(port, ARGS, NO_SLEEP);
    expect(r.ok).toBe(true);
  });

  it("NON_RETRYABLE aborts immediately — exactly one call, no sleep", async () => {
    const sleeps: number[] = [];
    const t = { sleep: async (ms: number) => void sleeps.push(ms), jitter: () => 0 };
    const h = countingPort(async () => {
      throw new Anthropic.BadRequestError(400, { message: "bad request shape" }, "b", headers);
    });
    const r = await draftRationales(h.port, ARGS, t);
    expect(r.ok).toBe(false);
    expect(h.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("CHAOS_FORCED breaks the loop immediately", async () => {
    const h = countingPort(async () => {
      throw new ChaosForcedTimeoutError();
    });
    const r = await draftRationales(h.port, ARGS, NO_SLEEP);
    expect(r.ok).toBe(false);
    expect(h.calls).toBe(1);
  });

  it("PARSE_FAILED gets its one re-request and succeeds", async () => {
    const h = countingPort(async (n) => {
      if (n === 1) throw new RationaleParseError();
      return { rationales: [] };
    });
    const r = await draftRationales(h.port, ARGS, NO_SLEEP);
    expect(r.ok).toBe(true);
    expect(h.calls).toBe(2);
  });
});
