/**
 * api/src/rules/store.ts — THE source of truth for the active merchant rules.
 *
 * Audit H4 (multi-instance rules drift): the active rules used to live in a
 * `let currentRules` closure in the composition root. A `PUT /v1/admin/rules`
 * on replica A therefore never reached replicas B–D, so identical carts were
 * judged under different caps depending on which instance answered — silently,
 * with no error and no audit trail for the discrepancy. `merchant_rules` was
 * already the durable, insert-only history; this store makes it AUTHORITATIVE.
 *
 * Shape:
 *  - `load()` is what the pipeline calls at gate entry. It re-reads the highest
 *    `rules_version` row whenever the cached snapshot is older than `ttlMs`, so
 *    a remote PUT is picked up within one TTL on every replica.
 *  - `version()` / `snapshot()` are the SYNC accessors for display paths (the
 *    SSE envelope's rules_version, the approvals drift hint). They read the last
 *    loaded snapshot; a decision must never be taken on them.
 *  - `set()` is the local-write fast path: the admin route already knows the new
 *    config, so its own replica reflects it with no read-back.
 *
 * The TTL is the drift window, and it is deliberately short. Correctness of a
 * single decision never depends on it: every run pins ONE snapshot for both the
 * gate and the settleable it mints, and `rules_version` is recorded on the tx.
 */
import { MEERA_RULES_V3, MerchantRulesConfigSchema, type MerchantRulesConfig } from "@growthagent/shared";
import type { PgPool } from "../db/client.js";

export const DEFAULT_RULES_TTL_MS = 1_000;

export interface RulesStoreOptions {
  /** Max staleness of the cached snapshot before `load()` re-reads (default 1s). */
  readonly ttlMs?: number;
  /** Injectable clock (tests). */
  readonly nowMs?: () => number;
}

export class RulesStore {
  private cached: MerchantRulesConfig = { ...MEERA_RULES_V3 };
  private loadedAtMs = Number.NEGATIVE_INFINITY;
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  /** Coalesces concurrent refreshes into one query. */
  private inflight: Promise<MerchantRulesConfig> | null = null;

  constructor(
    private readonly db: PgPool,
    opts: RulesStoreOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_RULES_TTL_MS;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
  }

  /**
   * Seed `merchant_rules` with MEERA_RULES_V3 when the table is empty, then
   * prime the cache from whatever the DB now holds. Safe to run concurrently on
   * several replicas: the insert is a no-op for the loser of the race.
   */
  async boot(): Promise<MerchantRulesConfig> {
    await this.db.query(
      `INSERT INTO merchant_rules (rules_version, rules_json, actor, note, increase)
       VALUES ($1, $2, 'system', 'initial seed', false)
       ON CONFLICT (rules_version) DO NOTHING`,
      [MEERA_RULES_V3.rules_version, JSON.stringify(MEERA_RULES_V3)],
    );
    return this.refresh();
  }

  /** Read-through accessor: the ONLY thing a decision may be based on. */
  async load(): Promise<MerchantRulesConfig> {
    if (this.nowMs() - this.loadedAtMs < this.ttlMs) return this.cached;
    return this.refresh();
  }

  /** Force a re-read, bypassing the TTL. */
  async refresh(): Promise<MerchantRulesConfig> {
    // One query per burst: N pipeline runs starting together share the read.
    this.inflight ??= this.readLatest().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async readLatest(): Promise<MerchantRulesConfig> {
    const r = await this.db.query(
      `SELECT rules_version, rules_json FROM merchant_rules ORDER BY rules_version DESC LIMIT 1`,
    );
    if ((r.rowCount ?? 0) > 0) {
      const row = r.rows[0] as { rules_version: number; rules_json: unknown };
      // Parse, never trust: a hand-edited row must fail loudly here rather than
      // hand the gatekeeper a config that skips half its fields.
      const parsed = MerchantRulesConfigSchema.safeParse(row.rules_json);
      if (parsed.success) {
        this.cached = parsed.data;
      } else {
        console.error(
          `[api] merchant_rules v${String(row.rules_version)} failed schema validation; ` +
            `keeping rules v${String(this.cached.rules_version)}`,
        );
      }
    }
    this.loadedAtMs = this.nowMs();
    return this.cached;
  }

  /** Local-write fast path (admin PUT / demo reset on THIS replica). */
  set(rules: MerchantRulesConfig): void {
    this.cached = rules;
    this.loadedAtMs = this.nowMs();
  }

  /** Last loaded snapshot — display paths only. */
  snapshot(): MerchantRulesConfig {
    return this.cached;
  }

  /** Last loaded rules_version — display paths only. */
  version(): number {
    return this.cached.rules_version;
  }
}
