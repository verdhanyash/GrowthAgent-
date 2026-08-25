/**
 * Pure parts of the NIM seam: transport classification, retry-after parsing,
 * fence-stripping JSON extraction. Network behavior is exercised through the
 * per-module port suites' stubbed ports; the fetch call itself only runs live.
 */
import { describe, expect, it } from "vitest";
import {
  NimHttpError,
  NimNetworkError,
  classifyNimTransport,
  nimRetryDelayMs,
  parseJsonObjectContent,
} from "../nim.js";

describe("classifyNimTransport", () => {
  it("retryable: 408/409/429/5xx and network errors", () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504]) {
      expect(classifyNimTransport(new NimHttpError(status, "x"))).toBe("RETRYABLE");
    }
    expect(classifyNimTransport(new NimNetworkError("conn dead"))).toBe("RETRYABLE");
  });

  it("non-retryable: client-error statuses and UNKNOWN shapes fail fast", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyNimTransport(new NimHttpError(status, "x"))).toBe(
        "NON_RETRYABLE",
      );
    }
    expect(classifyNimTransport(new Error("mystery"))).toBe("NON_RETRYABLE");
    expect(classifyNimTransport("not even an error")).toBe("NON_RETRYABLE");
  });
});

describe("nimRetryDelayMs", () => {
  it("honors a numeric retry-after header, capped by the caller", () => {
    const h = new Headers({ "retry-after": "2" });
    const e = new NimHttpError(429, "slow down", h);
    expect(e.retryAfterMs).toBe(2000);
    expect(nimRetryDelayMs(e, 750)).toBe(2000);
  });

  it("falls back when absent or non-numeric", () => {
    expect(nimRetryDelayMs(new NimHttpError(429, "x"), 750)).toBe(750);
    const bad = new NimHttpError(429, "x", new Headers({ "retry-after": "soon" }));
    expect(bad.retryAfterMs).toBeNull();
    expect(nimRetryDelayMs(bad, 750)).toBe(750);
  });
});

describe("parseJsonObjectContent", () => {
  it("parses bare and fenced JSON objects", () => {
    expect(parseJsonObjectContent('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObjectContent('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObjectContent('```\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
  });

  it("throws SyntaxError on malformed content (adapters map to PARSE_FAILED)", () => {
    expect(() => parseJsonObjectContent("nope")).toThrow(SyntaxError);
    expect(() => parseJsonObjectContent('{"a":1')).toThrow(SyntaxError);
  });
});
