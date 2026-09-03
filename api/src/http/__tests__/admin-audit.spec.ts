/**
 * admin-audit.spec.ts — endpoint inventory row 12 (§7.3), full stack.
 *
 * Drives a real pipeline run through the buyer surface, then exercises the
 * admin audit replay route: stage rebuild, chain integrity, empty/unknown tx,
 * and auth guard.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startApi,
  adminGet,
  postProposal,
  pollUntilTerminal,
  proposalBody,
  BUYER_KEY,
  type ApiHarness,
} from "./harness.js";
import { okTransport, makeProposal } from "../../pipeline/__tests__/harness.js";

const HONEST = okTransport(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]));

describe("M10 admin/audit — replay (§7.3)", () => {
  let h: ApiHarness;
  beforeAll(async () => {
    h = await startApi({ transport: HONEST });
  });
  afterAll(async () => {
    await h.close();
  });

  it("replay of a completed tx has chain_valid=true and rebuilt stages", async () => {
    // Run a full pipeline to create audit events.
    const post = await postProposal(h.base, BUYER_KEY, proposalBody("audit-replay-0001"));
    expect(post.status).toBe(202);
    const txId = post.json.tx_id;
    const terminal = await pollUntilTerminal(h.base, BUYER_KEY, txId);
    expect(terminal.status).toBe("TERMINAL");

    // Give the chain a moment to finish any trailing appends.
    await h.chain.drain();

    const r = await adminGet(h.base, `/v1/admin/audit/${txId}/replay`);
    expect(r.status).toBe(200);
    expect(r.json.tx_id).toBe(txId);
    expect(r.json.chain_valid).toBe(true);
    expect(r.json.broken_at_seq).toBeNull();
    expect(r.json.event_count).toBeGreaterThan(0);
    expect(r.json.rebuilt_stages.length).toBeGreaterThan(0);
    expect(r.json.first_event_at).toBeTruthy();
    expect(r.json.last_event_at).toBeTruthy();
  });

  it("replay of a completed tx also works with deep=true", async () => {
    const post = await postProposal(h.base, BUYER_KEY, proposalBody("audit-deep-0001"));
    expect(post.status).toBe(202);
    await pollUntilTerminal(h.base, BUYER_KEY, post.json.tx_id);
    await h.chain.drain();

    const r = await adminGet(h.base, `/v1/admin/audit/${post.json.tx_id}/replay?deep=true`);
    expect(r.status).toBe(200);
    expect(r.json.chain_valid).toBe(true);
  });

  it("replay of an unknown txId returns valid but empty", async () => {
    const r = await adminGet(h.base, "/v1/admin/audit/tx_00000000000000000000000000/replay");
    expect(r.status).toBe(200);
    expect(r.json.chain_valid).toBe(true);
    expect(r.json.event_count).toBe(0);
    expect(r.json.rebuilt_stages).toEqual([]);
    expect(r.json.rebuilt_outcome).toBeNull();
    expect(r.json.first_event_at).toBeNull();
    expect(r.json.last_event_at).toBeNull();
  });

  it("audit replay requires the admin token (no X-Admin-Token → 401)", async () => {
    const r = await adminGet(h.base, "/v1/admin/audit/tx_any/replay", null);
    expect(r.status).toBe(401);
  });
});
