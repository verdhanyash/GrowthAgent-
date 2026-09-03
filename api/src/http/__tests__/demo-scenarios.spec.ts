/**
 * demo-scenarios.spec.ts — endpoint inventory rows 15–16 (§7.4), full stack.
 *
 * Exercises launching demo scenarios and polling run verdicts:
 *  - POST /v1/demo/scenarios/:name (202 Accepted)
 *  - GET  /v1/demo/scenarios/runs/:runId (verdict summary)
 *  - 404 for unknown scenario name or unknown runId
 *  - Loopback + X-Admin-Token auth guard
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startApi,
  adminPost,
  adminGet,
  type ApiHarness,
} from "./harness.js";
import { okTransport, makeProposal } from "../../pipeline/__tests__/harness.js";

const HONEST = okTransport(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]));

describe("M10 demo/scenarios — scenario drivers and run verdicts (§7.4, Rows 15–16)", () => {
  let h: ApiHarness;
  beforeAll(async () => {
    h = await startApi({ transport: HONEST });
  });
  afterAll(async () => {
    await h.close();
  });

  it("POST /v1/demo/scenarios/well_behaved launches Beat 1 scenario", async () => {
    const r = await adminPost(h.base, "/v1/demo/scenarios/well_behaved", {});
    expect(r.status).toBe(202);
    expect(r.json.run_id).toMatch(/^run_/);
    expect(r.json.scenario).toBe("well_behaved");
    expect(r.json.tx_ids.length).toBe(1);
    expect(r.json.watch_urls.length).toBe(1);

    const runId = r.json.run_id;

    // Poll verdict until DONE
    let result;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const g = await adminGet(h.base, `/v1/demo/scenarios/runs/${runId}`);
      expect(g.status).toBe(200);
      result = g.json;
      if (result.status === "DONE" || result.status === "ERROR") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(result).toBeDefined();
    expect(result.scenario).toBe("well_behaved");
    expect(result.expected_outcome).toBe("APPROVED");
    expect(result.assertions.length).toBeGreaterThan(0);
  });

  it("POST /v1/demo/scenarios/adversarial_injection launches Beat 2 scenario", async () => {
    const r = await adminPost(h.base, "/v1/demo/scenarios/adversarial_injection", {});
    expect(r.status).toBe(202);
    expect(r.json.scenario).toBe("adversarial_injection");
  });

  it("POST with unknown scenario name returns 404 SCENARIO_NOT_FOUND", async () => {
    const r = await adminPost(h.base, "/v1/demo/scenarios/unknown_scenario_xyz", {});
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("SCENARIO_NOT_FOUND");
  });

  it("GET with unknown runId returns 404 SCENARIO_NOT_FOUND", async () => {
    const r = await adminGet(h.base, "/v1/demo/scenarios/runs/run_nonexistent_00000000000000");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("SCENARIO_NOT_FOUND");
  });

  it("scenarios endpoints require admin token (no X-Admin-Token → 401)", async () => {
    const p = await adminPost(h.base, "/v1/demo/scenarios/well_behaved", {}, null);
    expect(p.status).toBe(401);

    const g = await adminGet(h.base, "/v1/demo/scenarios/runs/run_123", null);
    expect(g.status).toBe(401);
  });
});

/**
 * audit 18.3 — the live run recorded Beat 3 as `Expected ESCALATED | Actual
 * DECLINED` with `escalated_or_approved (FAIL)`, and the assertion set was loose
 * enough to have passed on an APPROVE too. This drives the whole scenario
 * machinery over a band-value cart and demands the verdict the beat claims.
 */
describe("M10 demo/scenarios — Beat 3 escalates for real (audit 18.3)", () => {
  // 2x Diwali Hamper + 1x Truffle Cake at 5% = Rs 4,414.65 net: inside the
  // [Rs 4,250.00, Rs 5,000.00) escalation band. Same cart the deterministic
  // bundler builds from the scenario's items_hint.
  const BAND_CART = okTransport(
    makeProposal([{ sku: "HAMP-DIW-05", qty: 2 }, { sku: "CAKE-CHOC-500", qty: 1 }], 5),
  );

  let h: ApiHarness;
  beforeAll(async () => {
    h = await startApi({ transport: BAND_CART });
  });
  afterAll(async () => {
    await h.close();
  });

  it("reaches DONE with actual_outcome ESCALATED and every assertion passing", async () => {
    const started = await adminPost(h.base, "/v1/demo/scenarios/high_value_escalate", {});
    expect(started.status).toBe(202);
    const runId = started.json.run_id as string;

    let result: Record<string, unknown> | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const g = await adminGet(h.base, `/v1/demo/scenarios/runs/${runId}`);
      expect(g.status).toBe(200);
      result = g.json as Record<string, unknown>;
      if (result.status === "DONE" || result.status === "ERROR") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(result?.status).toBe("DONE");
    expect(result?.expected_outcome).toBe("ESCALATED");
    expect(result?.actual_outcome).toBe("ESCALATED");
    const assertions = result?.assertions as { name: string; pass: boolean; detail: string }[];
    expect(assertions.map((a) => a.name)).toEqual(
      expect.arrayContaining(["reached_terminal_state", "escalated_outcome", "approval_awaiting_human"]),
    );
    expect(assertions.filter((a) => !a.pass)).toEqual([]);
    expect(result?.pass).toBe(true);

    // The beat's whole point: a human now has something to decide on.
    const txId = (result?.tx_ids as string[])[0];
    const inbox = await h.db.query(`SELECT status FROM approvals WHERE tx_id=$1`, [txId]);
    expect((inbox.rows as { status: string }[]).map((r) => r.status)).toEqual(["PENDING"]);
  });
});
