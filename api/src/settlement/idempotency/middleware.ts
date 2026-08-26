/**
 * Layer-1 inbound gate (settlement.md §8.1). Mount AFTER the JSON parser on
 * every money-moving POST (settle + escalation approvals). Semantics:
 *
 *   fresh key            → acquire IN_FLIGHT, pass through
 *   same key+body DONE   → verbatim replay of the original status/body,
 *                          `Idempotency-Replayed: true` header
 *   same key, IN_FLIGHT  → 409 IDEMPOTENCY_IN_FLIGHT + Retry-After: 2
 *   same key, other body → 422 IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY
 *   Redis down           → FAIL CLOSED: PG-twin replay if one exists, else
 *                          503 IDEMPOTENCY_STORE_UNAVAILABLE. Correctness >
 *                          availability for a payments path — processing
 *                          without the in-flight marker is how duplicates
 *                          happen (§8.1 rationale).
 *
 * The route handler finishes the protocol explicitly via finalize()/abort()
 * (attached to res.locals) — no response-interception magic.
 */
import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { canonicalJson } from "@growthagent/shared";
import { auditGlobal } from "../../audit/writer.js";
import type { PgIdempotencyStore } from "./pg-store.js";
import type { RedisIdempotencyStore } from "./redis-store.js";

export interface IdempotencyContext {
  readonly key: string;
  readonly bodyHash: string;
}

declare module "express-serve-static-core" {
  interface Locals {
    idempotency?: IdempotencyContext;
  }
}

export function bodyHashOf(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

export function idempotencyGate(
  redisStore: RedisIdempotencyStore,
  pgStore: PgIdempotencyStore,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const key = req.header("idempotency-key");
    if (!key || key.trim() === "") {
      res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED" });
      return;
    }
    const bodyHash = bodyHashOf(req.body);

    let acquired: boolean;
    try {
      acquired = await redisStore.acquireInFlight(key, bodyHash);
    } catch {
      // Redis down: degraded-read from the durable twin; else fail closed.
      try {
        const done = await pgStore.lookupDone(key, bodyHash);
        if (done) {
          auditGlobal("settlement.idem", "idem.replay", { source: "pg_degraded", key_hash: hashKey(key) });
          replay(res, done.status, done.body);
          return;
        }
      } catch {
        /* PG also unreachable — fall through to fail-closed */
      }
      auditGlobal("settlement.idem", "idem.store_unavailable", { op: "acquire" });
      res.status(503).json({ code: "IDEMPOTENCY_STORE_UNAVAILABLE", retryable: true });
      return;
    }

    if (!acquired) {
      const prev = await redisStore.get(key);
      if (!prev || prev.bodyHash !== bodyHash) {
        // Absent-but-unacquirable is treated as a body mismatch refusal — the
        // conservative branch: never execute on ambiguity.
        auditGlobal("settlement.idem", "idem.key_body_mismatch", {});
        res.status(422).json({ code: "IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY" });
        return;
      }
      if (prev.phase === "IN_FLIGHT") {
        auditGlobal("settlement.idem", "idem.in_flight_conflict", {});
        res.status(409).set("Retry-After", "2").json({ code: "IDEMPOTENCY_IN_FLIGHT" });
        return;
      }
      auditGlobal("settlement.idem", "idem.replay", { source: "redis" });
      replay(res, prev.status ?? 500, prev.body);
      return;
    }

    res.locals.idempotency = { key, bodyHash };
    next();
  };
}

function replay(res: Response, status: number, body: unknown): void {
  res.status(status).set("Idempotency-Replayed", "true").json(body);
}

function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
}

/** Route handler success path: persist twin FIRST, then promote Redis
 *  (§14 edge 17 ordering — a Redis failure here still leaves the PG row). */
export async function finalizeIdempotency(
  res: Response,
  stores: { redis: RedisIdempotencyStore; pg: PgIdempotencyStore },
  txId: string | null,
  status: number,
  body: unknown,
): Promise<void> {
  const ctx = res.locals.idempotency;
  if (!ctx) return; // gate not mounted (e.g. direct unit invocation)
  try {
    await stores.pg.save({ key: ctx.key, requestHash: ctx.bodyHash, txId, status, body });
  } catch (e) {
    auditGlobal("settlement.idem", "idem.pg_save_failed", { err: String(e) });
  }
  try {
    await stores.redis.finalizeDone(ctx.key, ctx.bodyHash, status, body);
  } catch (e) {
    auditGlobal("settlement.idem", "idem.store_unavailable", { op: "finalize", err: String(e) });
  }
}

/** Route handler failure path: failed start → allow clean retry (§8.1). */
export async function abortIdempotency(
  res: Response,
  redis: RedisIdempotencyStore,
): Promise<void> {
  const ctx = res.locals.idempotency;
  if (!ctx) return;
  try {
    await redis.release(ctx.key);
  } catch (e) {
    auditGlobal("settlement.idem", "idem.store_unavailable", { op: "release", err: String(e) });
  }
}
