/**
 * api/src/http/admin-reset.route.ts — endpoint inventory row 18 (§7.4 / §7.5):
 *   POST /v1/demo/reset — re-seed catalog/inventory/rules to pristine demo fixture.
 *
 * Requires `{ confirm: true }`. Fails with 409 DEMO_RESET_BLOCKED if there are
 * ACTIVE stock reservations or non-terminal proposal transactions, unless `{ force: true }`.
 */
import express, { type Router } from "express";
import {
  DemoResetRequestSchema,
  DemoResetResponseSchema,
  HttpError,
  MEERA_GT_V1,
  MEERA_RULES_V3,
  type MerchantRulesConfig,
} from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { sha256Hex } from "./crypto.js";
import { asyncHandler } from "./errors.js";
import type { ChaosController} from "./chaos-controller.js";
import { defaultChaosController } from "./chaos-controller.js";

export interface AdminResetRoutesDeps {
  readonly db: PgPool;
  readonly onRulesUpdated?: ((newRules: MerchantRulesConfig) => void) | undefined;
  readonly chaos?: ChaosController | undefined;
}

const DEFAULT_DEMO_AGENTS = [
  { id: "buyer_polite", key: "gak_polite_demo_key_0001", name: "Buyer Agent (Polite)" },
  { id: "buyer_adversarial", key: "gak_adversarial_demo_key_0002", name: "Buyer Agent (Adversarial)" },
  { id: "buyer_highvalue", key: "gak_highvalue_demo_key_0003", name: "Buyer Agent (High-Value)" },
  { id: "demo_runner", key: "gak_runner_demo_key_0004", name: "Demo Script Runner" },
  { id: "buyer_test", key: "gak_buyer_test_key_0001", name: "Test Buyer 1" },
  { id: "buyer_other", key: "gak_buyer_test_key_0002", name: "Test Buyer 2" },
] as const;

export function adminResetRoutes(deps: AdminResetRoutesDeps): Router {
  const router = express.Router();
  const chaos = deps.chaos ?? defaultChaosController;

  router.post(
    "/v1/demo/reset",
    express.json({ limit: "16kb" }),
    asyncHandler(async (req, res) => {
      const parsed = DemoResetRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, "VALIDATION_ERROR", "demo reset requires confirm: true", {
          details: parsed.error.issues,
          retryable: false,
        });
      }

      const { force } = parsed.data;

      // 1. Check for active reservations and non-terminal transactions.
      const [resvActive, txActive] = await Promise.all([
        deps.db.query<{ count: string }>(`SELECT COUNT(*) as count FROM stock_reservations WHERE status = 'ACTIVE'`),
        deps.db.query<{ count: string }>(`SELECT COUNT(*) as count FROM proposal_txs WHERE stage != 'TERMINAL'`),
      ]);

      const activeHolds = Number(resvActive.rows[0]?.count ?? 0);
      const activeTxs = Number(txActive.rows[0]?.count ?? 0);

      if ((activeHolds > 0 || activeTxs > 0) && !force) {
        throw new HttpError(
          409,
          "DEMO_RESET_BLOCKED",
          `cannot reset while ${activeHolds} stock reservations or ${activeTxs} in-flight transactions are active; pass force: true to override`,
          { retryable: false },
        );
      }

      // 2. Perform reset operations.
      if (force) {
        await deps.db.query(`
          UPDATE stock_reservations SET status = 'EXPIRED', released_at = now() WHERE status = 'ACTIVE';
          UPDATE proposal_txs SET stage = 'TERMINAL', outcome_json = '{"outcome":"FAILED","failure":{"stage":"TERMINAL","reason":"demo_reset","retryable":false}}' WHERE stage != 'TERMINAL';
          UPDATE transactions SET state = 'EXPIRED', expired_at = now() WHERE state IN ('PROPOSAL_APPROVED','STOCK_RESERVED','ORDER_CREATING','RZP_ORDER_CREATED','AWAITING_PAYMENT');
        `);
      }

      // Expire pending approvals.
      await deps.db.query(`
        UPDATE approvals
        SET status = 'RESOLVED', decision = 'REJECTED', decided_by = 'demo_reset', note = 'demo reset', resolved_at = now()
        WHERE status = 'PENDING';
      `);

      // Re-seed inventory.
      for (const it of MEERA_GT_V1.items) {
        await deps.db.query(
          `INSERT INTO inventory (sku, stock_qty, reserved, sold) VALUES ($1, $2, 0, 0)
           ON CONFLICT (sku) DO UPDATE SET stock_qty = $2, reserved = 0, sold = 0`,
          [it.sku_id, it.stock_on_hand],
        );
      }

      // Re-seed agent identities.
      for (const agent of DEFAULT_DEMO_AGENTS) {
        await deps.db.query(
          `INSERT INTO agent_identities (agent_id, display_name, role, api_key_hash, api_key_prefix, revoked_at, revoked_reason)
           VALUES ($1, $2, 'buyer_agent', $3, $4, NULL, NULL)
           ON CONFLICT (agent_id) DO UPDATE SET display_name = $2, api_key_hash = $3, api_key_prefix = $4, revoked_at = NULL, revoked_reason = NULL`,
          [agent.id, agent.name, sha256Hex(agent.key), agent.key.slice(0, 12)],
        );
      }

      // Re-seed merchant rules. The versions ABOVE the fixture must go: the
      // active rules are "the highest rules_version row" (a DB read-through, not
      // a per-process variable), so leaving a v7 from an earlier demo in place
      // would make "pristine reset" a no-op on the one thing the reset is for.
      const freshRules: MerchantRulesConfig = { ...MEERA_RULES_V3 };
      await deps.db.query(`DELETE FROM merchant_rules WHERE rules_version > $1`, [
        freshRules.rules_version,
      ]);
      await deps.db.query(
        `INSERT INTO merchant_rules (rules_version, rules_json, actor, note, increase)
         VALUES ($1, $2, 'demo_reset', 'pristine reset', false)
         ON CONFLICT (rules_version) DO UPDATE SET rules_json = $2, note = 'pristine reset'`,
        [freshRules.rules_version, JSON.stringify(freshRules)],
      );
      deps.onRulesUpdated?.(freshRules);

      // Disarm any leftover chaos flags.
      chaos.disarmAll();

      const response = DemoResetResponseSchema.parse({
        reset_at: new Date().toISOString(),
        seeded: {
          agents: DEFAULT_DEMO_AGENTS.map((a) => a.id),
          skus: MEERA_GT_V1.items.map((i) => i.sku_id),
          rules_version: freshRules.rules_version,
        },
        forced: Boolean(force),
      });

      res.status(200).json(response);
    }),
  );

  return router;
}
