/**
 * Failure classification (campaign.md §7.3, U-13) against REAL seam error
 * instances — never string-matching — plus the retry ladder's observable
 * behavior with injected timing (no real sleeps).
 */
import { describe, expect, it } from "vitest";
import type { RationalesOutput } from "@growthagent/shared";
import { NimHttpError, NimNetworkError } from "../../llm/nim.js";
import {
  ChaosForcedTimeoutError,
  RationaleParseError,
  classify,
  type RationalePort,
} from "../llm/rationale.port.js";
import { backoffDelay, draftRationales } from "../llm/rationale-runner.js";
import { ALL_OPPS } from "./campaign-fixtures.js";
import { assembleEntries } from "../domain/derive.js";

describe("U-13 classification table", () => {
  const cases: [string, () => unknown, string][] = [
    ["NimHttpError(429) rate limit", () => new NimHttpError(429, "rl"), "RETRYABLE_EXHAUSTED"],
    ["NimHttpError(500) server error", () => new NimHttpError(500, "ise"), "RETRYABLE_EXHAUSTED"],
    ["NimHttpError(502) gateway ⊂ server family", () => new NimHttpError(502, "bad gateway"), "RETRYABLE_EXHAUSTED"],
    ["NimNetworkError connection", () => new NimNetworkError("conn"), "RETRYABLE_EXHAUSTED"],
    ["timeout abort rides the network class (NimNetworkError)", () => new NimNetworkError("NIM request failed: This operation was aborted"), "RETRYABLE_EXHAUSTED"],
    ["NimHttpError(400) is our bug", () => new NimHttpError(400, "bad"), "NON_RETRYABLE"],
    ["NimHttpError(401) bad key", () => new NimHttpError(401, "auth"), "NON_RETRYABLE"],
    ["NimHttpError(404) unsupported model field", () => new NimHttpError(404, "model not found"), "NON_RETRYABLE"],
    ["NimHttpError(422) unprocessable", () => new NimHttpError(422, "unprocessable"), "NON_RETRYABLE"],
    ["NimHttpError(418) unrecognized status ⇒ defect, not weather", () => new NimHttpError(418, "teapot"), "NON_RETRYABLE"],
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
      throw new NimHttpError(500, "down");
    });
    const r = await draftRationales(port, ARGS, t);
    expect(r.ok).toBe(false);
    expect(sleeps).toEqual([backoffDelay(0, t)]);
    expect(sleeps[0]).toBe(500); // 500·2^0 + 0 jitter
  });

  it("success on the second attempt wins after one retryable blip", async () => {
    const { port } = countingPort(async (n) => {
      if (n === 1) throw new NimHttpError(429, "rl");
      return { rationales: [{ entry_index: 0, rationale_nl: "x".repeat(50) }] };
    });
    const r = await draftRationales(port, ARGS, NO_SLEEP);
    expect(r.ok).toBe(true);
  });

  it("NON_RETRYABLE aborts immediately — exactly one call, no sleep", async () => {
    const sleeps: number[] = [];
    const t = { sleep: async (ms: number) => void sleeps.push(ms), jitter: () => 0 };
    const h = countingPort(async () => {
      throw new NimHttpError(400, "bad request shape");
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
