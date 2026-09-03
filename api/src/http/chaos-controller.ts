/**
 * api/src/http/chaos-controller.ts — in-process Chaos Flag Store (§7.4, Row 17).
 *
 * In-memory controller managing armed chaos flags (`LLM_TIMEOUT`, `GATEWAY_ERROR`).
 * Flags have mandatory TTL (default 10 min, cap 30 min) and optional `tx_ids`
 * scoping to prevent rehearsal runs from contaminating live demo runs (E-16).
 */
import {
  type ChaosFlag,
  type ArmedChaos,
} from "@growthagent/shared";

export interface ChaosEntry {
  flag: ChaosFlag;
  tx_ids: string[] | null;
  expires_at_ms: number;
  expires_at_iso: string;
}

export class ChaosController {
  private readonly flags = new Map<ChaosFlag, ChaosEntry>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  /**
   * Arm a chaos flag with optional tx_ids scoping and TTL in minutes (default 10, max 30).
   */
  arm(flag: ChaosFlag, txIds?: string[] | null, ttlMinutes = 10): ArmedChaos {
    const cappedTtlMinutes = Math.min(30, Math.max(1, ttlMinutes));
    const now = this.nowMs();
    const expiresAtMs = now + cappedTtlMinutes * 60 * 1000;
    const expiresAtIso = new Date(expiresAtMs).toISOString();
    const normalizedTxIds = txIds && txIds.length > 0 ? Array.from(new Set(txIds)) : null;

    const entry: ChaosEntry = {
      flag,
      tx_ids: normalizedTxIds,
      expires_at_ms: expiresAtMs,
      expires_at_iso: expiresAtIso,
    };

    this.flags.set(flag, entry);

    return {
      flag,
      tx_ids: normalizedTxIds,
      expires_at: expiresAtIso,
    };
  }

  /**
   * List all currently active, non-expired armed chaos flags.
   */
  list(): ArmedChaos[] {
    this.sweep();
    return Array.from(this.flags.values()).map((entry) => ({
      flag: entry.flag,
      tx_ids: entry.tx_ids,
      expires_at: entry.expires_at_iso,
    }));
  }

  /**
   * Disarm all chaos flags.
   */
  disarmAll(): void {
    this.flags.clear();
  }

  /**
   * Check whether a specific chaos flag is currently active (and matches optional tx_id).
   */
  isArmed(flag: ChaosFlag, txId?: string): boolean {
    this.sweep();
    const entry = this.flags.get(flag);
    if (!entry) return false;

    // Global scope (tx_ids === null) applies to all txs.
    if (entry.tx_ids === null) return true;

    // Scoped flag requires matching txId.
    if (txId !== undefined && entry.tx_ids.includes(txId)) return true;

    return false;
  }

  /**
   * Clean up expired flags.
   */
  private sweep(): void {
    const now = this.nowMs();
    for (const [flag, entry] of this.flags.entries()) {
      if (entry.expires_at_ms <= now) {
        this.flags.delete(flag);
      }
    }
  }
}

/** Global default chaos controller singleton for in-process hooks. */
export const defaultChaosController = new ChaosController();
