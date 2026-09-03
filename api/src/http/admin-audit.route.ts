/**
 * api/src/http/admin-audit.route.ts — endpoint inventory row 12 (§7.3):
 *   GET /v1/admin/audit/:txId/replay?deep=true
 *
 * Reads ONLY the append-only hash chain — never live tables — and rebuilds the
 * timeline. `deep=true` recomputes every hash link; default verifies links only.
 * A broken chain is a 200 with chain_valid:false, not a 500 — reporting
 * tampering IS the feature. This doubles as the demo's "nothing was edited
 * afterward" proof.
 *
 * The response shape is the AuditReplaySchema defined in shared.
 */
import express, { type Router } from "express";
import { AuditReplaySchema, HttpError, type AuditReplay } from "@growthagent/shared";
import type { AuditChain, AuditRow } from "../pipeline/audit-chain.js";
import type { PgPool } from "../db/client.js";
import { asyncHandler } from "./errors.js";

export interface AdminAuditRoutesDeps {
  readonly db: PgPool;
  readonly chain: AuditChain;
}

/**
 * Rebuild the stage timeline from audit events. Stage transitions are inferred
 * from `stage_started` and `stage_completed` event names, plus `pipeline_started`
 * / `pipeline_terminal` as bookends. The logic is intentionally forgiving —
 * unknown event types are skipped (forward-compatible), and partial traces
 * (e.g., crash mid-pipeline) produce partial stage arrays.
 */
function rebuildStages(rows: readonly AuditRow[]): AuditReplay["rebuilt_stages"] {
  const stages: AuditReplay["rebuilt_stages"] = [];
  const stageStack = new Map<string, number>(); // stage name → entered_seq

  for (const row of rows) {
    const ev = row.event;
    const payload = row.payload as Record<string, unknown>;

    // pipeline_started signals the opening stage.
    if (ev === "pipeline_started" && typeof payload.stage === "string") {
      stageStack.set(payload.stage, row.seq);
    }

    // stage_started opens a stage; stage_completed closes it.
    if (ev === "stage_started" && typeof payload.stage === "string") {
      stageStack.set(payload.stage, row.seq);
    }

    if (ev === "stage_completed" && typeof payload.stage === "string") {
      const entered = stageStack.get(payload.stage);
      if (entered !== undefined) {
        stages.push({ stage: payload.stage, entered_seq: entered, exited_seq: row.seq });
        stageStack.delete(payload.stage);
      }
    }

    // pipeline_terminal closes everything still open.
    if (ev === "pipeline_terminal" || ev === "pipeline_failed") {
      for (const [stage, entered] of stageStack) {
        stages.push({ stage, entered_seq: entered, exited_seq: row.seq });
      }
      stageStack.clear();
    }
  }

  // Anything still open (pipeline crashed before terminal event).
  for (const [stage, entered] of stageStack) {
    stages.push({ stage, entered_seq: entered, exited_seq: null });
  }

  return stages;
}

/**
 * Attempt to extract the terminal outcome from the audit log. The outcome is
 * stored in the payload of the `pipeline_terminal` event as `outcome_json`.
 */
function extractOutcome(rows: readonly AuditRow[]): AuditReplay["rebuilt_outcome"] {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.event === "pipeline_terminal" && row.payload.outcome_json !== undefined) {
      // Return as-is — the schema validates it (passthrough for nullable).
      return row.payload.outcome_json as AuditReplay["rebuilt_outcome"];
    }
  }
  return null;
}

export function adminAuditRoutes(deps: AdminAuditRoutesDeps): Router {
  const router = express.Router();

  router.get(
    "/v1/admin/audit/:txId/replay",
    asyncHandler(async (req, res) => {
      const txId = req.params.txId;
      if (txId === undefined || txId === "") {
        throw new HttpError(400, "VALIDATION_ERROR", "missing txId", { retryable: false });
      }

      // deep=true recomputes every hash link; default verifies links only.
      // (Both modes currently run through chain.verify which always recomputes.)
      const _deep = req.query.deep === "true";

      // 1. Verify the hash chain for this tx.
      const verification = await deps.chain.verify(txId);

      // 2. Load ALL audit rows for this tx (for stage rebuild + outcome).
      const allRows = await deps.chain.tailFor(txId, 0);

      // 3. Rebuild stages and outcome from the event stream.
      const rebuilt_stages = rebuildStages(allRows);
      const rebuilt_outcome = extractOutcome(allRows);

      const firstRow = allRows.length > 0 ? allRows[0]! : null;
      const lastRow = allRows.length > 0 ? allRows[allRows.length - 1]! : null;

      const body: AuditReplay = AuditReplaySchema.parse({
        tx_id: txId,
        chain_valid: verification.chain_valid,
        broken_at_seq: verification.broken_at_seq,
        event_count: allRows.length,
        rebuilt_stages,
        rebuilt_outcome,
        first_event_at: firstRow?.ts ?? null,
        last_event_at: lastRow?.ts ?? null,
      });

      res.status(200).json(body);
    }),
  );

  return router;
}
