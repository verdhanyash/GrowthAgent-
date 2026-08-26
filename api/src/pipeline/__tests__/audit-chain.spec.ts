/** AuditChain: hash-chained, single-writer, restart-safe audit persistence. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuditChain, hashEntry, type ChainActor } from "../audit-chain.js";
import { closeDb, db, mkAppend, testActor } from "./harness.js";
import { truncateAll } from "./harness.js";

const actor: ChainActor = testActor();

afterAll(async () => {
  await closeDb();
});

let chain: AuditChain;

beforeEach(async () => {
  await truncateAll(db);
  chain = new AuditChain(db);
  await chain.boot();
});

/** The exact body the documented hash formula covers. */
function bodyOf(row: {
  seq: number;
  tx_id: string;
  ts: string;
  actor: ChainActor;
  rules_version: number;
  event: string;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    seq: row.seq,
    tx_id: row.tx_id,
    ts: row.ts,
    actor: row.actor,
    rules_version: row.rules_version,
    event: row.event,
    payload: row.payload,
  };
}

describe("AuditChain", () => {
  it("starts a genesis row with seq 1 and NULL prev_hash", async () => {
    const row = await chain.append(mkAppend("tx_a", "stage_started", actor));
    expect(row.seq).toBe(1);
    expect(row.prev_hash).toBeNull();
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    // Documented formula: sha256("GENESIS\n" + canonicalJson(body))
    expect(row.hash).toBe(hashEntry(null, bodyOf(row)));
  });

  it("links every append to its predecessor", async () => {
    const r1 = await chain.append(mkAppend("tx_a", "e1", actor));
    const r2 = await chain.append(mkAppend("tx_b", "e2", actor));
    const r3 = await chain.append(mkAppend("tx_a", "e3", actor));
    expect([r2.seq, r3.seq]).toEqual([2, 3]); // GLOBAL seq, not per-tx
    expect(r2.prev_hash).toBe(r1.hash);
    expect(r3.prev_hash).toBe(r2.hash);
    expect(chain.headSeq()).toBe(3);
  });

  it("serializes concurrent appends into one contiguous chain (single writer)", async () => {
    const appends: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i++) {
      appends.push(chain.append(mkAppend(i % 2 === 0 ? "tx_x" : "tx_y", `e${i}`, actor)));
    }
    const rows = (await Promise.all(appends)) as Awaited<ReturnType<AuditChain["append"]>>[];
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    const v = await chain.verify();
    expect(v).toEqual({ chain_valid: true, broken_at_seq: null, checked: 25 });
  });

  it("verifies per-tx subsets without losing global linkage", async () => {
    for (let i = 0; i < 6; i++) {
      await chain.append(mkAppend(i % 2 === 0 ? "tx_x" : "tx_y", `e${i}`, actor));
    }
    const vx = await chain.verify("tx_x");
    expect(vx.chain_valid).toBe(true);
    expect(vx.checked).toBe(3); // rows for tx_x only
  });

  it("reports tampering as data, never an exception", async () => {
    await chain.append(mkAppend("tx_a", "e1", actor));
    await chain.append(mkAppend("tx_a", "e2", actor));
    await chain.append(mkAppend("tx_a", "e3", actor));
    // Reach past the chain and rewrite history.
    await db.query(`UPDATE audit_log SET payload='{"forged":true}' WHERE seq=2`);
    const v = await chain.verify("tx_a");
    expect(v.chain_valid).toBe(false);
    expect(v.broken_at_seq).toBe(2);
    expect(v.checked).toBe(1);
  });

  it("a restarted process resumes the SAME chain (boot loads the tail)", async () => {
    const last = await chain.append(mkAppend("tx_a", "before-restart", actor));
    const reborn = new AuditChain(db);
    await reborn.boot();
    expect(reborn.headSeq()).toBe(last.seq);
    const next = await reborn.append(mkAppend("tx_a", "after-restart", actor));
    expect(next.seq).toBe(last.seq + 1);
    expect(next.prev_hash).toBe(last.hash);
    const fresh = new AuditChain(db);
    await fresh.boot();
    expect((await fresh.verify()).chain_valid).toBe(true);
  });

  it("tailFor replays one tx's durable history in seq order (SSE resume source)", async () => {
    for (let i = 0; i < 5; i++) {
      await chain.append(mkAppend(i < 3 ? "tx_replay" : "tx_other", `e${i}`, actor));
    }
    const rows = await chain.tailFor("tx_replay", 0);
    expect(rows.map((r) => r.event)).toEqual(["e0", "e1", "e2"]);
    const afterFirst = await chain.tailFor("tx_replay", rows[0]!.seq);
    expect(afterFirst.map((r) => r.event)).toEqual(["e1", "e2"]);
  });

  it("refuses to append before boot (programmer error, loudly)", async () => {
    const cold = new AuditChain(db);
    await expect(cold.append(mkAppend("tx_a", "e", actor))).rejects.toThrow(/boot/);
  });

  it("round-trips payloads through JSONB so recomputed hashes still match", async () => {
    const payload = { z: 1, a: ["x", 2, null], nested: { k: "v" } };
    const row = await chain.append(mkAppend("tx_a", "payload-check", actor, payload));
    const [persisted] = await chain.tailFor("tx_a", row.seq - 1);
    expect(persisted!.payload).toEqual(payload);
    expect(persisted!.hash).toBe(hashEntry(persisted!.prev_hash, bodyOf(persisted!)));
  });
});
