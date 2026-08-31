/**
 * admin-agents.spec.ts — endpoint inventory rows 13–14, full stack.
 *
 * Real Postgres over the loopback harness (so the §4.3 IP check passes and only
 * the X-Admin-Token gate is exercised). Covers the list projection (never the
 * hash), the auth matrix on an admin route, revoke → real 401 AGENT_KEY_REVOKED
 * on the buyer surface, idempotent re-revoke, and the unknown-agent 404.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startApi,
  adminGet,
  adminPost,
  postProposal,
  proposalBody,
  BUYER_KEY,
  BUYER_AGENT_ID,
  OTHER_AGENT_ID,
  type ApiHarness,
} from "./harness.js";
import { okTransport, makeProposal } from "../../pipeline/__tests__/harness.js";

const HONEST = okTransport(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]));

describe("M10 admin/agents — list + revoke (§4.3 guard)", () => {
  let h: ApiHarness;
  beforeAll(async () => {
    h = await startApi({ transport: HONEST });
  });
  afterAll(async () => {
    await h.close();
  });

  it("GET /v1/admin/agents lists seeded identities, never the hash", async () => {
    const r = await adminGet(h.base, "/v1/admin/agents");
    expect(r.status).toBe(200);
    const ids = r.json.agents.map((a: any) => a.agent_id).sort();
    expect(ids).toEqual([BUYER_AGENT_ID, OTHER_AGENT_ID].sort());
    const one = r.json.agents[0];
    expect(one.api_key_prefix).toMatch(/^gak_/);
    expect(one).not.toHaveProperty("api_key_hash");
    expect(one.role).toBe("buyer_agent");
    expect(one.revoked_at).toBeNull();
  });

  it("missing X-Admin-Token → 401, wrong token → 401 (no oracle)", async () => {
    const none = await adminGet(h.base, "/v1/admin/agents", null);
    expect(none.status).toBe(401);
    expect(none.json.error.code).toBe("UNAUTHORIZED");
    const wrong = await adminGet(h.base, "/v1/admin/agents", "not-the-token");
    expect(wrong.status).toBe(401);
  });

  it("POST revoke → 200 + revoked metadata, and the buyer key then gets 401 AGENT_KEY_REVOKED", async () => {
    const rev = await adminPost(h.base, `/v1/admin/agents/${BUYER_AGENT_ID}/revoke`, {
      reason: "compromised in demo",
    });
    expect(rev.status).toBe(200);
    expect(rev.json.agent_id).toBe(BUYER_AGENT_ID);
    expect(rev.json.revoked_at).not.toBeNull();
    expect(rev.json.revoked_reason).toBe("compromised in demo");

    // End-to-end proof: the revoked key no longer authenticates on the buyer surface.
    const post = await postProposal(h.base, BUYER_KEY, proposalBody("after-revoke-0001"));
    expect(post.status).toBe(401);
    expect(post.json.error.code).toBe("AGENT_KEY_REVOKED");
  });

  it("re-revoke is idempotent — keeps the original reason/timestamp", async () => {
    const first = await adminGet(h.base, "/v1/admin/agents");
    const before = first.json.agents.find((a: any) => a.agent_id === BUYER_AGENT_ID);
    const again = await adminPost(h.base, `/v1/admin/agents/${BUYER_AGENT_ID}/revoke`, {
      reason: "a different reason that must NOT overwrite",
    });
    expect(again.status).toBe(200);
    expect(again.json.revoked_reason).toBe("compromised in demo");
    expect(again.json.revoked_at).toBe(before.revoked_at);
  });

  it("revoke of an unknown agent → 404 AGENT_NOT_FOUND", async () => {
    const r = await adminPost(h.base, "/v1/admin/agents/nope_does_not_exist/revoke", {});
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("AGENT_NOT_FOUND");
  });
});
