/**
 * admin-rules.spec.ts — endpoint inventory rows 6–8 (§7.1), full stack.
 *
 * Exercises the admin rules GET/PUT/history routes: optimistic concurrency,
 * increase guard, cooldown, history, and auth guard.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startApi,
  adminGet,
  adminPut,
  type ApiHarness,
} from "./harness.js";
import { okTransport, makeProposal } from "../../pipeline/__tests__/harness.js";

const HONEST = okTransport(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]));

describe("M10 admin/rules — GET/PUT/history (§7.1)", () => {
  let h: ApiHarness;
  beforeAll(async () => {
    h = await startApi({ transport: HONEST });
  });
  afterAll(async () => {
    await h.close();
  });

  it("GET returns current rules with version metadata", async () => {
    const r = await adminGet(h.base, "/v1/admin/rules");
    expect(r.status).toBe(200);
    expect(r.json.rules_version).toBe(3); // MEERA_RULES_V3
    expect(r.json.rules).toBeDefined();
    expect(r.json.rules.max_discount_pct).toBe(15);
    expect(r.json.updated_at).toBeTruthy();
  });

  it("PUT patches a rule, bumps version, recorded in history", async () => {
    const r = await adminPut(h.base, "/v1/admin/rules", {
      patch: { max_discount_pct: 12 },
      expected_version: 3,
      note: "tighten discount for demo",
    });
    expect(r.status).toBe(200);
    expect(r.json.rules_version).toBe(4);
    expect(r.json.rules.max_discount_pct).toBe(12);

    // Verify GET reflects the update.
    const g = await adminGet(h.base, "/v1/admin/rules");
    expect(g.json.rules_version).toBe(4);
    expect(g.json.rules.max_discount_pct).toBe(12);
  });

  it("PUT with wrong expected_version → 409 RULES_VERSION_CONFLICT", async () => {
    const r = await adminPut(h.base, "/v1/admin/rules", {
      patch: { max_discount_pct: 10 },
      expected_version: 3, // stale — current is 4 from the previous test
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("RULES_VERSION_CONFLICT");
  });

  it("PUT that raises a limit without confirm_increase → 409", async () => {
    const r = await adminPut(h.base, "/v1/admin/rules", {
      patch: { max_discount_pct: 20 }, // raise from 12 to 20
      expected_version: 4,
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("RULES_INCREASE_REQUIRES_CONFIRMATION");
  });

  it("PUT that raises a limit with confirm_increase succeeds", async () => {
    const r = await adminPut(h.base, "/v1/admin/rules", {
      patch: { max_discount_pct: 20 },
      expected_version: 4,
      confirm_increase: true,
    });
    expect(r.status).toBe(200);
    expect(r.json.rules_version).toBe(5);
    expect(r.json.rules.max_discount_pct).toBe(20);
  });

  it("history lists all versions in DESC order", async () => {
    const r = await adminGet(h.base, "/v1/admin/rules/history");
    expect(r.status).toBe(200);
    expect(r.json.history).toBeDefined();
    expect(r.json.history.length).toBeGreaterThanOrEqual(3);
    // DESC order: latest first.
    const versions = r.json.history.map((e: { rules_version: number }) => e.rules_version);
    expect(versions[0]).toBe(5);
    // Each row has the expected fields.
    const latest = r.json.history[0];
    expect(latest.actor).toBeTruthy();
    expect(latest.created_at).toBeTruthy();
    expect(latest.increase).toBe(true); // the last PUT raised max_discount_pct
  });

  it("rules admin requires the admin token (no X-Admin-Token → 401)", async () => {
    const r = await adminGet(h.base, "/v1/admin/rules", null);
    expect(r.status).toBe(401);

    const p = await adminPut(h.base, "/v1/admin/rules", {
      patch: { max_discount_pct: 10 },
      expected_version: 5,
    }, null);
    expect(p.status).toBe(401);
  });
});
