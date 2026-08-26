/**
 * §15.5 — full-stack settlement behavior matrix. Every test runs the REAL
 * composition root (raw-body webhook → buyer routes → error mapper) over real
 * Postgres + Redis, with webhooks arriving as signed loopback HTTP posts —
 * the exact path production takes. Only the network beyond 127.0.0.1 is
 * simulated (MockProvider), and even that dogfoods the real HMAC verifier.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOrderPaidEnvelope,
  buildSignedWebhook,
} from "./provider/webhook.builder.js";
import { dispatchParsed } from "./webhook-handler.js";
import { runSweep, sweepExpiredReservations } from "./sweeper.js";
import { receiptFor } from "./ensure-order.js";
import {
  makeProposal,
  seedStock,
  startSystem,
  truncateAll,
  waitForTxState,
  type ProposalOverrides,
  type TestSystem,
} from "./__tests__/harness.js";

let sys: TestSystem;

beforeEach(async () => {
  sys = await startSystem();
  // startSystem does NOT wipe state (migrations must be idempotent) — the
  // suite owns isolation: tables + the SHARED redis db flush between tests.
  await truncateAll(sys.db);
  await sys.redis.flushdb();
});

afterEach(async () => {
  await sys.close();
});

/* ------------------------------ helpers -------------------------------- */

function postSettle(
  proposal: ReturnType<typeof makeProposal>,
  key = crypto.randomUUID(),
): Promise<Response> {
  return fetch(`${sys.baseUrl()}/v1/tx/settle`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    // SettleRequest carries the key in the BODY too (schema-enforced UUID).
    body: JSON.stringify({ idempotency_key: key, proposal }),
  });
}

async function counters(sku: string): Promise<{ stock_qty: number; reserved: number; sold: number }> {
  const r = await sys.db.query(`SELECT stock_qty, reserved, sold FROM inventory WHERE sku=$1`, [sku]);
  return r.rows[0];
}

async function txState(txId: string): Promise<string | null> {
  const r = await sys.db.query(`SELECT state FROM transactions WHERE tx_id=$1`, [txId]);
  return r.rowCount === 0 ? null : (r.rows[0].state as string);
}

async function pollUntil(
  desc: string,
  fn: () => Promise<boolean> | boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout: ${desc}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** The current webhook secret (loader guarantees [current, …rotation]). */
function ws(): string {
  const s = sys.config.webhookSecrets[0];
  if (!s) throw new Error("no webhook secret configured");
  return s;
}

/** Standard cart: 2 × ₹100 SKU-A = ₹200. */
function cart(over: ProposalOverrides = {}): ReturnType<typeof makeProposal> {
  return makeProposal({
    lines: over.lines ?? [{ sku: "SKU-A", qty: 2, unit_price_paise: 10_000 }],
    ...over,
  });
}

/** Force-expire a live reservation the way time would (§7.4 pass pair). */
async function expireHolds(txId: string): Promise<void> {
  await sys.db.query(`UPDATE stock_reservations SET expires_at = now() - interval '1 ms' WHERE tx_id=$1`, [txId]);
  const expired = await sweepExpiredReservations(sys.db);
  expect(expired).toContain(txId);
}

/* ------------------------------- suite --------------------------------- */

describe("happy path (§12)", () => {
  it("settle 201 → capture letter → PAID → COMPLETED with inventory moved exactly once", async () => {
    await seedStock(sys.db, { "SKU-A": 10 });
    const p = cart();
    const res = await postSettle(p);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      tx_id: string;
      state: string;
      rzp_order_id: string;
      amount_paise: number;
    };
    expect(body.state).toBe("AWAITING_PAYMENT"); // T6 landed — buyer can pay
    expect(body.rzp_order_id).toMatch(/^order_mock_/);
    expect(body.amount_paise).toBe(20_000);
    expect((await counters("SKU-A")).reserved).toBe(2); // hold visible instantly

    await sys.provider.schedulePaymentOutcome(body.tx_id, "captured");
    await waitForTxState(sys.db, body.tx_id, "COMPLETED");

    expect(await counters("SKU-A")).toMatchObject({ stock_qty: 8, reserved: 0, sold: 2 });
    const sales = await sys.db.query(`SELECT count(*)::int n FROM completed_sales`);
    expect(sales.rows[0].n).toBe(1);
    expect(sys.sink.count(body.tx_id, "tx.paid")).toBe(1);

    const read = await fetch(`${sys.baseUrl()}/v1/tx/${body.tx_id}`);
    expect(read.status).toBe(200);
    const view = (await read.json()) as { state: string; pay_id: string | null };
    expect(view.state).toBe("COMPLETED");
    expect(view.pay_id).toMatch(/^pay_/);
  });

  it("GET unknown tx → 404 TX_NOT_FOUND", async () => {
    const r = await fetch(`${sys.baseUrl()}/v1/tx/${"tx_0000000000000000AAAAAAAA"}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ code: "TX_NOT_FOUND" });
  });
});

describe("layer 1 over HTTP (§15.4 layer-3)", () => {
  it("double-submit same key: verbatim replay + header, zero extra side effects", async () => {
    await seedStock(sys.db, { "SKU-A": 5 });
    const p = cart();
    const key = crypto.randomUUID();
    const r1 = await postSettle(p, key);
    expect(r1.status).toBe(201);
    const b1 = await r1.json();

    const r2 = await postSettle(p, key);
    expect(r2.status).toBe(201);
    expect(r2.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await r2.json()).toEqual(b1);

    const rows = await sys.db.query(`SELECT count(*)::int n FROM transactions WHERE tx_id=$1`, [
      (b1 as { tx_id: string }).tx_id,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("concurrent same-key burst: exactly ONE original execution, rest 409-or-replay, one order", async () => {
    await seedStock(sys.db, { "SKU-A": 50 });
    const p = cart();
    const key = crypto.randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () => postSettle(p, key)));

    // Exactly ONE executor = the single 201 that is NOT a replay. Every other
    // response must be a 409 wait-signal or a verbatim replayed 201.
    const replays = responses.filter((r) => r.headers.get("Idempotency-Replayed") === "true");
    const executors = responses.filter(
      (r) => r.status === 201 && r.headers.get("Idempotency-Replayed") !== "true",
    );
    const waits = responses.filter((r) => r.status === 409);
    expect(executors).toHaveLength(1);
    expect(replays.length + waits.length).toBe(responses.length - 1);
    const txs = await sys.db.query(`SELECT count(*)::int n FROM transactions`);
    const orders = await sys.db.query(`SELECT count(*)::int n FROM razorpay_orders`);
    expect(txs.rows[0].n).toBe(1);
    expect(orders.rows[0].n).toBe(1); // effect-exactly-once, whatever the interleaving
  });

  it("concurrent DISTINCT keys on the last unit: [201, 409], loser RELEASED, invariant intact", async () => {
    await seedStock(sys.db, { "SKU-RACE": 1 });
    const pa = cart({ lines: [{ sku: "SKU-RACE", qty: 1, unit_price_paise: 5_000 }] });
    const pb = cart({ lines: [{ sku: "SKU-RACE", qty: 1, unit_price_paise: 5_000 }] });
    const [ra, rb] = await Promise.all([postSettle(pa), postSettle(pb)]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(await loser.json()).toMatchObject({ code: "STOCK_UNAVAILABLE" });
    // The WINNER legitimately holds the last unit (still awaiting payment);
    // the invariant that matters here is that oversell never happened.
    expect(await counters("SKU-RACE")).toMatchObject({ stock_qty: 1, reserved: 1, sold: 0 });
    const loserProposal = ra.status === 409 ? pa : pb;
    expect(await txState(loserProposal.tx_id)).toBe("RELEASED");
  });
});

describe("webhook semantics (§8.3, V8)", () => {
  async function settledAwaiting(stockSku = "SKU-A"): Promise<{ txId: string; orderId: string }> {
    await seedStock(sys.db, { [stockSku]: 10 });
    const p = cart({ lines: [{ sku: stockSku, qty: 2, unit_price_paise: 10_000 }] });
    const res = await postSettle(p);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tx_id: string; rzp_order_id: string };
    return { txId: body.tx_id, orderId: body.rzp_order_id };
  }

  it("duplicate delivery (same signed bytes, same event id): one state change, duplicate audited", async () => {
    const { txId } = await settledAwaiting();
    await sys.provider.schedulePaymentOutcome(txId, "duplicate"); // V8: ×2, same id
    await waitForTxState(sys.db, txId, "COMPLETED");
    // Ingress knows only the event id — the duplicate audit is GLOBAL.
    await pollUntil("duplicate audited", () => sys.sink.countGlobal("webhook.duplicate_ignored") >= 1);

    const events = await sys.db.query(
      `SELECT count(*)::int n, max(status) s FROM processed_webhook_events`,
    );
    expect(events.rows[0]).toMatchObject({ n: 1, s: "PROCESSED" });
    const sales = await sys.db.query(`SELECT count(*)::int n FROM completed_sales`);
    expect(sales.rows[0].n).toBe(1); // committed once despite two deliveries
  });

  it("invalid signature → 400, nothing parsed, nothing stored", async () => {
    const res = await fetch(`${sys.baseUrl()}/webhooks/razorpay`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Razorpay-Signature": "00" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(sys.sink.countGlobal("webhook.signature_invalid")).toBeGreaterThanOrEqual(1);
    const events = await sys.db.query(`SELECT count(*)::int n FROM processed_webhook_events`);
    expect(events.rows[0].n).toBe(0);
  });

  it("signature-valid but STALE letter → 200 ignored_stale, tx untouched, still capturable fresh", async () => {
    const { txId, orderId } = await settledAwaiting();
    const staleSec = Math.floor(Date.now() / 1000) - 100_000; // ≈28 h old (freshness 300 s)
    const envelope = buildOrderPaidEnvelope(
      {
        paymentId: "pay_stale_1",
        rzpOrderId: orderId,
        amountPaise: 20_000,
        createdAtEpochSec: staleSec,
        receipt: receiptFor(txId),
        orderAmountPaidPaise: 20_000,
        orderAmountDuePaise: 0,
        orderAttempts: 1,
      },
      "account_mock",
    );
    const post = buildSignedWebhook(ws(), envelope, "evt_stale_1");
    const res = await fetch(`${sys.baseUrl()}${post.url}`, {
      method: "POST",
      headers: post.headers,
      body: post.rawBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ignored_stale" });
    expect(await txState(txId)).toBe("AWAITING_PAYMENT"); // untouched

    // The stale rejection didn't poison anything: a fresh capture still lands.
    await sys.provider.schedulePaymentOutcome(txId, "captured");
    await waitForTxState(sys.db, txId, "COMPLETED");
  });

  it("loopback vs direct dispatchParsed: identical terminal state for identical bytes", async () => {
    const a = await settledAwaiting("SKU-A");
    const b = await settledAwaiting("SKU-B");

    // A: through the real HTTP front door.
    await sys.provider.schedulePaymentOutcome(a.txId, "captured");

    // B: SAME builder, SAME secret — dispatched straight into the core.
    const envelope = buildOrderPaidEnvelope(
      {
        paymentId: "pay_direct_b",
        rzpOrderId: b.orderId,
        amountPaise: 20_000,
        createdAtEpochSec: Math.floor(Date.now() / 1000),
        receipt: receiptFor(b.txId),
        orderAmountPaidPaise: 20_000,
        orderAmountDuePaise: 0,
        orderAttempts: 1,
      },
      "account_mock",
    );
    const post = buildSignedWebhook(ws(), envelope, "evt_direct_b");
    const parsed = sys.provider.verifyAndParseWebhook(
      post.rawBody,
      post.headers["X-Razorpay-Signature"] ?? null,
      post.headers["x-razorpay-event-id"] ?? null,
    );
    await dispatchParsed(
      { db: sys.db, provider: sys.provider, config: sys.config, clock: sys.clock },
      parsed,
    );

    await waitForTxState(sys.db, a.txId, "COMPLETED");
    await waitForTxState(sys.db, b.txId, "COMPLETED");
    expect(sys.sink.count(a.txId, "tx.paid")).toBe(1);
    expect(sys.sink.count(b.txId, "tx.paid")).toBe(1);
  });
});

describe("failure + reconciliation paths (§10.1, §12)", () => {
  async function settleOk(): Promise<{ txId: string }> {
    await seedStock(sys.db, { "SKU-A": 10 });
    const p = cart();
    const res = await postSettle(p);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tx_id: string };
    return { txId: body.tx_id };
  }

  it("CHAOS_FORCE_GATEWAY_ERROR: 503, holds + intent retained, sweeper recovers on the SAME receipt", async () => {
    await seedStock(sys.db, { "SKU-A": 10 });
    const p = cart();
    sys.provider.chaos.forceGatewayError = true;
    const res = await postSettle(p);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });

    const txId = p.tx_id;
    expect(await txState(txId)).toBe("ORDER_CREATING"); // claimed, mid-flight
    expect((await counters("SKU-A")).reserved).toBe(2); // holds retained (§12)
    const intent = await sys.db.query(
      `SELECT receipt, status FROM razorpay_orders WHERE tx_id=$1`,
      [txId],
    );
    expect(intent.rows[0]).toMatchObject({ status: "INTENT" });
    const receiptBefore = intent.rows[0].receipt as string;

    // Disarm + age the intent past the 120 s retry threshold; the W3/W4 lane
    // retries creation with the SAME deterministic receipt.
    sys.provider.chaos.forceGatewayError = false;
    await sys.db.query(`UPDATE razorpay_orders SET created_at = now() - interval '130 seconds'`);
    await runSweep(sys, new Date());

    expect(await txState(txId)).toBe("AWAITING_PAYMENT");
    const recovered = await sys.db.query(
      `SELECT receipt, status FROM razorpay_orders WHERE tx_id=$1`,
      [txId],
    );
    expect(recovered.rows[0].receipt).toBe(receiptBefore); // same receipt ⇒ at-most-one order
    expect(recovered.rows[0].status).toBe("CREATED");

    await sys.provider.schedulePaymentOutcome(txId, "captured");
    await waitForTxState(sys.db, txId, "COMPLETED");
  });

  it("payment.failed → FAILED + holds released instantly (T8)", async () => {
    const { txId } = await settleOk();
    await sys.provider.schedulePaymentOutcome(txId, "failed");
    await waitForTxState(sys.db, txId, "FAILED");
    expect((await counters("SKU-A")).reserved).toBe(0);
    expect((await counters("SKU-A")).sold).toBe(0);
    expect(sys.sink.count(txId, "tx.failed")).toBe(1);
  });

  it("escalated proposal WITHOUT token → schema 400; WITH token → 501 re-entry refused", async () => {
    await seedStock(sys.db, { "SKU-A": 5 });
    const noToken = cart({ approvalSource: "HUMAN_ESCALATION" });
    const r1 = await postSettle(noToken);
    expect(r1.status).toBe(400);
    expect(await r1.json()).toMatchObject({ code: "INVALID_SETTLE_REQUEST" });

    const withToken = cart({ approvalSource: "HUMAN_ESCALATION", withToken: true });
    const r2 = await postSettle(withToken);
    expect(r2.status).toBe(501);
    expect(await r2.json()).toMatchObject({ code: "ESCALATION_REENTRY_NOT_WIRED" });
    const rows = await sys.db.query(`SELECT count(*)::int n FROM transactions`);
    expect(rows.rows[0].n).toBe(0); // refusal happened before any side effect
  });
});

describe("late-capture grace ladder (§10.3)", () => {
  async function expiredAwaiting(): Promise<string> {
    await seedStock(sys.db, { "SKU-A": 4 });
    const res = await postSettle(cart({ lines: [{ sku: "SKU-A", qty: 2, unit_price_paise: 10_000 }] }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tx_id: string };
    await expireHolds(body.tx_id);
    expect(await txState(body.tx_id)).toBe("EXPIRED");
    expect((await counters("SKU-A")).reserved).toBe(0); // stock back on sale
    return body.tx_id;
  }

  it("T10: capture within grace re-reserves the SAME holds → PAID → COMPLETED", async () => {
    const txId = await expiredAwaiting();
    await sys.provider.schedulePaymentOutcome(txId, "captured");
    // Don't poll for the transient PAID state — completion may outrun the
    // poller; the audit trail is the durable evidence of the T10 move.
    await pollUntil("grace resurrection audited", () => sys.sink.count(txId, "tx.grace_resurrected") === 1);
    await waitForTxState(sys.db, txId, "COMPLETED");
    expect((await counters("SKU-A")).sold).toBe(2);
  });

  it("T11: capture when the stock vanished → MANUAL_REFUND_REQUIRED + inbox item", async () => {
    const txId = await expiredAwaiting();
    await sys.db.query(`UPDATE inventory SET stock_qty = 0`); // rival bought everything
    await sys.provider.schedulePaymentOutcome(txId, "captured");
    await waitForTxState(sys.db, txId, "MANUAL_REFUND_REQUIRED");
    expect(sys.sink.count(txId, "human_review_enqueued")).toBe(1);
    const sales = await sys.db.query(`SELECT count(*)::int n FROM completed_sales`);
    expect(sales.rows[0].n).toBe(0);
  });
});
