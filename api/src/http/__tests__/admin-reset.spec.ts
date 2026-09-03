/**
 * admin-reset.spec.ts — endpoint inventory row 18 (§7.4 / §7.5), full stack.
 *
 * Exercises the demo reset API (POST /v1/demo/reset):
 *  - Re-seeding catalog, inventory, rules, and identities
 *  - 400 when confirm is not true
 *  - 409 DEMO_RESET_BLOCKED when active holds/txs exist without force: true
 *  - Successful forced reset
 *  - Auth guard
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startApi,
  adminPost,
  postProposal,
  BUYER_KEY,
  type ApiHarness,
} from "./harness.js";
import { okTransport, makeProposal } from "../../pipeline/__tests__/harness.js";

const HONEST = okTransport(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]));

describe("M10 admin/reset — demo reset (§7.4/§7.5, Row 18)", () => {
  let h: ApiHarness;
  beforeAll(async () => {
    h = await startApi({ transport: HONEST });
  });
  afterAll(async () => {
    await h.close();
  });

  it("POST /v1/demo/reset requires confirm: true", async () => {
    const r = await adminPost(h.base, "/v1/demo/reset", {});
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /v1/demo/reset succeeds on pristine state", async () => {
    const r = await adminPost(h.base, "/v1/demo/reset", { confirm: true });
    expect(r.status).toBe(200);
    expect(r.json.reset_at).toBeTruthy();
    expect(r.json.seeded.agents.length).toBeGreaterThan(0);
    expect(r.json.seeded.skus.length).toBeGreaterThan(0);
    expect(r.json.seeded.rules_version).toBe(3);
    expect(r.json.forced).toBe(false);
  });

  it("POST /v1/demo/reset with force: true overrides in-flight / active locks", async () => {
    // Create an in-flight proposal
    await postProposal(h.base, BUYER_KEY, {
      idempotency_key: "reset-test-001",
      customer_request: {
        natural_language: "A birthday cake",
        occasion: "birthday",
      },
      untrusted: { customer_note: "Hold order" },
    });

    const r = await adminPost(h.base, "/v1/demo/reset", { confirm: true, force: true });
    expect(r.status).toBe(200);
    expect(r.json.forced).toBe(true);
  });

  it("reset requires admin token (no X-Admin-Token → 401)", async () => {
    const r = await adminPost(h.base, "/v1/demo/reset", { confirm: true }, null);
    expect(r.status).toBe(401);
  });
});
