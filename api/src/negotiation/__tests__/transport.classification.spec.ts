/**
 * §8.2 transport/retry suite — typed-error classification table and
 * retry-after capping, exercised against REAL SDK error instances (§3.6:
 * never string-match errors).
 */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { isRetryable, retryDelayMs } from "../transport.live.js";

const headersWith = (v?: string): Headers => {
  const h = new Headers();
  if (v !== undefined) h.set("retry-after", v);
  return h;
};

describe("typed-error classification table", () => {
  const cases: [string, () => unknown, boolean][] = [
    ["RateLimitError(429)", () => new Anthropic.RateLimitError(429, { message: "rl" }, "rl", headersWith()), true],
    ["InternalServerError(500)", () => new Anthropic.InternalServerError(500, { message: "ise" }, "ise", headersWith()), true],
    ["InternalServerError(503)", () => new Anthropic.InternalServerError(503, { message: "down" }, "down", headersWith()), true],
    ["APIConnectionError", () => new Anthropic.APIConnectionError({ message: "conn" }), true],
    ["APIConnectionTimeoutError ⊂ connection", () => new Anthropic.APIConnectionTimeoutError(), true],
    ["BadRequestError(400) — incl. any param mistake", () => new Anthropic.BadRequestError(400, { message: "bad" }, "bad", headersWith()), false],
    ["AuthenticationError(401)", () => new Anthropic.AuthenticationError(401, { message: "auth" }, "auth", headersWith()), false],
    ["PermissionDeniedError(403)", () => new Anthropic.PermissionDeniedError(403, { message: "pd" }, "pd", headersWith()), false],
    ["NotFoundError(404)", () => new Anthropic.NotFoundError(404, { message: "nf" }, "nf", headersWith()), false],
    ["UnprocessableEntityError(422)", () => new Anthropic.UnprocessableEntityError(422, { message: "ue" }, "ue", headersWith()), false],
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
    const e = new Anthropic.RateLimitError(429, { message: "x" }, "x", headersWith("5"));
    expect(retryDelayMs(e)).toBe(1500);
  });

  it("small hints pass through in ms", () => {
    const e = new Anthropic.RateLimitError(429, { message: "x" }, "x", headersWith("0.4"));
    expect(retryDelayMs(e)).toBeCloseTo(400, 0);
  });

  it("missing/unparsable hint falls back to the fixed backoff", () => {
    expect(
      retryDelayMs(new Anthropic.RateLimitError(429, { message: "x" }, "x", headersWith())),
    ).toBe(750);
    expect(
      retryDelayMs(new Anthropic.RateLimitError(429, { message: "x" }, "x", headersWith("soon"))),
    ).toBe(750);
  });

  it("non-rate-limit errors use fixed backoff", () => {
    expect(retryDelayMs(new Anthropic.InternalServerError(500, { message: "x" }, "x", headersWith()))).toBe(750);
    expect(retryDelayMs(new Error("other"))).toBe(750);
  });
});
