/**
 * api/src/http/admin-approvals.route.ts — endpoint inventory rows 10–12 (§7.2):
 *   GET  /v1/admin/approvals?status=PENDING|RESOLVED — the human inbox
 *   POST /v1/admin/approvals/:id/approve             — resume settlement (202)
 *   POST /v1/admin/approvals/:id/reject              — terminal DECLINED (202)
 *
 * The resume/reject work (CAS resolution + settlement or decline) runs through
 * the injected resolver closures. The CAS is the authoritative first-writer-wins
 * arbiter: its `{already:true}` result maps to 409 APPROVAL_ALREADY_RESOLVED, so
 * a concurrent approve+reject double-submit resolves deterministically. A
 * synchronous pre-read handles the cheap rejections first (unknown → 404, rules
 * drift → 409) before any resolution work is attempted.
 *
 * The response is 202: settlement completes to AWAITING_WEBHOOK (the payment is
 * still pending its webhook), and any settlement failure surfaces as a terminal
 * tx state on the stream/poll — never as an error on the approve call.
 *
 * `rules_version` for both the inbox projection and the drift guard is the
 * version PINNED on the tx at gate entry (proposal_txs.rules_version, E-09) —
 * never a live re-read — which is exactly what makes "rules changed since
 * escalation" detectable.
 */
import express, { type Router } from "express";
import {
  ApprovalRequestSchema,
  ApproveRequestSchema,
  RejectRequestSchema,
  ApprovalResolvedSchema,
  HttpError,
  type ApprovalRequest,
} from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import { asyncHandler } from "./errors.js";

/** Resolver closures — built in the composition root from the orchestrator's
 *  resumeAfterApproval/rejectAfterRejection bound to ResolveDeps. They perform
 *  the CAS and (on win) the settlement/decline, returning whether the CAS was
 *  already lost so the route can map the loser to 409. */
export interface AdminApprovalRoutesDeps {
  readonly db: PgPool;
  /** Current merchant rules_version (for the drift guard). */
  readonly rulesVersion: () => number;
  /** Resume settlement on the frozen proposal (CAS + settle). */
  readonly resumeApproval: (a: { approval_id: string; decided_by: string; note?: string | undefined }) => Promise<{ already: boolean }>;
  /** Human-decline terminal (CAS + decline). */
  readonly rejectApproval: (a: { approval_id: string; decided_by: string; note?: string | undefined }) => Promise<{ already: boolean }>;
}

const DECIDED_BY = "admin-console";

interface InboxRow {
  approval_id: string;
  tx_id: string;
  reason: ApprovalRequest["reason"];
  band_context: unknown;
  frozen_proposal: unknown;
  gate_trace_summary: unknown;
  created_at: string;
  expires_at: string;
  rules_version: number | null;
}

/**
 * Strip the single-use settlement credential out of the frozen proposal before
 * it leaves the process.
 *
 * `frozen_proposal` is the COMPLETE SettleableProposal, and it embeds
 * `approval_token` — the one-shot credential settle() consumes. The inbox is
 * admin-gated, but a reviewer's browser is still the least trustworthy place
 * that token could sit, and the reviewer never needs it: approving goes through
 * POST /approve, which reads the token server-side from the same row. So the
 * response carries the cart, not the key to spend it.
 *
 * Deliberately a shallow copy of the top level only — the token lives there, and
 * a deep walk would risk silently dropping a nested field the UI does render.
 */
function withoutApprovalToken(frozen: unknown): unknown {
  if (frozen === null || typeof frozen !== "object" || Array.isArray(frozen)) return frozen;
  const { approval_token: _redacted, ...rest } = frozen as Record<string, unknown>;
  return rest;
}

export function adminApprovalRoutes(deps: AdminApprovalRoutesDeps): Router {
  const router = express.Router();

  // Row 10 — the inbox. Default to PENDING; ?status=RESOLVED lists the history.
  router.get(
    "/v1/admin/approvals",
    asyncHandler(async (req, res) => {
      const statusParam = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "PENDING";
      if (statusParam !== "PENDING" && statusParam !== "RESOLVED") {
        throw new HttpError(400, "VALIDATION_ERROR", "status must be PENDING or RESOLVED", {
          retryable: false,
        });
      }
      const r = await deps.db.query(
        `SELECT a.approval_id, a.tx_id, a.reason, a.band_context, a.frozen_proposal,
                a.gate_trace_summary, a.created_at, a.expires_at, t.rules_version
           FROM approvals a
           JOIN proposal_txs t ON t.tx_id = a.tx_id
          WHERE a.status = $1
          ORDER BY a.created_at DESC, a.approval_id ASC`,
        [statusParam],
      );
      const approvals = (r.rows as InboxRow[]).map((row) =>
        ApprovalRequestSchema.parse({
          approval_id: row.approval_id,
          tx_id: row.tx_id,
          reason: row.reason,
          band_context: row.band_context,
          proposed_cart_snapshot: withoutApprovalToken(row.frozen_proposal),
          gate_trace_summary: row.gate_trace_summary,
          created_at: new Date(row.created_at).toISOString(),
          expires_at: new Date(row.expires_at).toISOString(),
          rules_version: row.rules_version ?? deps.rulesVersion(),
        }),
      );
      res.status(200).json({ approvals });
    }),
  );

  // Rows 11–12 — resolve. A synchronous pre-read handles the cheap rejections
  // (unknown → 404, prior resolution → 409, rules drift → 409); the resolver's
  // own CAS is then awaited so a rapid double-submit maps its loser to 409
  // deterministically (first-writer-wins), independent of timing.
  const resolveHandler = (decision: "APPROVED" | "REJECTED") =>
    asyncHandler(async (req, res) => {
      const parsed =
        decision === "APPROVED"
          ? ApproveRequestSchema.safeParse(req.body ?? {})
          : RejectRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, "VALIDATION_ERROR", "invalid resolve body", {
          details: parsed.error.issues,
          retryable: false,
        });
      }
      const approvalId = req.params.id;
      if (approvalId === undefined || approvalId === "") {
        throw new HttpError(400, "VALIDATION_ERROR", "missing approval id", { retryable: false });
      }

      // Pre-read: existence, prior resolution, and the pinned rules_version.
      const pre = await deps.db.query(
        `SELECT a.status, t.rules_version
           FROM approvals a
           LEFT JOIN proposal_txs t ON t.tx_id = a.tx_id
          WHERE a.approval_id = $1`,
        [approvalId],
      );
      if ((pre.rowCount ?? 0) === 0) {
        throw new HttpError(404, "APPROVAL_NOT_FOUND", "no such approval", { retryable: false });
      }
      const cur = pre.rows[0] as { status: string; rules_version: number | null };
      if (cur.status === "RESOLVED") {
        throw new HttpError(409, "APPROVAL_ALREADY_RESOLVED", "approval already resolved", {
          retryable: false,
        });
      }

      const note = (parsed.data as { approver_note?: string }).approver_note;

      if (decision === "APPROVED") {
        // Drift guard: the rules moved since escalation and the caller did not
        // explicitly re-confirm the CURRENT version.
        const pinned = cur.rules_version ?? deps.rulesVersion();
        const current = deps.rulesVersion();
        const confirm = (parsed.data as { confirm_rules_version?: number }).confirm_rules_version;
        if (pinned !== current && confirm !== current) {
          throw new HttpError(409, "RULES_DRIFTED", "rules changed since escalation; confirm you still want this", {
            details: { pinned_rules_version: pinned, current_rules_version: current },
            retryable: false,
          });
        }
        const { already } = await deps.resumeApproval({ approval_id: approvalId, decided_by: DECIDED_BY, note });
        if (already) {
          throw new HttpError(409, "APPROVAL_ALREADY_RESOLVED", "approval already resolved", { retryable: false });
        }
        res.status(202).json(ApprovalResolvedSchema.parse({ approval_id: approvalId, status: "SETTLING" }));
        return;
      }

      const { already } = await deps.rejectApproval({ approval_id: approvalId, decided_by: DECIDED_BY, note });
      if (already) {
        throw new HttpError(409, "APPROVAL_ALREADY_RESOLVED", "approval already resolved", { retryable: false });
      }
      res.status(202).json(ApprovalResolvedSchema.parse({ approval_id: approvalId, status: "DECLINED" }));
    });

  router.post("/v1/admin/approvals/:id/approve", express.json({ limit: "8kb" }), resolveHandler("APPROVED"));
  router.post("/v1/admin/approvals/:id/reject", express.json({ limit: "8kb" }), resolveHandler("REJECTED"));

  return router;
}
