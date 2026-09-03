/**
 * api/src/http/admin-mount.ts — the single mount point for the admin/demo
 * control plane (endpoint inventory rows 6–18). The §4.3 guard is applied ONLY
 * to the `/v1/admin` and `/v1/demo` prefixes so unrelated paths still fall
 * through to jsonNotFound() rather than being turned into a spurious 401.
 *
 * This router mounts all sub-groups:
 *  - agents (rows 13-14)
 *  - approvals (rows 9-11)
 *  - audit replay (row 12)
 *  - analytics aggregates + transaction index (rows 19-20)
 *  - rules (rows 6-8)
 *  - chaos (row 17)
 *  - reset (row 18)
 *  - scenarios (rows 15-16)
 */
import express, { type Router } from "express";
import type { PgPool } from "../db/client.js";
import type { RunInput } from "../pipeline/orchestrator.js";
import { requireAdmin } from "./admin-guard.js";
import { adminAgentRoutes } from "./admin-agents.route.js";
import { adminApprovalRoutes, type AdminApprovalRoutesDeps } from "./admin-approvals.route.js";
import { adminAuditRoutes } from "./admin-audit.route.js";
import { adminAnalyticsRoutes } from "./admin-analytics.route.js";
import { adminRulesRoutes, type AdminRulesRoutesDeps } from "./admin-rules.route.js";
import { adminChaosRoutes } from "./admin-chaos.route.js";
import { adminResetRoutes } from "./admin-reset.route.js";
import { demoScenarioRoutes } from "./demo-scenarios.route.js";
import type { ChaosController } from "./chaos-controller.js";
import { ScenarioRunner } from "./scenario-runner.js";
import type { AuditChain } from "../pipeline/audit-chain.js";

export interface AdminMountDeps {
  readonly db: PgPool;
  /** process.env.ADMIN_TOKEN (undefined ⇒ none configured). */
  readonly adminToken: string | undefined;
  /** Effective insecure-admin posture; defaults from NODE_ENV in the guard. */
  readonly allowInsecureAdmin?: boolean | undefined;
  /** Injectable warn sink (tests). */
  readonly warn?: ((msg: string) => void) | undefined;
  /** Current merchant rules_version (approvals drift guard). */
  readonly rulesVersion: () => number;
  /** Detached escalation resolvers (built in the composition root). */
  readonly resumeApproval: AdminApprovalRoutesDeps["resumeApproval"];
  readonly rejectApproval: AdminApprovalRoutesDeps["rejectApproval"];
  /** Hash-chained audit log (for replay). */
  readonly chain: AuditChain;
  /** Current rules accessor + update callback (for rules admin). */
  readonly getCurrentRules: AdminRulesRoutesDeps["getCurrentRules"];
  readonly onRulesUpdated: AdminRulesRoutesDeps["onRulesUpdated"];
  /** In-process chaos controller. */
  readonly chaos?: ChaosController | undefined;
  /** Pipeline enqueue and clock for scenario runner. */
  readonly enqueue?: ((input: RunInput) => void) | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly runner?: ScenarioRunner | undefined;
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

  // Sub-groups (master table rows 6–18)
  router.use(adminAgentRoutes({ db: deps.db }));
  router.use(
    adminApprovalRoutes({
      db: deps.db,
      rulesVersion: deps.rulesVersion,
      resumeApproval: deps.resumeApproval,
      rejectApproval: deps.rejectApproval,
    }),
  );
  router.use(adminAuditRoutes({ db: deps.db, chain: deps.chain }));
  router.use(
    adminAnalyticsRoutes({
      db: deps.db,
      rulesVersion: deps.rulesVersion,
      ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}),
    }),
  );
  router.use(
    adminRulesRoutes({
      db: deps.db,
      getCurrentRules: deps.getCurrentRules,
      onRulesUpdated: deps.onRulesUpdated,
    }),
  );
  router.use(adminChaosRoutes({ chaos: deps.chaos }));
  router.use(
    adminResetRoutes({
      db: deps.db,
      onRulesUpdated: deps.onRulesUpdated,
      chaos: deps.chaos,
    }),
  );

  const scenarioRunner =
    deps.runner ??
    (deps.enqueue && deps.nowMs
      ? new ScenarioRunner({
          db: deps.db,
          enqueue: deps.enqueue,
          nowMs: deps.nowMs,
          rulesVersion: deps.rulesVersion,
          chaos: deps.chaos,
        })
      : undefined);

  if (scenarioRunner) {
    router.use(demoScenarioRoutes({ runner: scenarioRunner }));
  }

  return router;
}
