/**
 * api/src/http/admin-mount.ts — the single mount point for the admin/demo
 * control plane (endpoint inventory rows 6–18). The §4.3 guard is applied ONLY
 * to the `/v1/admin` and `/v1/demo` prefixes so unrelated paths still fall
 * through to jsonNotFound() rather than being turned into a spurious 401.
 *
 * This router grows one sub-group at a time (agents → approvals → audit →
 * rules → chaos → scenarios → reset); app.ts mounts it once, after the buyer
 * surface, and only ever forwards the deps below.
 */
import express, { type Router } from "express";
import type { PgPool } from "../db/client.js";
import { requireAdmin } from "./admin-guard.js";
import { adminAgentRoutes } from "./admin-agents.route.js";

export interface AdminMountDeps {
  readonly db: PgPool;
  /** process.env.ADMIN_TOKEN (undefined ⇒ none configured). */
  readonly adminToken: string | undefined;
  /** Effective insecure-admin posture; defaults from NODE_ENV in the guard. */
  readonly allowInsecureAdmin?: boolean | undefined;
  /** Injectable warn sink (tests). */
  readonly warn?: ((msg: string) => void) | undefined;
}

export function adminRoutes(deps: AdminMountDeps): Router {
  const router = express.Router();

  const guard = requireAdmin({
    adminToken: deps.adminToken,
    ...(deps.allowInsecureAdmin !== undefined ? { allowInsecure: deps.allowInsecureAdmin } : {}),
    ...(deps.warn !== undefined ? { warn: deps.warn } : {}),
  });
  // Prefix-scoped: the guard never runs for non-admin/demo paths.
  router.use(["/v1/admin", "/v1/demo"], guard);

  // Sub-groups (append as each lands).
  router.use(adminAgentRoutes({ db: deps.db }));

  return router;
}
