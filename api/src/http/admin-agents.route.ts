/**
 * api/src/http/admin-agents.route.ts — rows 13–14 of the endpoint inventory:
 *   GET  /v1/admin/agents               — list identities (revocation state)
 *   POST /v1/admin/agents/:agentId/revoke — revoke an agent API key
 *
 * Admin/loopback-only (guard mounted at the /v1/admin prefix in app.ts), so
 * unlike the buyer surface there is NO cross-agent existence oracle to protect:
 * an unknown :agentId is an honest 404 AGENT_NOT_FOUND. The hash is NEVER
 * projected — only the display prefix (api_key_prefix, §4.1).
 *
 * Revocation is idempotent-safe: the UPDATE narrows on `revoked_at IS NULL`, so
 * a second revoke of an already-revoked agent is a no-op that still returns the
 * (already-revoked) row rather than clobbering the original reason/timestamp.
 */
import express, { type Router } from "express";
import {
  AdminAgentsResponseSchema,
  AdminAgentSchema,
  RevokeAgentRequestSchema,
  HttpError,
  type AdminAgent,
} from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { asyncHandler } from "./errors.js";

export interface AdminAgentRoutesDeps {
  readonly db: PgPool;
}

interface AgentRow {
  agent_id: string;
  display_name: string;
  role: "buyer_agent" | "system";
  api_key_prefix: string;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

/** Project a DB row onto the wire shape (never the hash). */
function toAdminAgent(row: AgentRow): AdminAgent {
  return AdminAgentSchema.parse({
    agent_id: row.agent_id,
    display_name: row.display_name,
    role: row.role,
    api_key_prefix: row.api_key_prefix,
    created_at: new Date(row.created_at).toISOString(),
    revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    revoked_reason: row.revoked_reason,
  });
}

const SELECT_COLS =
  "agent_id, display_name, role, api_key_prefix, created_at, revoked_at, revoked_reason";

export function adminAgentRoutes(deps: AdminAgentRoutesDeps): Router {
  const router = express.Router();

  // Row 13 — list identities, newest first.
  router.get(
    "/v1/admin/agents",
    asyncHandler(async (_req, res) => {
      const r = await deps.db.query(
        `SELECT ${SELECT_COLS} FROM agent_identities ORDER BY created_at DESC, agent_id ASC`,
      );
      const agents = (r.rows as AgentRow[]).map(toAdminAgent);
      res.status(200).json(AdminAgentsResponseSchema.parse({ agents }));
    }),
  );

  // Row 14 — revoke a key. Idempotent: re-revoking preserves the first reason.
  router.post(
    "/v1/admin/agents/:agentId/revoke",
    express.json({ limit: "8kb" }),
    asyncHandler(async (req, res) => {
      const parsed = RevokeAgentRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, "VALIDATION_ERROR", "invalid revoke body", {
          details: parsed.error.issues,
          retryable: false,
        });
      }
      const agentId = req.params.agentId;
      const reason = parsed.data.reason ?? null;

      const upd = await deps.db.query(
        `UPDATE agent_identities
            SET revoked_at = now(), revoked_reason = $2
          WHERE agent_id = $1 AND revoked_at IS NULL
          RETURNING ${SELECT_COLS}`,
        [agentId, reason],
      );

      if ((upd.rowCount ?? 0) > 0) {
        res.status(200).json(toAdminAgent(upd.rows[0] as AgentRow));
        return;
      }

      // No row updated: either unknown agent (404) or already revoked (return as-is).
      const cur = await deps.db.query(`SELECT ${SELECT_COLS} FROM agent_identities WHERE agent_id = $1`, [
        agentId,
      ]);
      if ((cur.rowCount ?? 0) === 0) {
        throw new HttpError(404, "AGENT_NOT_FOUND", "no such agent", { retryable: false });
      }
      res.status(200).json(toAdminAgent(cur.rows[0] as AgentRow));
    }),
  );

  return router;
}
