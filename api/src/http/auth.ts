/**
 * api/src/http/auth.ts — agent authentication (api-contract.md §4.1/§4.2).
 *
 * The presented key (canonical `X-Agent-Key`, or `Authorization: Bearer <key>`
 * as an accepted alias) is SHA-256'd and looked up by `api_key_hash` — an
 * indexed equality on a digest, so timing side-channels over the network are
 * impractical; a post-fetch `timingSafeEqual` on the digest is kept on principle.
 * Revocation is re-checked on EVERY request (no cache at demo scale). The
 * resolved identity is what the buyer route snapshots into the tx (E-11) — the
 * gatekeeper's velocity never re-reads a live header.
 */
import type { Request, RequestHandler } from "express";
import { HttpError } from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { sha256Hex, timingSafeEqualStr } from "./crypto.js";

export interface AgentIdentity {
  readonly agentId: string;
  readonly role: "buyer_agent" | "system";
  readonly keyPrefix: string;
  /** sha256 hex of the presented key — the tx snapshot + audit actor use this. */
  readonly keyHash: string;
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

/** Pull the raw key from the canonical header or the Bearer alias. */
function extractKey(req: Request): string | null {
  const direct = req.header("X-Agent-Key");
  if (direct && direct.trim() !== "") return direct.trim();
  const auth = req.header("Authorization");
  if (auth) {
    const m = BEARER_RE.exec(auth.trim());
    if (m && m[1] && m[1].trim() !== "") return m[1].trim();
  }
  return null;
}

/**
 * Resolve + validate the presented key. Returns the identity, or an HttpError
 * (401 UNAUTHORIZED / 401 AGENT_KEY_REVOKED) — the caller decides how to raise.
 */
export async function authenticateAgent(db: PgPool, req: Request): Promise<AgentIdentity | HttpError> {
  const key = extractKey(req);
  if (key === null) {
    return new HttpError(401, "UNAUTHORIZED", "missing X-Agent-Key", { retryable: false });
  }
  const keyHash = sha256Hex(key);
  const r = await db.query(
    `SELECT agent_id, role, api_key_hash, api_key_prefix, revoked_at
       FROM agent_identities WHERE api_key_hash = $1`,
    [keyHash],
  );
  if ((r.rowCount ?? 0) === 0) {
    return new HttpError(401, "UNAUTHORIZED", "unrecognized agent key", { retryable: false });
  }
  const row = r.rows[0] as {
    agent_id: string;
    role: "buyer_agent" | "system";
    api_key_hash: string;
    api_key_prefix: string;
    revoked_at: string | null;
  };
  // Principle-only constant-time recheck of the digest (the SQL equality
  // already matched; this guards against a hypothetical hash-collision seam).
  if (!timingSafeEqualStr(row.api_key_hash, keyHash)) {
    return new HttpError(401, "UNAUTHORIZED", "unrecognized agent key", { retryable: false });
  }
  if (row.revoked_at !== null) {
    return new HttpError(401, "AGENT_KEY_REVOKED", "agent key has been revoked", { retryable: false });
  }
  return { agentId: row.agent_id, role: row.role, keyPrefix: row.api_key_prefix, keyHash };
}

/**
 * Middleware: authenticate, then (optionally) require a role. Attaches
 * `req.agent`. A wrong role for an authenticated agent is 403 FORBIDDEN.
 *
 * `onFailure` is the seam the failed-authentication limiter hangs off (audit
 * 8.2): rejections are what a key brute-forcer produces, and they are the only
 * traffic that should cost a source anything.
 */
export function requireAgent(
  db: PgPool,
  role?: AgentIdentity["role"],
  opts: { readonly onFailure?: (req: Request) => void } = {},
): RequestHandler {
  return (req, _res, next) => {
    void authenticateAgent(db, req).then((result) => {
      if (result instanceof HttpError) {
        opts.onFailure?.(req);
        next(result);
        return;
      }
      if (role !== undefined && result.role !== role) {
        opts.onFailure?.(req);
        next(new HttpError(403, "FORBIDDEN", "agent role not permitted on this route", { retryable: false }));
        return;
      }
      req.agent = result;
      next();
    }, next);
  };
}
