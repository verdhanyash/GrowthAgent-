/**
 * transport-hardening.spec.ts — the transport-layer findings from the red-team
 * audit: 8.2 (X-Agent-Key brute force costs the attacker nothing), 9.3 (no
 * ceiling on concurrent SSE connections), 8.4 (CORS posture by accident).
 *
 * Real stack over loopback, same harness as api.http.spec.ts. Each block gets
 * its OWN app so its buckets and ledgers start empty.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startApi, postProposal, proposalBody, BUYER_KEY, OTHER_KEY, type ApiHarness } from "./harness.js";
import { okTransport, makeProposal } from "../../pipeline/__tests__/harness.js";

const HONEST = okTransport(makeProposal([{ sku: "CAKE-CHOC-500", qty: 1 }]));

let h: ApiHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/**
 * audit 8.2 — the token bucket sits AFTER requireAgent, so a request bearing an
 * unrecognized key was rejected before it ever spent a token: the key space
 * could be ground for free at whatever rate the network allowed. The prefix
 * cannot be limited wholesale either, because the buyer poll shares it and is
 * explicitly never throttled.
 */
describe("failed-authentication budget (audit 8.2)", () => {
  it("locks a source out after N rejected keys, with Retry-After", async () => {
    h = await startApi({ transport: HONEST, authFailureLimit: { maxFailures: 3, refillPerSec: 0.001 } });
    const attempt = (n: number) =>
      postProposal(h!.base, `gak_wrong_key_${String(n).padStart(4, "0")}`, proposalBody(`brute-key-${String(n).padStart(4, "0")}`));

    // The budget's worth of honest-looking 401s.
    for (let i = 0; i < 3; i++) {
      const r = await attempt(i);
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe("UNAUTHORIZED");
    }
    // Then the door shuts — and stops being an oracle for further keys.
    const blocked = await attempt(99);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("RATE_LIMITED_HTTP");
    expect(blocked.json.error.retryable).toBe(true);
    expect(blocked.json.error.details.retry_after_seconds).toBeGreaterThan(0);
  });

  it("SUCCESSFUL traffic is never charged, however much of it there is", async () => {
    h = await startApi({ transport: HONEST, authFailureLimit: { maxFailures: 2, refillPerSec: 0.001 } });
    // Well past the failure budget, all with a valid key.
    for (let i = 0; i < 12; i++) {
      const r = await postProposal(h.base, BUYER_KEY, proposalBody(`ok-key-${String(i).padStart(4, "0")}`));
      expect(r.status).toBe(202);
    }
    // And a poll loop — the path a client hammers every 50ms — stays open.
    const tx = (await postProposal(h.base, BUYER_KEY, proposalBody("ok-poll-key-0001"))).json.tx_id as string;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${h.base}/v1/carts/proposals/${tx}`, { headers: { "X-Agent-Key": BUYER_KEY } });
      expect(res.status).toBe(200);
    }
  });

  it("a lockout does not leak into the valid key's traffic mid-run", async () => {
    h = await startApi({ transport: HONEST, authFailureLimit: { maxFailures: 1, refillPerSec: 0.001 } });
    expect((await postProposal(h.base, "gak_nope_0001", proposalBody("lockout-key-0001"))).status).toBe(401);
    // Same source IP, so the guard fires before auth even runs — the point of the
    // budget is that it costs the SOURCE, and 429 (not 401) is the honest answer.
    expect((await postProposal(h.base, BUYER_KEY, proposalBody("lockout-key-0002"))).status).toBe(429);
  });
});

/**
 * audit 9.3 — every live SSE connection holds a heartbeat timer, a terminal-poll
 * timer and a Postgres round trip per tick; nothing capped how many one client
 * could open, so the 10-connection pool and the event loop starved long before
 * any bandwidth limit bit.
 */
describe("concurrent SSE ceiling (audit 9.3)", () => {
  /** Open a stream and resolve once headers are in (the socket stays open). */
  async function openStream(base: string, txId: string, key: string): Promise<Response> {
    return fetch(`${base}/v1/stream/${txId}`, { headers: { "X-Agent-Key": key } });
  }

  it("refuses past the per-agent ceiling with a JSON 429, not a half-open stream", async () => {
    h = await startApi({ transport: HONEST, maxStreamsPerAgent: 2, heartbeatMs: 60_000, terminalPollMs: 60_000 });
    const tx = (await postProposal(h.base, BUYER_KEY, proposalBody("sse-cap-key-0001"))).json.tx_id as string;

    const a = await openStream(h.base, tx, BUYER_KEY);
    const b = await openStream(h.base, tx, BUYER_KEY);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.headers.get("content-type")).toContain("text/event-stream");

    const third = await openStream(h.base, tx, BUYER_KEY);
    expect(third.status).toBe(429);
    expect(third.headers.get("content-type")).toContain("application/json");
    const body = (await third.json()) as { error: { code: string; details: Record<string, number> } };
    expect(body.error.code).toBe("RATE_LIMITED_HTTP");
    expect(body.error.details.max_per_agent).toBe(2);

    // Closing one frees a slot: the ledger releases on socket close, not on
    // handler return (the handler returns while the socket is still live).
    await a.body?.cancel();
    for (let i = 0; i < 40; i++) {
      const retry = await openStream(h.base, tx, BUYER_KEY);
      if (retry.status === 200) {
        await retry.body?.cancel();
        await b.body?.cancel();
        return;
      }
      await retry.body?.cancel();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("slot was never released after the stream closed");
  });

  it("the GLOBAL ceiling binds even across different agents", async () => {
    h = await startApi({ transport: HONEST, maxStreams: 1, heartbeatMs: 60_000, terminalPollMs: 60_000 });
    const mine = (await postProposal(h.base, BUYER_KEY, proposalBody("sse-global-key-0001"))).json.tx_id as string;
    const theirs = (await postProposal(h.base, OTHER_KEY, proposalBody("sse-global-key-0002"))).json.tx_id as string;

    const first = await openStream(h.base, mine, BUYER_KEY);
    expect(first.status).toBe(200);
    const second = await openStream(h.base, theirs, OTHER_KEY);
    expect(second.status).toBe(429);
    await first.body?.cancel();
    await second.body?.cancel();
  });

  it("ownership is still checked BEFORE the ceiling (no cross-agent oracle)", async () => {
    h = await startApi({ transport: HONEST, maxStreams: 1, heartbeatMs: 60_000, terminalPollMs: 60_000 });
    const mine = (await postProposal(h.base, BUYER_KEY, proposalBody("sse-own-key-0001"))).json.tx_id as string;
    const res = await fetch(`${h.base}/v1/stream/${mine}`, { headers: { "X-Agent-Key": OTHER_KEY } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TX_NOT_FOUND");
  });
});

/**
 * audit 8.4 — CORS was never configured, so the answer was an accident of
 * Express's defaults. Now it is an explicit, default-off allowlist.
 */
describe("CORS posture (audit 8.4)", () => {
  it("sends NO cross-origin headers by default", async () => {
    h = await startApi({ transport: HONEST });
    const res = await fetch(`${h.base}/v1/carts/proposals/tx_0000000000000000000000000A`, {
      headers: { "X-Agent-Key": BUYER_KEY, Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes an ALLOWLISTED origin (never a wildcard) and answers the preflight", async () => {
    h = await startApi({ transport: HONEST, allowedOrigins: ["http://localhost:5173"] });
    const preflight = await fetch(`${h.base}/v1/carts/proposals`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "X-Agent-Key",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Agent-Key");
    expect(preflight.headers.get("vary")).toContain("Origin");
  });

  it("an origin outside the allowlist gets nothing, even with a valid key", async () => {
    h = await startApi({ transport: HONEST, allowedOrigins: ["http://localhost:5173"] });
    const res = await fetch(`${h.base}/v1/carts/proposals/tx_0000000000000000000000000A`, {
      headers: { "X-Agent-Key": BUYER_KEY, Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin"); // no cross-origin cache poisoning
  });
});
