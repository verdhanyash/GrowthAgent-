/**
 * api/src/http/cors.ts — EXPLICIT cross-origin posture (audit 8.4).
 *
 * The finding was that CORS was never configured anywhere, so the answer to
 * "can a browser on another origin call this API?" was an accident of Express's
 * defaults rather than a decision. It is a decision now:
 *
 *  - DEFAULT: no CORS headers at all. The demo dashboard is SAME-ORIGIN — Vite
 *    proxies /v1 and /webhooks to the API (web/vite.config.ts) — so nothing in
 *    this repo needs them, and an API whose only credential is a bearer-style
 *    header should not invite `fetch` from arbitrary pages.
 *  - OPT-IN: `CORS_ALLOWED_ORIGINS` is a comma-separated ALLOWLIST of exact
 *    origins. A matching `Origin` gets that origin echoed back (never `*`, which
 *    cannot carry credentials and would hide the mistake), plus the headers the
 *    buyer surface actually uses. Anything else is answered as if CORS were off,
 *    which is a plain browser-side failure rather than a silent success.
 *
 * `Vary: Origin` is always set when an allowlist is configured, so a shared
 * cache cannot serve one origin's permissive response to another.
 */
import type { RequestHandler } from "express";

/** Methods the buyer + admin surfaces expose. */
const ALLOWED_METHODS = "GET,POST,PUT,DELETE,OPTIONS";
/** Request headers a browser client legitimately sends. */
const ALLOWED_HEADERS = "Content-Type,X-Agent-Key,X-Admin-Token,X-Request-Id,Last-Event-ID,Authorization";
/** Response headers worth exposing to script. */
const EXPOSED_HEADERS = "X-Request-Id,Retry-After";

/** Parse the allowlist; empty ⇒ CORS stays off. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter((s) => s !== "");
}

/**
 * Build the middleware. With an empty allowlist it is a pass-through that adds
 * nothing — identical to today's behaviour, just deliberate.
 */
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allow = new Set(allowedOrigins);
  return (req, res, next) => {
    if (allow.size === 0) {
      next();
      return;
    }
    res.setHeader("Vary", "Origin");
    const origin = req.header("Origin");
    if (origin === undefined || !allow.has(origin.replace(/\/$/, ""))) {
      // Not an allowed origin: no headers. A browser blocks it; a server-to-server
      // client (which never sends Origin) is unaffected.
      next();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return;
    }
    next();
  };
}
