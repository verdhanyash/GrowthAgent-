/**
 * Layer-1 Postgres twin (settlement.md §8.1): INSERT … ON CONFLICT DO NOTHING
 * is the durable fallback + audit copy. If Redis flushed, replay degrades to
 * this store (§15.4); if Redis died MID-finalize, the row was already saved
 * here before the Lua call, so no completed result is ever lost (§14 edge 17).
 */
import type { PgPool } from "../../db/client.js";

export interface PgIdemRow {
  readonly key: string;
  readonly request_hash: string;
  readonly tx_id: string | null;
  readonly response_status: number | null;
  readonly response_body: unknown;
}

export class PgIdempotencyStore {
  constructor(private readonly db: PgPool) {}

  /**
   * First write wins; conflict ⇒ the earlier row stands (callers then serve
   * the STORED snapshot rather than their own — verbatim-replay semantics).
   */
  async save(row: {
    key: string;
    requestHash: string;
    txId?: string | null;
    status: number;
    body: unknown;
  }): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO idempotency_keys (key, request_hash, tx_id, response_status, response_body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO NOTHING`,
      [row.key, row.requestHash, row.txId ?? null, row.status, JSON.stringify(row.body)],
    );
    return (r.rowCount ?? 0) === 1;
  }

  /** DONE row for `key` whose request hash matches; null otherwise. */
  async lookupDone(key: string, requestHash: string): Promise<{ status: number; body: unknown } | null> {
    const r = await this.db.query(
      `SELECT response_status, response_body FROM idempotency_keys
        WHERE key = $1 AND request_hash = $2 AND response_status IS NOT NULL`,
      [key, requestHash],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return { status: row.response_status as number, body: row.response_body };
  }
}
