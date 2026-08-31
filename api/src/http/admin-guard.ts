/**
 * api/src/http/admin-guard.ts — the admin/demo trust boundary (api-contract §4.3).
 *
 * A DELIBERATELY SHALLOW demo shortcut (accepted-risk A-01), two parts:
 *   1. loopback bind — remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}
 *   2. constant-time X-Admin-Token compare against ADMIN_TOKEN
 *
 * Off-loopback is 401 regardless of token (§11.1) — an off-box caller never
 * learns whether a token would have worked. A buyer key means nothing here;
 * admin routes never consult agent_identities. Escape hatch ALLOW_INSECURE_ADMIN
 * (default true ONLY when NODE_ENV !== "production") admits loopback-with-no-token
 * and logs loudly; production forces it false and a missing token is a hard 401.
 *
 * The handlers never learn HOW they were authenticated — swapping this one
 * middleware for real auth is the whole migration path.
 */
import type { Request, RequestHandler } from "express";
import { HttpError } from "@growthagent/shared";
import { timingSafeEqualStr } from "./crypto.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface AdminGuardOptions {
  /** The shared admin token (process.env.ADMIN_TOKEN). Undefined ⇒ none configured. */
  readonly adminToken: string | undefined;
  /** Admit loopback with a missing token (dev only). Defaults from NODE_ENV. */
  readonly allowInsecure?: boolean;
  /** Injectable warn sink (tests). */
  readonly warn?: (msg: string) => void;
}

/** Is the request from the loopback interface? */
function isLoopback(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return LOOPBACK.has(addr);
}

/**
 * Resolve the effective insecure-admin posture. Production ALWAYS forces it off;
 * elsewhere it defaults on (zero-config demo) unless explicitly disabled.
 */
export function resolveAllowInsecure(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  const raw = env.ALLOW_INSECURE_ADMIN;
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

/** Build the guard middleware. Applied at the /v1/admin and /v1/demo prefixes. */
export function requireAdmin(opts: AdminGuardOptions): RequestHandler {
  const allowInsecure = opts.allowInsecure ?? resolveAllowInsecure();
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  let warnedInsecure = false;

  return (req, _res, next) => {
    // (1) Off-loopback is ALWAYS 401 — no token oracle for remote callers.
    if (!isLoopback(req)) {
      next(new HttpError(401, "UNAUTHORIZED", "admin routes are loopback-only", { retryable: false }));
      return;
    }

    const presented = req.header("X-Admin-Token");
    const configured = opts.adminToken;

    // (2) Token present + configured → constant-time compare.
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
