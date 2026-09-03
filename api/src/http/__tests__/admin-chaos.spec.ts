/**
 * admin-chaos.spec.ts — endpoint inventory row 17 (§7.4), full stack.
 *
 * Exercises the chaos flags API (GET, PUT, DELETE /v1/demo/chaos):
 *  - Inspecting armed flags (GET)
 *  - Arming flags with scope and TTL (PUT)
 *  - Disarming flags (DELETE)
 *  - Loopback + X-Admin-Token auth guard
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startApi,
  adminGet,
  adminPut,
  adminDelete,
  type ApiHarness,
} from "./harness.js";
import { okTransport, makeProposal } from "../../pipeline/__tests__/harness.js";

const HONEST = okTransport(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]));

describe("M10 admin/chaos — flags management (§7.4, Row 17)", () => {
  let h: ApiHarness;
  beforeAll(async () => {
    h = await startApi({ transport: HONEST });
  });
  afterAll(async () => {
    await h.close();
  });

  it("GET returns empty array initially", async () => {
    const r = await adminGet(h.base, "/v1/demo/chaos");
    expect(r.status).toBe(200);
    expect(r.json.armed).toEqual([]);
  });

  it("PUT arms a global chaos flag", async () => {
    const r = await adminPut(h.base, "/v1/demo/chaos", {
      flag: "LLM_TIMEOUT",
      ttl_minutes: 10,
    });
    expect(r.status).toBe(200);
    expect(r.json.armed.length).toBe(1);
    expect(r.json.armed[0].flag).toBe("LLM_TIMEOUT");
    expect(r.json.armed[0].tx_ids).toBeNull();
    expect(r.json.armed[0].expires_at).toBeTruthy();

    // Verify GET reflects armed flag
    const g = await adminGet(h.base, "/v1/demo/chaos");
    expect(g.json.armed.length).toBe(1);
    expect(g.json.armed[0].flag).toBe("LLM_TIMEOUT");
  });

  it("PUT arms a scoped chaos flag with tx_ids", async () => {
    const r = await adminPut(h.base, "/v1/demo/chaos", {
      flag: "GATEWAY_ERROR",
      scope: { tx_ids: ["tx_01000000000000000000000001", "tx_01000000000000000000000002"] },
      ttl_minutes: 5,
    });
    expect(r.status).toBe(200);
    expect(r.json.armed.length).toBe(2);

    const gatewayFlag = r.json.armed.find((f: { flag: string }) => f.flag === "GATEWAY_ERROR");
    expect(gatewayFlag).toBeDefined();
    expect(gatewayFlag.tx_ids).toEqual(["tx_01000000000000000000000001", "tx_01000000000000000000000002"]);
  });

  it("DELETE disarms all chaos flags", async () => {
    const r = await adminDelete(h.base, "/v1/demo/chaos");
    expect(r.status).toBe(200);
    expect(r.json.armed).toEqual([]);

    const g = await adminGet(h.base, "/v1/demo/chaos");
    expect(g.json.armed).toEqual([]);
  });

  it("chaos endpoint requires admin token (no X-Admin-Token → 401)", async () => {
    const g = await adminGet(h.base, "/v1/demo/chaos", null);
    expect(g.status).toBe(401);

    const p = await adminPut(h.base, "/v1/demo/chaos", { flag: "LLM_TIMEOUT" }, null);
    expect(p.status).toBe(401);

    const d = await adminDelete(h.base, "/v1/demo/chaos", null);
    expect(d.status).toBe(401);
  });
});
