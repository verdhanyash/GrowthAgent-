/** Approvals inbox: CAS resolution, expiry asymmetry, single-use tokens. */
import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SettleableProposal } from "@growthagent/shared";
import {
  createApproval,
  makeApprovalTokenConsumer,
  newApprovalId,
  resolveApproval,
} from "../approvals.js";
import { closeDb, db } from "./harness.js";
import { truncateAll } from "./harness.js";

const NOW = new Date("2026-08-26T10:00:00.000Z");
const TTL = 60_000;

async function seedTx(txId: string): Promise<string> {
  // approvals.tx_id FKs onto proposal_txs — create the pipeline row first.
  await db.query(
    `INSERT INTO proposal_txs (tx_id, agent_id, agent_key_hash, request_bytes, stage)
     VALUES ($1,'agent_test',$2,'{}'::jsonb,'PROPOSING')
     ON CONFLICT (tx_id) DO NOTHING`,
    [txId, "c".repeat(64)],
  );
  return txId;
}

function frozen(token?: string): SettleableProposal {
  return {
    tx_id: "tx_approval_test",
    proposal_id: "prop_test00000001",
    proposal_sha256: "d".repeat(64),
    lines: [{ sku: "CAKE-CHOC-500", qty: 1, unit_price_paise: 64_900 }],
    total_amount_paise: 64_900,
    currency: "INR",
    gatekeeper: { verdict: "APPROVE", ruleset_version: 3, trace_digest: "e".repeat(64) },
    approval_source: "HUMAN_ESCALATION",
    ...(token !== undefined ? { approval_token: token } : {}),
  };
}

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe("newApprovalId", () => {
  it("mints Crockford-base32 ids (no I/L/O/U) with the apr_ prefix", () => {
    for (let i = 0; i < 50; i++) {
      const id = newApprovalId(NOW.getTime());
      expect(id).toMatch(/^apr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    }
    expect(newApprovalId(NOW.getTime())).not.toBe(newApprovalId(NOW.getTime()));
  });
});

describe("createApproval / resolveApproval", () => {
  it("creates a PENDING row whose token binds id + tx", async () => {
    const txId = await seedTx("tx_approval_create");
    const created = await createApproval(db, {
      tx_id: txId,
      reason: "HIGH_CART_VALUE",
      band_context: { total_paise: 460_000 },
      frozen_proposal: frozen(),
      gate_trace_summary: { input_digest: "f".repeat(64) },
      ttlMs: TTL,
      now: NOW,
    });
    expect(created.approval_id).toMatch(/^apr_/);
    // Token = sha256 over id + tx, so a leak from another transaction is inert.
    const expectedToken = `tok_${createHash("sha256").update(`${created.approval_id}:${txId}`).digest("hex")}`;
    expect(created.approval_token).toBe(expectedToken);
    expect(created.expires_at).toBe(new Date(NOW.getTime() + TTL).toISOString());
    const r = await db.query(`SELECT status, decision FROM approvals WHERE approval_id=$1`, [
      created.approval_id,
    ]);
    expect(r.rows[0]).toMatchObject({ status: "PENDING", decision: null });
  });

  it("resolves exactly once — the second resolver gets already:true", async () => {
    const txId = await seedTx("tx_approval_cas");
    const created = await createApproval(db, {
      tx_id: txId,
      reason: "VELOCITY_SOFT_BAND",
      band_context: {},
      frozen_proposal: frozen(),
      gate_trace_summary: {},
      ttlMs: TTL,
      now: NOW,
    });
    const first = await resolveApproval(db, {
      approval_id: created.approval_id,
      decision: "APPROVED",
      decided_by: "merchant-meera",
      now: NOW,
    });
    expect(first.already).toBe(false);
    if (!first.already) {
      expect(first.row.decision).toBe("APPROVED");
      expect(first.row.tx_id).toBe(txId);
      expect(first.row.frozen_proposal.proposal_id).toBe("prop_test00000001"); // FROZEN bytes
    }
    const second = await resolveApproval(db, {
      approval_id: created.approval_id,
      decision: "REJECTED",
      decided_by: "someone-else",
      now: NOW,
    });
    expect(second.already).toBe(true); // loser of the race, not an error
  });

  it("refuses to APPROVE past expiry but still allows a REJECTION", async () => {
    const txId = await seedTx("tx_approval_expiry");
    const created = await createApproval(db, {
      tx_id: txId,
      reason: "MANUAL_REVIEW_FLAG",
      band_context: {},
      frozen_proposal: frozen(),
      gate_trace_summary: {},
      ttlMs: -1_000, // already stale
      now: NOW,
    });
    await expect(
      resolveApproval(db, {
        approval_id: created.approval_id,
        decision: "APPROVED",
        decided_by: "merchant-meera",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    const rejected = await resolveApproval(db, {
      approval_id: created.approval_id,
      decision: "REJECTED", // an expired offer may be declined, never silently approved
      decided_by: "merchant-meera",
      now: NOW,
    });
    expect(rejected.already).toBe(false);
  });

  it("404s as ApprovalNotFoundError for unknown ids", async () => {
    await expect(
      resolveApproval(db, { approval_id: "apr_MISSING", decision: "APPROVED", decided_by: "x", now: NOW }),
    ).rejects.toThrow(/not found/);
  });
});

describe("makeApprovalTokenConsumer", () => {
  async function approvedWithToken() {
    const txId = await seedTx(`tx_approval_${Math.random().toString(36).slice(2, 8)}`);
    const created = await createApproval(db, {
      tx_id: txId,
      reason: "ESCALATION_BAND_SOFT_EDGE",
      band_context: {},
      frozen_proposal: frozen(),
      gate_trace_summary: {},
      ttlMs: TTL,
      now: NOW,
    });
    await resolveApproval(db, {
      approval_id: created.approval_id,
      decision: "APPROVED",
      decided_by: "merchant-meera",
      now: NOW,
    });
    return created;
  }

  it("consumes an APPROVED token exactly once", async () => {
    const created = await approvedWithToken();
    const consume = makeApprovalTokenConsumer(db);
    await consume(frozen(created.approval_token));
    await expect(consume(frozen(created.approval_token))).rejects.toMatchObject({
      code: "APPROVAL_TOKEN_INVALID",
    });
  });

  it("refuses tokens that are unresolved or absent from the proposal", async () => {
    const txId = await seedTx(`tx_pending_${Math.random().toString(36).slice(2, 8)}`);
    const pending = await createApproval(db, {
      tx_id: txId,
      reason: "HIGH_CART_VALUE",
      band_context: {},
      frozen_proposal: frozen(),
      gate_trace_summary: {},
      ttlMs: TTL,
      now: NOW,
    });
    const consume = makeApprovalTokenConsumer(db);
    // PENDING (not yet resolved) → refuse.
    await expect(consume(frozen(pending.approval_token))).rejects.toMatchObject({
      code: "APPROVAL_TOKEN_INVALID",
    });
    // Escalated proposal carrying NO token at all → refuse.
    await expect(consume(frozen())).rejects.toMatchObject({ code: "APPROVAL_TOKEN_INVALID" });
  });

  it("a REJECTED approval's token can never settle", async () => {
    const txId = await seedTx(`tx_rejected_${Math.random().toString(36).slice(2, 8)}`);
    const created = await createApproval(db, {
      tx_id: txId,
      reason: "HIGH_CART_VALUE",
      band_context: {},
      frozen_proposal: frozen(),
      gate_trace_summary: {},
      ttlMs: TTL,
      now: NOW,
    });
    await resolveApproval(db, {
      approval_id: created.approval_id,
      decision: "REJECTED",
      decided_by: "merchant-meera",
      now: NOW,
    });
    await expect(makeApprovalTokenConsumer(db)(frozen(created.approval_token))).rejects.toMatchObject({
      code: "APPROVAL_TOKEN_INVALID",
    });
  });
});
