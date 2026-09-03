/**
 * api/src/http/demo-scenarios.route.ts — endpoint inventory rows 15–16 (§7.4):
 *   POST /v1/demo/scenarios/:name       — launch scripted demo scenario
 *   GET  /v1/demo/scenarios/runs/:runId — get verdict and assertions for scenario run
 */
import express, { type Router } from "express";
import {
  ScenarioParamsSchema,
  RunScenarioRequestSchema,
  ScenarioAcceptedSchema,
  ScenarioRunResultSchema,
  HttpError,
} from "@growthagent/shared";
import { asyncHandler } from "./errors.js";
import type { ScenarioRunner } from "./scenario-runner.js";

export interface DemoScenarioRoutesDeps {
  readonly runner: ScenarioRunner;
}

export function demoScenarioRoutes(deps: DemoScenarioRoutesDeps): Router {
  const router = express.Router();

  // POST /v1/demo/scenarios/:name — run scripted demo scenario
  router.post(
    "/v1/demo/scenarios/:name",
    express.json({ limit: "16kb" }),
    asyncHandler(async (req, res) => {
      const paramsParsed = ScenarioParamsSchema.safeParse(req.params);
      if (!paramsParsed.success) {
        throw new HttpError(404, "SCENARIO_NOT_FOUND", `unknown scenario '${req.params.name}'`, {
          retryable: false,
        });
      }

      const bodyParsed = RunScenarioRequestSchema.safeParse(req.body ?? {});
      if (!bodyParsed.success) {
        throw new HttpError(400, "VALIDATION_ERROR", "invalid scenario run request body", {
          details: bodyParsed.error.issues,
          retryable: false,
        });
      }

      const { name } = paramsParsed.data;
      const { overrides } = bodyParsed.data;

      const accepted = await deps.runner.start(name, overrides);
      res.status(202).json(ScenarioAcceptedSchema.parse(accepted));
    }),
  );

  // GET /v1/demo/scenarios/runs/:runId — get scenario run verdict
  router.get(
    "/v1/demo/scenarios/runs/:runId",
    asyncHandler(async (req, res) => {
      const { runId } = req.params;
      if (!runId) {
        throw new HttpError(400, "VALIDATION_ERROR", "missing runId", { retryable: false });
      }

      const result = deps.runner.getRun(runId);
      if (!result) {
        throw new HttpError(404, "SCENARIO_NOT_FOUND", `scenario run '${runId}' not found`, {
          retryable: false,
        });
      }

      res.status(200).json(ScenarioRunResultSchema.parse(result));
    }),
  );

  return router;
}
