/**
 * api/src/http/proposals.route.ts — POST /v1/carts/proposals + the poll
 * GET /v1/carts/proposals/:txId (api-contract §5.1/§5.1.1/§5.2).
 *
 * POST is async-job style: authenticate → validate → reqHash → claim the
 * per-agent idempotency slot (which MINTS the tx_id atomically) → enqueue the
 * detached pipeline → 202. Replays return the SAME tx_id; a same-key different-
 * body collision is 409 IDEMPOTENCY_CONFLICT. The HTTP layer never touches
 * `proposal_txs` (runPipeline claims it) nor `transactions` (settle owns it).
 *
 * Ownership is authoritative on `proposal_idempotency` (written synchronously in
 * the POST), NOT `proposal_txs` (claimed later by the detached pipeline) — so a
 * poll/stream that races ahead of the pipeline still resolves ownership and
 * reports PROPOSING rather than a spurious 404.
 */
import express, { type Router } from "express";
import {
  CreateProposalRequestSchema,
  ProposalAcceptedSchema,
  ProposalPendingSchema,
  ProposalTerminalSchema,
  ProposalStatusResponse,
  TxParamsSchema,
  HttpError,
  canonicalJson,
  type CartMandate,
  type CreateProposalRequest,
} from "@growthagent/shared";
import type { PgPool } from "../db/client.js";
import type { RunInput } from "../pipeline/orchestrator.js";
import { asyncHandler } from "./errors.js";
import { sha256Hex } from "./crypto.js";
import { mintTxId } from "./ids.js";

export interface ProposalRoutesDeps {
  readonly db: PgPool;
  readonly nowMs: () => number;
  /** Fallback rules_version when the tx never reached the gate (pre-gate FAIL). */
  readonly rulesVersion: () => number;
  /** Fire the pipeline detached — wired to runPipeline(pipelineDeps, input). */
  readonly enqueue: (input: RunInput) => void;
  /** Lazily mint+persist+return the signed CartMandate for an APPROVED tx. */
  readonly buildMandate: (txId: string) => Promise<CartMandate | null>;
  readonly merchantId?: string | undefined;
}

const PROP_STAGES = new Set([
  "PROPOSING",
  "BUILDING_EVIDENCE",
  "NEGOTIATING",
  "CITATION_AUDIT",
  "GATE_CHECKING",
  "AWAITING_HUMAN_APPROVAL",
  "SETTLING",
  "TERMINAL",
]);

/**
 * Collapse `items_hint` into per-SKU quantities.
 *
 * The wire contract is `z.array(Sku)` and a buyer listing the same SKU twice
 * means "two of them". Mapping each entry to `qty: 1` silently threw the second
 * one away (the fallback bundler dedupes by SKU), so a request for two hampers
 * was quietly answered with one.
 */
function itemsFromHint(skus: readonly string[]): { sku: string; qty: number }[] {
  const counts = new Map<string, number>();
  for (const sku of skus) counts.set(sku, (counts.get(sku) ?? 0) + 1);
  return [...counts.entries()].map(([sku, qty]) => ({ sku, qty }));
}

/** Map the validated request onto the pipeline's RunInput (§5.1). */
function toRunInput(
  txId: string,
  agent: { agentId: string; keyHash: string },
  body: CreateProposalRequest,
  merchantId: string,
): RunInput {
  const cr = body.customer_request;
  const items =
    cr.items_hint !== undefined && cr.items_hint.length > 0
      ? itemsFromHint(cr.items_hint)
      : [{ label_free_text: cr.natural_language, qty: 1 }];
  return {
    tx_id: txId,
    agent: { agent_id: agent.agentId, key_hash: agent.keyHash },
    buyer_request: {
      items,
      budget_hint_paise: cr.budget_paise,
      occasion_hint: cr.occasion,
      channel: "AGENT",
    },
    customer_note_raw: body.untrusted.customer_note,
    merchant_id: merchantId,
  };
}

export function proposalRoutes(deps: ProposalRoutesDeps): Router {
  const router = express.Router();
  const merchantId = deps.merchantId ?? "meeras-cakes";
  router.post("/v1/carts/proposals", express.json({ limit: "64kb" }), asyncHandler(async (req, res) => {
    const agent = req.agent;
    if (agent === undefined) throw new HttpError(401, "UNAUTHORIZED", "missing agent identity");

    const parsed = CreateProposalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "request failed schema", {
        details: parsed.error.issues,
        retryable: false,
      });
    }
    const body = parsed.data;

    // Header alias: Idempotency-Key must agree with the canonical body field.
    const headerKey = req.header("Idempotency-Key");
    if (headerKey !== undefined && headerKey.trim() !== "" && headerKey.trim() !== body.idempotency_key) {
      throw new HttpError(400, "VALIDATION_ERROR", "Idempotency-Key header conflicts with body", {
        details: { path: "/idempotency_key" },
        retryable: false,
      });
    }

    const reqHash = sha256Hex(canonicalJson(body as unknown as Record<string, unknown>));
    const nowMs = deps.nowMs();
    const mintedTxId = mintTxId(nowMs);

    // Claim the (agent, key) slot; the winner's tx_id is minted here.
    const claim = await deps.db.query(
      `INSERT INTO proposal_idempotency (agent_id, key, request_hash, tx_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT (agent_id, key) DO NOTHING
       RETURNING tx_id, created_at`,
      [agent.agentId, body.idempotency_key, reqHash, mintedTxId],
    );

    let txId: string;
    let createdAtIso: string;
    let replay: boolean;
    if ((claim.rowCount ?? 0) > 0) {
      const row = claim.rows[0] as { tx_id: string; created_at: string };
      txId = row.tx_id;
      createdAtIso = new Date(row.created_at).toISOString();
      replay = false;
      deps.enqueue(toRunInput(txId, agent, body, merchantId));
    } else {
      const existing = await deps.db.query(
        `SELECT tx_id, request_hash, created_at FROM proposal_idempotency WHERE agent_id=$1 AND key=$2`,
        [agent.agentId, body.idempotency_key],
      );
      const row = existing.rows[0] as { tx_id: string; request_hash: string; created_at: string };
      if (row.request_hash !== reqHash) {
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "idempotency key reused with a different body", {
          txId: row.tx_id,
          retryable: false,
        });
      }
      txId = row.tx_id;
      createdAtIso = new Date(row.created_at).toISOString();
      replay = true;
    }

    const accepted = ProposalAcceptedSchema.parse({
      tx_id: txId,
      status: "PROPOSING",
      stream_url: `/v1/stream/${txId}`,
      poll_url: `/v1/carts/proposals/${txId}`,
      agent_id: agent.agentId,
      created_at: createdAtIso,
      idempotent_replay: replay,
    });
    res.status(202).json(accepted);
  }));

  router.get("/v1/carts/proposals/:txId", asyncHandler(async (req, res) => {
    const agent = req.agent;
    if (agent === undefined) throw new HttpError(401, "UNAUTHORIZED", "missing agent identity");

    const params = TxParamsSchema.safeParse(req.params);
    if (!params.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "invalid tx id", {
        details: params.error.issues,
        retryable: false,
      });
    }
    const txId = params.data.txId;

    // Ownership on the synchronously-written idempotency row (foreign/unknown →
    // uniform 404, no cross-agent existence oracle; E-13).
    const own = await deps.db.query(
      `SELECT created_at FROM proposal_idempotency WHERE tx_id=$1 AND agent_id=$2`,
      [txId, agent.agentId],
    );
    if ((own.rowCount ?? 0) === 0) {
      throw new HttpError(404, "TX_NOT_FOUND", "no such transaction for this agent", {
        txId,
        retryable: false,
      });
    }
    const ownCreatedAt = new Date((own.rows[0] as { created_at: string }).created_at).toISOString();

    const txr = await deps.db.query(
      `SELECT stage, rules_version, outcome_json, updated_at, finished_at
         FROM proposal_txs WHERE tx_id=$1`,
      [txId],
    );
    // The pipeline hasn't claimed proposal_txs yet — still PROPOSING.
    if ((txr.rowCount ?? 0) === 0) {
      res.status(200).json(
        ProposalPendingSchema.parse({
          tx_id: txId,
          status: "PROPOSING",
          stage_entered_at: ownCreatedAt,
          rules_version_pending_note: null,
        }),
      );
      return;
    }
    const tx = txr.rows[0] as {
      stage: string;
      rules_version: number | null;
      outcome_json: Record<string, unknown> | null;
      updated_at: string;
      finished_at: string | null;
    };

    // No terminal outcome recorded yet → PENDING at the current stage.
    if (tx.outcome_json === null) {
      const status = PROP_STAGES.has(tx.stage) && tx.stage !== "TERMINAL" ? tx.stage : "PROPOSING";
      res.status(200).json(
        ProposalPendingSchema.parse({
          tx_id: txId,
          status,
          stage_entered_at: new Date(tx.updated_at).toISOString(),
          rules_version_pending_note: null,
        }),
      );
      return;
    }

    const body = await buildTerminalBody(deps, txId, tx);
    res.status(200).json(ProposalStatusResponse.parse(body));
  }));

  return router;
}

/* --------------------------- terminal projection ------------------------ */

const PROPOSAL_STAGE_SET = new Set([
  "PROPOSING", "BUILDING_EVIDENCE", "NEGOTIATING", "CITATION_AUDIT",
  "GATE_CHECKING", "AWAITING_HUMAN_APPROVAL", "SETTLING", "TERMINAL",
]);

async function buildTerminalBody(
  deps: ProposalRoutesDeps,
  txId: string,
  tx: {
    stage: string;
    rules_version: number | null;
    outcome_json: Record<string, unknown> | null;
    updated_at: string;
    finished_at: string | null;
  },
): Promise<unknown> {
  const oc = tx.outcome_json as Record<string, unknown>;
  const outcome = String(oc.outcome);
  const rulesVersion = tx.rules_version ?? deps.rulesVersion();
  const finishedAt = new Date(tx.finished_at ?? tx.updated_at).toISOString();

  if (outcome === "APPROVED") {
    const mandate = await deps.buildMandate(txId);
    if (mandate === null) {
      // Settlement row not yet visible — surface as still SETTLING, not a lie.
      return ProposalPendingSchema.parse({
        tx_id: txId,
        status: "SETTLING",
        stage_entered_at: new Date(tx.updated_at).toISOString(),
        rules_version_pending_note: null,
      });
    }
    const settlement = await buildSettlementInfo(deps.db, txId, oc);
    return ProposalTerminalSchema.parse({
      tx_id: txId,
      status: "TERMINAL",
      outcome: { outcome: "APPROVED", cart_mandate: mandate, settlement },
      rules_version_applied: rulesVersion,
      finished_at: finishedAt,
    });
  }

  if (outcome === "DECLINED") {
    const raw = Array.isArray(oc.decline_reasons) ? (oc.decline_reasons as Record<string, unknown>[]) : [];
    const reasons =
      raw.length > 0
        ? raw.map((r) => ({
            rule_id: String(r.rule_id ?? "GATEKEEPER_DECLINE"),
            message: String(r.message ?? "declined"),
            ...(r.reason_code !== undefined ? { reason_code: String(r.reason_code) } : {}),
            ...(Array.isArray(r.evidence_refs) ? { evidence_refs: (r.evidence_refs as string[]) } : {}),
          }))
        : [{ rule_id: "GATEKEEPER_DECLINE", message: "proposal declined by the gatekeeper" }];
    return ProposalTerminalSchema.parse({
      tx_id: txId,
      status: "TERMINAL",
      outcome: { outcome: "DECLINED", decline_reasons: reasons },
      rules_version_applied: rulesVersion,
      finished_at: finishedAt,
    });
  }

  if (outcome === "ESCALATED") {
    const approval = await buildApprovalRequest(deps.db, txId, String(oc.approval_id ?? ""));
    return ProposalTerminalSchema.parse({
      tx_id: txId,
      status: "TERMINAL",
      outcome: {
        outcome: "ESCALATED",
        approval_request: approval,
        expires_at: approval.expires_at,
      },
      rules_version_applied: rulesVersion,
      finished_at: finishedAt,
    });
  }

  // FAILED — honest infra death (§5.2 deliberate extension).
  const failure = (oc.failure ?? {}) as Record<string, unknown>;
  const stage =
    typeof failure.stage === "string" && PROPOSAL_STAGE_SET.has(failure.stage)
      ? failure.stage
      : PROPOSAL_STAGE_SET.has(tx.stage)
        ? tx.stage
        : "SETTLING";
  return ProposalTerminalSchema.parse({
    tx_id: txId,
    status: "TERMINAL",
    outcome: {
      outcome: "FAILED",
      failure: {
        stage,
        reason: String(failure.reason ?? "internal failure"),
        retryable: Boolean(failure.retryable ?? false),
      },
    },
    rules_version_applied: rulesVersion,
    finished_at: finishedAt,
  });
}

async function buildSettlementInfo(
  db: PgPool,
  txId: string,
  oc: Record<string, unknown>,
): Promise<unknown> {
  const r = await db.query(
    `SELECT t.state, t.provider_kind, t.paid_at, o.rzp_order_id
       FROM transactions t LEFT JOIN razorpay_orders o USING (tx_id)
      WHERE t.tx_id=$1`,
    [txId],
  );
  const row = (r.rows[0] ?? {}) as {
    state?: string;
    provider_kind?: string;
    paid_at?: string | null;
    rzp_order_id?: string | null;
  };
  const provider = row.provider_kind === "razorpay" ? "razorpay_test" : "mock";
  const orderId = row.rzp_order_id ?? String(oc.rzp_order_id ?? "");
  const paid = row.state === "PAID" || row.state === "COMPLETED";
  return {
    provider,
    razorpay_order_id: orderId,
    payment_status: paid ? "PAID" : "AWAITING_WEBHOOK",
    ...(paid && row.paid_at ? { paid_at: new Date(row.paid_at).toISOString() } : {}),
  };
}

async function buildApprovalRequest(db: PgPool, txId: string, approvalId: string): Promise<{
  approval_id: string;
  tx_id: string;
  reason: string;
  band_context: { observed: string; threshold: string };
  proposed_cart_snapshot: unknown;
  gate_trace_summary: unknown;
  created_at: string;
  expires_at: string;
  rules_version: number;
}> {
  const r = await db.query(
    `SELECT approval_id, tx_id, reason, band_context, frozen_proposal,
            gate_trace_summary, created_at, expires_at
       FROM approvals WHERE approval_id=$1`,
    [approvalId],
  );
  if ((r.rowCount ?? 0) === 0) {
    throw new HttpError(500, "INTERNAL_ERROR", "escalated tx has no approval row", { txId });
  }
  const a = r.rows[0] as {
    approval_id: string;
    tx_id: string;
    reason: string;
    band_context: Record<string, unknown>;
    frozen_proposal: { gatekeeper?: { ruleset_version?: number } };
    gate_trace_summary: unknown;
    created_at: string;
    expires_at: string;
  };
  const bc = a.band_context ?? {};
  return {
    approval_id: a.approval_id,
    tx_id: a.tx_id,
    reason: a.reason,
    band_context: {
      observed: String((bc as Record<string, unknown>).observed ?? ""),
      threshold: String((bc as Record<string, unknown>).threshold ?? ""),
    },
    proposed_cart_snapshot: a.frozen_proposal,
    gate_trace_summary: a.gate_trace_summary,
    created_at: new Date(a.created_at).toISOString(),
    expires_at: new Date(a.expires_at).toISOString(),
    rules_version: a.frozen_proposal.gatekeeper?.ruleset_version ?? 1,
  };
}
