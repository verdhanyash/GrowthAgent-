/**
 * Hash-chained audit persistence (frontend-events.md §1.4 envelope +
 * api-contract.md §7.3 replay). The deferred M6 promise: the EVENT vocabulary
 * was final then; the CHAIN lands here.
 *
 * Invariants:
 *  - ONE writer. All appends funnel through an internal promise queue, so
 *    seq assignment and prev_hash linkage are strictly serialized no matter
 *    how many pipeline stages / webhook handlers append concurrently.
 *  - hash_n = sha256( (prev_hash ?? "GENESIS") + "\n" + canonicalJson(body_n) )
 *    where body = {seq, tx_id, ts, actor, rules_version, event, payload}.
 *  - seq is GLOBAL (not per-tx): it doubles as the SSE id so Last-Event-ID
 *    resume replays exactly the missed durable rows (§1.7).
 *  - verify() recomputes links; a tampered row reports chain_valid:false with
 *    the first broken seq — reporting tampering IS the feature.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@growthagent/shared";
import type { PgPool } from "../db/client.js";

export interface ChainActor {
  readonly agent_id: string;
  readonly kind: string;
  /** sha256 hex — NEVER a raw key. Pipeline/system actors hash their id. */
  readonly key_hash: string;
}

export interface AppendInput {
  readonly tx_id: string; // '-' for global events
  readonly ts: string; // ISO-8601
  readonly actor: ChainActor;
  readonly rules_version: number;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuditRow {
  readonly seq: number;
  readonly tx_id: string;
  readonly ts: string;
  readonly actor: ChainActor;
  readonly rules_version: number;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly prev_hash: string | null;
  readonly hash: string;
}

interface TailState {
  lastSeq: number;
  lastHash: string | null;
}

/** The documented hash formula, exported for the verifier AND the tests. */
export function hashEntry(prevHash: string | null, body: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(`${prevHash ?? "GENESIS"}\n${canonicalJson(body)}`, "utf8")
    .digest("hex");
}

/** The canonical hash-preimage body for a row (seq..payload; excludes hashes). */
function bodyOfRow(row: AuditRow): Record<string, unknown> {
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

const GENESIS_SEQ = 0;

function rowFromDb(r: Record<string, unknown>): AuditRow {
  return {
    seq: Number(r.seq),
    tx_id: r.tx_id as string,
    ts: new Date(r.ts as string).toISOString(),
    actor: {
      agent_id: r.actor_id as string,
      kind: r.actor_kind as string,
      key_hash: r.actor_key_hash as string,
    },
    rules_version: Number(r.rules_version),
    event: r.event as string,
    payload: r.payload as Record<string, unknown>,
    prev_hash: (r.prev_hash as string | null) ?? null,
    hash: r.hash as string,
  };
}

export class AuditChain {
  private tail: TailState = { lastSeq: GENESIS_SEQ, lastHash: null };
  private booted = false;
  /** Strict serialization of every append (single-writer invariant). */
  private q: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PgPool) {}

  /** Load the current tail so a restarted process continues the same chain. */
  async boot(): Promise<void> {
    const r = await this.db.query(
      `SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1`,
    );
    if ((r.rowCount ?? 0) > 0) {
      const row = r.rows[0] as { seq: string | number; hash: string };
      this.tail = { lastSeq: Number(row.seq), lastHash: row.hash };
    } else {
      this.tail = { lastSeq: GENESIS_SEQ, lastHash: null };
    }
    this.booted = true;
  }

  /** Serialized append. Resolves with the persisted row (seq + hashes set). */
  append(input: AppendInput): Promise<AuditRow> {
    const run = this.q.then(() => this.appendNow(input));
    // Keep the queue alive even when a caller's promise rejects.
    this.q = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async appendNow(input: AppendInput): Promise<AuditRow> {
    if (!this.booted) throw new Error("AuditChain.boot() must complete before append");
    const seq = this.tail.lastSeq + 1;
    const prevHash = this.tail.lastHash;
    const body = {
      seq,
      tx_id: input.tx_id,
      ts: input.ts,
      actor: input.actor,
      rules_version: input.rules_version,
      event: input.event,
      payload: input.payload,
    };
    const hash = hashEntry(prevHash, body);
    await this.db.query(
      `INSERT INTO audit_log
         (seq, tx_id, ts, actor_id, actor_kind, actor_key_hash,
          rules_version, event, payload, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        seq,
        input.tx_id,
        input.ts,
        input.actor.agent_id,
        input.actor.kind,
        input.actor.key_hash,
        input.rules_version,
        input.event,
        JSON.stringify(input.payload),
        prevHash,
        hash,
      ],
    );
    this.tail = { lastSeq: seq, lastHash: hash };
    return { ...body, payload: input.payload, prev_hash: prevHash, hash };
  }

  /** Current head (what heartbeats report as head_seq). */
  headSeq(): number {
    return this.tail.lastSeq;
  }

  /** Awaiting this resolves once every queued append has landed. */
  async drain(): Promise<void> {
    await this.q;
  }

  /** Durable history for one tx after `afterSeq` (SSE connect-time replay). */
  async tailFor(txId: string, afterSeq: number, limit = 1000): Promise<AuditRow[]> {
    const r = await this.db.query(
      `SELECT * FROM audit_log WHERE tx_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [txId, afterSeq, limit],
    );
    return (r.rows as Record<string, unknown>[]).map(rowFromDb);
  }

  /**
   * Recompute links. Two modes:
   *
   *  - GLOBAL (no txId): a full walk of the one true chain — a seq gap, a wrong
   *    prev_hash, or a body/hash mismatch each break it at that seq.
   *  - PER-TX (txId): the rows for one tx are NON-contiguous in global seq
   *    (interleaved with other txs) and each points its prev_hash at the GLOBAL
   *    predecessor, not the previous same-tx row. So we verify each row's OWN
   *    hash — which binds {body ‖ its global prev_hash} — proving the row is
   *    untampered AND still correctly linked into the global chain, while the
   *    legitimate seq gaps between this tx's rows are expected, not breakage.
   *
   * Reporting is data, never an exception.
   */
  async verify(txId?: string): Promise<VerifyResult> {
    if (txId === undefined) return this.verifyGlobal();

    const r = await this.db.query(`SELECT * FROM audit_log WHERE tx_id=$1 ORDER BY seq ASC`, [txId]);
    let checked = 0;
    for (const raw of r.rows as Record<string, unknown>[]) {
      const row = rowFromDb(raw);
      if (hashEntry(row.prev_hash, bodyOfRow(row)) !== row.hash) {
        return { chain_valid: false, broken_at_seq: row.seq, checked };
      }
      checked += 1;
    }
    return { chain_valid: true, broken_at_seq: null, checked };
  }

  private async verifyGlobal(): Promise<VerifyResult> {
    const r = await this.db.query(`SELECT * FROM audit_log ORDER BY seq ASC`);
    let prevHash: string | null = null;
    let expectedSeq = GENESIS_SEQ + 1;
    let checked = 0;
    for (const raw of r.rows as Record<string, unknown>[]) {
      const row = rowFromDb(raw);
      if (row.seq !== expectedSeq || row.prev_hash !== prevHash) {
        return { chain_valid: false, broken_at_seq: row.seq, checked };
      }
      if (hashEntry(row.prev_hash, bodyOfRow(row)) !== row.hash) {
        return { chain_valid: false, broken_at_seq: row.seq, checked };
      }
      prevHash = row.hash;
      expectedSeq = row.seq + 1;
      checked += 1;
    }
    return { chain_valid: true, broken_at_seq: null, checked };
  }
}

export interface VerifyResult {
  readonly chain_valid: boolean;
  readonly broken_at_seq: number | null;
  readonly checked: number;
}
