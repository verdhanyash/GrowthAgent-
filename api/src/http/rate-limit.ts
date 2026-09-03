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

/* ------------------------- failed-authentication gate -------------------- */

export interface FailureLimiterOptions {
  /** Consecutive failures tolerated from one source before the door shuts. */
  readonly maxFailures: number;
  /** How fast the budget is forgiven, failures per second. */
  readonly refillPerSec: number;
  /** Injectable clock (tests); defaults to Date.now. */
  readonly now?: () => number;
  /** Bucket key; defaults to client IP. */
  readonly key?: (req: Request) => string;
  /** Drop buckets idle longer than this during pruning (default 15 min). */
  readonly idleTtlMs?: number;
}

/**
 * Budget for FAILED authentications, keyed by source IP (audit 8.2).
 *
 * The token-bucket above cannot cover key brute-forcing: it sits AFTER
 * `requireAgent`, so a request with a bad `X-Agent-Key` is rejected before any
 * token is spent, and an attacker could grind the key space for free. Limiting
 * the route wholesale is not an option either — the buyer poll shares the
 * `/v1/carts/proposals` prefix and is explicitly never throttled (clients poll
 * every 50 ms).
 *
 * So this counts ONLY failures. Successful traffic — any volume of it — never
 * touches a bucket; a source that keeps presenting keys that do not resolve
 * runs out of budget and gets 429 with a Retry-After instead of another oracle.
 * Memory is bounded by the same lazy pruning, so there are no timers.
 */
export class FailureLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly keyOf: (req: Request) => string;
  private readonly idleTtlMs: number;
  private lastPrune: number;

  constructor(private readonly opts: FailureLimiterOptions) {
    this.now = opts.now ?? ((): number => Date.now());
    this.keyOf = opts.key ?? ((req: Request): string => `ip:${req.ip ?? "unknown"}`);
    this.idleTtlMs = opts.idleTtlMs ?? 900_000;
    this.lastPrune = this.now();
  }

  private bucket(req: Request): Bucket {
    const t = this.now();
    if (t - this.lastPrune >= 60_000) {
      this.lastPrune = t;
      for (const [k, b] of this.buckets) {
        if (t - b.last > this.idleTtlMs) this.buckets.delete(k);
      }
    }
    const key = this.keyOf(req);
    let b = this.buckets.get(key);
    if (b === undefined) {
      b = { tokens: this.opts.maxFailures, last: t };
      this.buckets.set(key, b);
    }
    const elapsedSec = Math.max(0, t - b.last) / 1000;
    b.tokens = Math.min(this.opts.maxFailures, b.tokens + elapsedSec * this.opts.refillPerSec);
    b.last = t;
    return b;
  }

  /** Middleware: 429 while this source's failure budget is exhausted. */
  guard(): RequestHandler {
    return (req, res, next) => {
      const b = this.bucket(req);
      if (b.tokens >= 1) {
        next();
        return;
      }
      const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / this.opts.refillPerSec));
      res.setHeader("Retry-After", String(retryAfterSec));
      next(
        new HttpError(429, "RATE_LIMITED_HTTP", "too many failed authentications — slow down", {
          retryable: true,
          details: { retry_after_seconds: retryAfterSec },
        }),
      );
    };
  }

  /** Charge one failed authentication to this request's source. */
  record(req: Request): void {
    const b = this.bucket(req);
    b.tokens = Math.max(0, b.tokens - 1);
  }
}
