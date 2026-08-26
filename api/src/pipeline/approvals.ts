/**
 * Approvals inbox — the HUMAN_ESCALATION re-entry seam settle() has been
 * refusing with 501 since M6 (settlement.md §11, api-contract.md §7.2).
 *
 * Lifecycle: the orchestrator freezes the COMPLETE SettleableProposal bytes at
 * escalation time; approval resolves the row (CAS, first-writer-wins) and
 * settlement resumes against EXACTLY those bytes — never re-proposed,
 * re-priced, or re-discounted by any AI. The token is single-use
 * (consumed_at); a second settle attempt with the same token 409s.
 *
 * The approval_token NEVER appears in an SSE frame or terminal payload — it
 * exists only between the inbox API and the settlement call.
 */
import { createHash, randomBytes } from "node:crypto";
import type { SettleableProposal } from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { SettlementRejectedError } from "../settlement/errors.js";

/** Crockford base32 ULID-shaped id (no I/L/O/U), 'apr_' prefixed. */
export function newApprovalId(nowMs = Date.now()): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = nowMs;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let tail = "";
  for (let i = 0; i < 16; i++) {
    tail += ALPHABET[rand[i]! % 32];
  }
  return `apr_${time}${tail}`;
}

/** The single-use token binds id + tx, so a token leaked from another tx is
 *  inert. Pure function of (id, tx): the orchestrator bakes it into the frozen
 *  proposal's digest at mint time, and createApproval re-derives the SAME token
 *  from the same id — the two are guaranteed to match. */
export function approvalTokenFor(approvalId: string, txId: string): string {
  return `tok_${createHash("sha256").update(`${approvalId}:${txId}`).digest("hex")}`;
}

/**
 * Mint an approval id + its token BEFORE freezing the proposal. Escalated
 * SettleableProposals must carry their token (schema refinement) AND bind it in
 * proposal_sha256 (digestView includes approval_token), so the token cannot be
 * spliced in at resume without breaking the digest — it has to exist at mint
 * time. This is the seam that lets it.
 */
export function mintApprovalCredentials(
  txId: string,
  nowMs: number,
): { readonly approval_id: string; readonly approval_token: string } {
  const approval_id = newApprovalId(nowMs);
  return { approval_id, approval_token: approvalTokenFor(approval_id, txId) };
}

export interface CreatedApproval {
  readonly approval_id: string;
  readonly approval_token: string;
  readonly expires_at: string;
}

export async function createApproval(
  db: PgPool,
  args: {
    tx_id: string;
    reason: "HIGH_CART_VALUE" | "ESCALATION_BAND_SOFT_EDGE" | "VELOCITY_SOFT_BAND" | "MANUAL_REVIEW_FLAG";
    band_context: Readonly<Record<string, unknown>>;
    frozen_proposal: SettleableProposal;
    gate_trace_summary: Readonly<Record<string, unknown>>;
    ttlMs: number;
    now: Date;
    /** Pre-minted id (from mintApprovalCredentials) when the token was already
     *  baked into frozen_proposal; absent ⇒ mint a fresh one here. */
    approval_id?: string;
  },
): Promise<CreatedApproval> {
  const approvalId = args.approval_id ?? newApprovalId(args.now.getTime());
  // Re-derive from the same pure fn used at mint time; matches the baked token.
  const token = approvalTokenFor(approvalId, args.tx_id);
  const expiresAt = new Date(args.now.getTime() + args.ttlMs);
  await db.query(
    `INSERT INTO approvals
       (approval_id, tx_id, reason, band_context, frozen_proposal,
        gate_trace_summary, approval_token, status, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9)`,
    [
      approvalId,
      args.tx_id,
      args.reason,
      JSON.stringify(args.band_context),
      JSON.stringify(args.frozen_proposal),
      JSON.stringify(args.gate_trace_summary),
      token,
      args.now,
      expiresAt,
    ],
  );
  return { approval_id: approvalId, approval_token: token, expires_at: expiresAt.toISOString() };
}

export interface ResolvedApproval {
  readonly approval_id: string;
  readonly decision: "APPROVED" | "REJECTED";
  readonly tx_id: string;
  /** The frozen proposal — resume settlement with EXACTLY these bytes. */
  readonly frozen_proposal: SettleableProposal;
}

/**
 * CAS resolution: exactly one of approve/reject wins; the loser gets
 * `already:true` and maps to 409 APPROVAL_ALREADY_RESOLVED at the HTTP layer.
 * Expired PENDING rows are rejected for approval but still resolvable as
 * REJECTED (an expired offer may be declined, never silently approved).
 */
export async function resolveApproval(
  db: PgPool,
  args: {
    approval_id: string;
    decision: "APPROVED" | "REJECTED";
    decided_by: string;
    note?: string | undefined;
    now: Date;
  },
): Promise<{ already: true } | { already: false; row: ResolvedApproval }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const sel = await client.query(
      `SELECT status, decision, tx_id, expires_at FROM approvals
        WHERE approval_id = $1 FOR UPDATE`,
      [args.approval_id],
    );
    if ((sel.rowCount ?? 0) === 0) throw new ApprovalNotFoundError(args.approval_id);
    const cur = sel.rows[0] as { status: string; decision: string | null; tx_id: string; expires_at: string };
    if (cur.status === "RESOLVED") {
      await client.query("COMMIT");
      return { already: true };
    }
    if (args.decision === "APPROVED" && new Date(cur.expires_at).getTime() <= args.now.getTime()) {
      await client.query("ROLLBACK");
      throw new SettlementRejectedError(
        "APPROVAL_EXPIRED",
        `approval ${args.approval_id} expired at ${cur.expires_at}`,
        409,
      );
    }
    const upd = await client.query(
      `UPDATE approvals
          SET status='RESOLVED', decision=$2, decided_by=$3, note=$4, resolved_at=$5
        WHERE approval_id=$1 AND status='PENDING'`,
      [args.approval_id, args.decision, args.decided_by, args.note ?? null, args.now],
    );
    if ((upd.rowCount ?? 0) === 0) {
      await client.query("COMMIT");
      return { already: true };
    }
    const fp = await client.query(`SELECT frozen_proposal FROM approvals WHERE approval_id=$1`, [
      args.approval_id,
    ]);
    await client.query("COMMIT");
    return {
      already: false,
      row: {
        approval_id: args.approval_id,
        decision: args.decision,
        tx_id: cur.tx_id,
        frozen_proposal: (fp.rows[0] as { frozen_proposal: SettleableProposal }).frozen_proposal,
      },
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export class ApprovalNotFoundError extends Error {
  constructor(id: string) {
    super(`approval not found: ${id}`);
    this.name = "ApprovalNotFoundError";
  }
}

/**
 * The single-use consumer handed to settle()'s SettleDeps. Approvals are
 * consumed AFTER resolution (status RESOLVED + APPROVED) and only once:
 * consumed_at flips under a conditional UPDATE whose rowCount decides.
 */
export function makeApprovalTokenConsumer(db: PgPool) {
  return async (p: SettleableProposal): Promise<void> => {
    if (p.approval_token === undefined) {
      throw new SettlementRejectedError(
        "APPROVAL_TOKEN_INVALID",
        "escalated proposal carries no approval token",
        409,
      );
    }
    const r = await db.query(
      `UPDATE approvals SET consumed_at = now()
        WHERE approval_token = $1 AND status='RESOLVED' AND decision='APPROVED'
          AND consumed_at IS NULL`,
      [p.approval_token],
    );
    if ((r.rowCount ?? 0) === 0) {
      throw new SettlementRejectedError(
        "APPROVAL_TOKEN_INVALID",
        "approval token missing, unresolved, or already consumed",
        409,
      );
    }
  };
}
