import { describe, expect, it } from "vitest";
import { greeting, buildProvider } from "./server.js";
import { loadSettlementConfig } from "./settlement/config.js";
import { SystemClock } from "./settlement/clock.js";

describe("M0 toolchain smoke", () => {
  it("composes the shared package through workspace resolution", () => {
    expect(greeting()).toContain("growthagent api");
  });
});

/**
 * audit S4 — the composition root used to construct `new MockProvider(...)`
 * unconditionally, so `RAZORPAY_PROVIDER=TEST_MODE` with valid keys still ran the
 * local double and `RazorpayProvider` was dead code: the system could not make a
 * real Razorpay call at all. Provider selection now follows the config, which
 * `loadSettlementConfig` has already validated.
 */
describe("buildProvider — the armed adapter follows RAZORPAY_PROVIDER (audit S4)", () => {
  const clock = new SystemClock();

  it("MOCK (and unset, outside production) arms the local double", () => {
    expect(buildProvider(loadSettlementConfig({ RAZORPAY_PROVIDER: "MOCK" }), clock).kind).toBe("mock");
    expect(buildProvider(loadSettlementConfig({}), clock).kind).toBe("mock");
  });

  it("TEST_MODE with pattern-valid keys arms the REAL Razorpay adapter", () => {
    const config = loadSettlementConfig({
      RAZORPAY_PROVIDER: "TEST_MODE",
      RAZORPAY_KEY_ID: "rzp_test_A1b2C3d4E5f6G7",
      RAZORPAY_KEY_SECRET: "s3cret-test-key-secret",
      RAZORPAY_WEBHOOK_SECRET: "whsec_test_value",
    });
    expect(config.provider).toBe("razorpay");
    const provider = buildProvider(config, clock);
    expect(provider.kind).toBe("razorpay");
    // The seam is honoured either way: both adapters expose the same two verbs.
    expect(typeof provider.createOrder).toBe("function");
    expect(typeof provider.verifyAndParseWebhook).toBe("function");
  });

  it("config.provider and the built adapter's kind never disagree", () => {
    for (const env of [
      { RAZORPAY_PROVIDER: "MOCK" },
      {
        RAZORPAY_PROVIDER: "TEST_MODE",
        RAZORPAY_KEY_ID: "rzp_test_A1b2C3d4E5f6G7",
        RAZORPAY_KEY_SECRET: "s3cret-test-key-secret",
        RAZORPAY_WEBHOOK_SECRET: "whsec_test_value",
      },
    ]) {
      const config = loadSettlementConfig(env);
      expect(buildProvider(config, clock).kind).toBe(config.provider);
    }
  });

  it("a TEST_MODE config missing its keys never reaches buildProvider at all", () => {
    // Fail-closed happens in the loader, so buildProvider's non-null assertions
    // on keyId/keySecret cannot be reached with nulls.
    expect(() => loadSettlementConfig({ RAZORPAY_PROVIDER: "TEST_MODE" })).toThrow(/TEST_MODE requires/);
  });
});
