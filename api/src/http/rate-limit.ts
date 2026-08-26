/**
 * api/src/http/rate-limit.ts — a dependency-free, in-memory token-bucket
 * limiter for the WIRED buyer surface (api-contract §3 reserves the
 * RATE_LIMITED_HTTP code for exactly this transport-layer guard, distinct from
 * the gatekeeper's business velocity rules).
 *
 * Applied ONLY to the expensive/mutating POSTs (proposal create fires a whole
 * pipeline; stream-ticket mint signs a credential) — never to the cheap poll or
 * the long-lived SSE GET, so a client that polls every 50ms is never throttled.
 *
 * Keyed by authenticated agent id when present (set by requireAgent upstream),
 * else by client IP. No timers: memory is bounded by lazy pruning on access, so
 * the module never keeps the event loop alive (important under vitest).
 */
import type { Request, RequestHandler } from "express";
import { HttpError } from "@growthagent/shared";

export interface RateLimitOptions {
  /** Max burst (tokens available when idle). */
  readonly capacity: number;
  /** Sustained refill rate, tokens per second. */
  readonly refillPerSec: number;
  /** Injectable clock (tests); defaults to Date.now. */
  readonly now?: () => number;
  /** Bucket key; defaults to agent id → IP. */
  readonly key?: (req: Request) => string;
  /** Drop buckets idle longer than this during pruning (default 5 min). */
  readonly idleTtlMs?: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

/** agent id (authenticated) → IP → "unknown". */
function defaultKey(req: Request): string {
  const agentId = req.agent?.agentId;
  if (agentId !== undefined && agentId !== "") return `a:${agentId}`;
  return `ip:${req.ip ?? "unknown"}`;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const now = opts.now ?? ((): number => Date.now());
  const keyOf = opts.key ?? defaultKey;
  const idleTtlMs = opts.idleTtlMs ?? 300_000;
  const buckets = new Map<string, Bucket>();
  let lastPrune = now();

  const prune = (t: number): void => {
    if (t - lastPrune < 60_000) return; // at most once a minute
    lastPrune = t;
    for (const [k, b] of buckets) {
      if (t - b.last > idleTtlMs) buckets.delete(k);
    }
  };

  return (req, res, next) => {
    const t = now();
    prune(t);
    const key = keyOf(req);
    let b = buckets.get(key);
    if (b === undefined) {
      b = { tokens: opts.capacity, last: t };
      buckets.set(key, b);
    }
    // Refill by elapsed time, capped at capacity.
    const elapsedSec = Math.max(0, t - b.last) / 1000;
    b.tokens = Math.min(opts.capacity, b.tokens + elapsedSec * opts.refillPerSec);
    b.last = t;

    if (b.tokens < 1) {
      const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / opts.refillPerSec));
      res.setHeader("Retry-After", String(retryAfterSec));
      next(
        new HttpError(429, "RATE_LIMITED_HTTP", "too many requests — slow down", {
          retryable: true,
          details: { retry_after_seconds: retryAfterSec },
        }),
      );
      return;
    }
    b.tokens -= 1;
    next();
  };
}
