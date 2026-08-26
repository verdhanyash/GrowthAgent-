/**
 * Layer-1 Redis store (settlement.md §8.1): SET NX PX marks "work in
 * progress" BEFORE work starts; the finalize Lua atomically promotes
 * IN_FLIGHT → DONE and never overwrites an existing DONE snapshot (guards a
 * pathological retry re-marking in-flight over a finished result). Every
 * method can throw on connection loss — the middleware owns fail-closed.
 */
import type { Redis } from "ioredis";

export interface IdemSnapshot {
  readonly phase: "IN_FLIGHT" | "DONE";
  readonly bodyHash: string;
  readonly status?: number;
  readonly body?: unknown;
}

/** Atomically promote IN_FLIGHT → DONE; keep any DONE already stored. */
const IDEM_FINALIZE_LUA = `
if string.find(redis.call('GET', KEYS[1]), '"phase":"IN_FLIGHT"', 1, true) then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
  return 1
end
return 0`;

export class RedisIdempotencyStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs: number,
  ) {}

  private key(userKey: string): string {
    return `idem:${userKey}`;
  }

  /** SET NX PX — true ⇒ we own the key; false ⇒ someone got there first. */
  async acquireInFlight(userKey: string, bodyHash: string): Promise<boolean> {
    const payload = JSON.stringify({ phase: "IN_FLIGHT", bodyHash } satisfies IdemSnapshot);
    const r = await this.redis.set(this.key(userKey), payload, "PX", this.ttlMs, "NX");
    return r === "OK";
  }

  async get(userKey: string): Promise<IdemSnapshot | null> {
    const raw = await this.redis.get(this.key(userKey));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IdemSnapshot;
    } catch {
      return null; // corrupt entry behaves as absent; PG twin remains authoritative
    }
  }

  /** Returns false when a DONE snapshot was already present (kept, not overwritten). */
  async finalizeDone(
    userKey: string,
    bodyHash: string,
    status: number,
    body: unknown,
  ): Promise<boolean> {
    const snapshot = JSON.stringify({
      phase: "DONE",
      bodyHash,
      status,
      body,
    } satisfies IdemSnapshot);
    const r = await this.redis.eval(
      IDEM_FINALIZE_LUA,
      1,
      this.key(userKey),
      snapshot,
      String(this.ttlMs),
    );
    return r === 1;
  }

  /** Failed start: allow clean retry with the same key. */
  async release(userKey: string): Promise<void> {
    await this.redis.del(this.key(userKey));
  }
}
