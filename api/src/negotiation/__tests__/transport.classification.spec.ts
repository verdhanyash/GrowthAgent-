/**
 * §8.2 transport/retry suite — typed-error classification table and
 * retry-after capping, exercised against REAL NIM error instances (§3.6:
 * never string-match errors).
 */
import { describe, expect, it } from "vitest";
import { NimHttpError, NimNetworkError } from "../../llm/nim.js";
import { isRetryable, retryDelayMs } from "../transport.nim.live.js";

const headersWith = (v?: string): Headers => {
  const h = new Headers();
  if (v !== undefined) h.set("retry-after", v);
  return h;
};

describe("typed-error classification table", () => {
  const cases: [string, () => unknown, boolean][] = [
    ["NimHttpError(408) request timeout", () => new NimHttpError(408, "timeout", headersWith()), true],
    ["NimHttpError(409)", () => new NimHttpError(409, "conflict", headersWith()), true],
    ["NimHttpError(429) rate limit", () => new NimHttpError(429, "rl", headersWith()), true],
    ["NimHttpError(500)", () => new NimHttpError(500, "ise", headersWith()), true],
    ["NimHttpError(503)", () => new NimHttpError(503, "down", headersWith()), true],
    ["NimNetworkError — connection refused/reset", () => new NimNetworkError("conn"), true],
    ["NimNetworkError — abort timeout ⊂ network", () => new NimNetworkError("NIM request failed: The operation was aborted"), true],
    ["NimHttpError(400) — incl. any param mistake", () => new NimHttpError(400, "bad", headersWith()), false],
    ["NimHttpError(401)", () => new NimHttpError(401, "auth", headersWith()), false],
    ["NimHttpError(403)", () => new NimHttpError(403, "pd", headersWith()), false],
    ["NimHttpError(404)", () => new NimHttpError(404, "nf", headersWith()), false],
    ["NimHttpError(422)", () => new NimHttpError(422, "ue", headersWith()), false],
    ["plain Error — never retried", () => new Error("boom"), false],
  ];
  for (const [name, make, expected] of cases) {
    it(`${name} → ${expected ? "RETRY" : "fallback"}`, () => {
      expect(isRetryable(make())).toBe(expected);
    });
  }
});

describe("retry-after handling (§3.6)", () => {
  it("server hint is honored but capped at the 1500ms ceiling", () => {
    const e = new NimHttpError(429, "x", headersWith("5"));
    expect(retryDelayMs(e)).toBe(1500);
  });

  it("small hints pass through in ms", () => {
    const e = new NimHttpError(429, "x", headersWith("0.4"));
    expect(retryDelayMs(e)).toBeCloseTo(400, 0);
  });

  it("missing/unparsable hint falls back to the fixed backoff", () => {
    expect(retryDelayMs(new NimHttpError(429, "x", headersWith()))).toBe(750);
    expect(retryDelayMs(new NimHttpError(429, "x", headersWith("soon")))).toBe(750);
  });

  it("non-rate-limit errors use fixed backoff", () => {
    expect(retryDelayMs(new NimHttpError(500, "x"))).toBe(750);
    expect(retryDelayMs(new NimNetworkError("reset"))).toBe(750);
    expect(retryDelayMs(new Error("other"))).toBe(750);
  });
});
