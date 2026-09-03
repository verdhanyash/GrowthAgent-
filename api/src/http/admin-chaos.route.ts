/**
 * api/src/http/admin-chaos.route.ts — endpoint inventory row 17 (§7.4):
 *   GET    /v1/demo/chaos — inspect armed chaos flags
 *   PUT    /v1/demo/chaos — arm a chaos flag with optional tx_ids scope and TTL
 *   DELETE /v1/demo/chaos — disarm all chaos flags
 */
import express, { type Router } from "express";
import {
  ChaosStateResponseSchema,
  PutChaosRequestSchema,
  HttpError,
} from "@growthagent/shared";
import { asyncHandler } from "./errors.js";
import type { ChaosController} from "./chaos-controller.js";
import { defaultChaosController } from "./chaos-controller.js";

export interface AdminChaosRoutesDeps {
  readonly chaos?: ChaosController | undefined;
}

export function adminChaosRoutes(deps: AdminChaosRoutesDeps = {}): Router {
  const router = express.Router();
  const chaos = deps.chaos ?? defaultChaosController;

  // GET /v1/demo/chaos — inspect armed chaos flags
  router.get(
    "/v1/demo/chaos",
    asyncHandler(async (_req, res) => {
      const armed = chaos.list();
      res.status(200).json(ChaosStateResponseSchema.parse({ armed }));
    }),
  );

  // PUT /v1/demo/chaos — arm a chaos flag
  router.put(
    "/v1/demo/chaos",
    express.json({ limit: "16kb" }),
    asyncHandler(async (req, res) => {
      const parsed = PutChaosRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, "VALIDATION_ERROR", "invalid chaos update body", {
          details: parsed.error.issues,
          retryable: false,
        });
      }

      const { flag, scope, ttl_minutes } = parsed.data;
      chaos.arm(flag, scope?.tx_ids, ttl_minutes ?? 10);

      const armed = chaos.list();
      res.status(200).json(ChaosStateResponseSchema.parse({ armed }));
    }),
  );

  // DELETE /v1/demo/chaos — disarm all chaos flags
  router.delete(
    "/v1/demo/chaos",
    asyncHandler(async (_req, res) => {
      chaos.disarmAll();
      res.status(200).json(ChaosStateResponseSchema.parse({ armed: [] }));
    }),
  );

  return router;
}
