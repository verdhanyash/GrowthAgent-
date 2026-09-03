/**
 * api/src/http/admin-guard.ts — the admin/demo trust boundary (api-contract §4.3).
 *
 * A DELIBERATELY SHALLOW demo shortcut (accepted-risk A-01), three parts:
 *   1. NO PROXY — any forwarding header means the connection we can see is the
 *      proxy's, not the caller's, so the loopback test below proves nothing
 *   2. loopback bind — remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}
 *   3. constant-time X-Admin-Token compare against ADMIN_TOKEN
 *
 * Step 1 is audit finding H1. `req.socket.remoteAddress` is the address of
 * whatever opened the TCP connection: behind NGINX / ALB / Traefik / a Docker
 * port publish that is the PROXY, which is routinely 127.0.0.1 or a bridge IP.
 * Combined with ALLOW_INSECURE_ADMIN defaulting on outside production, an
 * internet-reachable staging box therefore handed anyone `PUT /v1/admin/rules`
 * (set max_discount_pct to 100), `POST /v1/demo/reset` (wipe the database) and
 * approval of any escalated order. Rejecting forwarded requests outright is the
 * fail-closed reading of "loopback-only"; the migration path off this guard is
 * real authentication, not a trusted-proxy list.
 *
 * Off-loopback is 401 regardless of token (§11.1) — an off-box caller never
 * learns whether a token would have worked. A buyer key means nothing here;
 * admin routes never consult agent_identities. Escape hatch ALLOW_INSECURE_ADMIN
 * admits loopback-with-no-token and logs loudly; production forces it false, and
 * outside production it now defaults OFF as soon as an ADMIN_TOKEN exists — an
 * operator who configured a token is asking for it to be enforced.
 *
 * The handlers never learn HOW they were authenticated — swapping this one
 * middleware for real auth is the whole migration path.
 */
import type { Request, RequestHandler } from "express";
import { HttpError } from "@growthagent/shared";
import { timingSafeEqualStr } from "./crypto.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Headers that exist only because something rewrote the request on its way
 * here. Their presence is proof that `req.socket.remoteAddress` describes a
 * hop, not the caller — so the loopback check cannot be trusted.
 */
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-real-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "forwarded",
  "via",
] as const;

export interface AdminGuardOptions {
  /** The shared admin token (process.env.ADMIN_TOKEN). Undefined ⇒ none configured. */
  readonly adminToken: string | undefined;
  /** Admit loopback with a missing token (dev only). Defaults from NODE_ENV. */
  readonly allowInsecure?: boolean;
  /** Injectable warn sink (tests). */
  readonly warn?: (msg: string) => void;
}

/** Name of the first forwarding header present, else null. */
export function forwardedVia(req: Request): string | null {
  for (const name of FORWARDING_HEADERS) {
    const value = req.header(name);
    if (value !== undefined && value.trim() !== "") return name;
  }
  return null;
}

/** Is the request from the loopback interface? */
function isLoopback(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return LOOPBACK.has(addr);
}

/**
 * Resolve the effective insecure-admin posture. Production ALWAYS forces it off.
 * Outside production an explicit ALLOW_INSECURE_ADMIN wins; with no explicit
 * value it defaults on ONLY when no ADMIN_TOKEN is configured, so setting a
 * token is enough to make it enforced (audit H1).
 */
export function resolveAllowInsecure(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  const raw = env.ALLOW_INSECURE_ADMIN;
  if (raw !== undefined) return raw !== "false" && raw !== "0";
  const token = env.ADMIN_TOKEN;
  return token === undefined || token.trim() === "";
}

/** Build the guard middleware. Applied at the /v1/admin and /v1/demo prefixes. */
export function requireAdmin(opts: AdminGuardOptions): RequestHandler {
  const allowInsecure = opts.allowInsecure ?? resolveAllowInsecure();
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  let warnedInsecure = false;
  let warnedForwarded = false;

  return (req, _res, next) => {
    // (1) Arrived through a proxy ⇒ the socket address is the proxy's. Refuse
    //     before looking at anything else; no token oracle either.
    const via = forwardedVia(req);
    if (via !== null) {
      if (!warnedForwarded) {
        warn(
          `[api] ADMIN REJECTED — request carried a proxy header (${via}); admin routes are ` +
            `loopback-only and a forwarded request's socket address is the proxy's, not the caller's`,
        );
        warnedForwarded = true;
      }
      next(
        new HttpError(401, "UNAUTHORIZED", "admin routes are loopback-only (request was proxied)", {
          retryable: false,
        }),
      );
      return;
    }

    // (2) Off-loopback is ALWAYS 401 — no token oracle for remote callers.
    if (!isLoopback(req)) {
      next(new HttpError(401, "UNAUTHORIZED", "admin routes are loopback-only", { retryable: false }));
      return;
    }

    const presented = req.header("X-Admin-Token");
    const configured = opts.adminToken;

    // (3) Token present + configured → constant-time compare.
    if (configured !== undefined && configured !== "") {
      if (presented !== undefined && presented !== "" && timingSafeEqualStr(presented, configured)) {
        next();
        return;
      }
      // Loopback but bad/missing token: allow only under the insecure escape hatch.
      if (allowInsecure) {
        if (!warnedInsecure) {
          warn("[api] ADMIN AUTH DISABLED — ALLOW_INSECURE_ADMIN admitted a loopback request with a bad/missing X-Admin-Token");
          warnedInsecure = true;
        }
        next();
        return;
      }
      next(new HttpError(401, "UNAUTHORIZED", "invalid or missing X-Admin-Token", { retryable: false }));
      return;
    }

    // No token configured at all.
    if (allowInsecure) {
      if (!warnedInsecure) {
        warn("[api] ADMIN AUTH DISABLED — no ADMIN_TOKEN configured; loopback admin access is open (dev only)");
        warnedInsecure = true;
      }
      next();
      return;
    }
    // Production with no token configured → refuse.
    next(new HttpError(401, "UNAUTHORIZED", "admin token not configured", { retryable: false }));
  };
}
