/**
 * web/src/lib/admin-api.ts — typed REST client for the admin/demo control plane.
 *
 * Interacts with /v1/admin/* and /v1/demo/* endpoints:
 *  - Approvals inbox & resolution
 *  - Live MerchantRules inspection, patch & history
 *  - Agent identity list & revocation
 *  - Chaos flags management
 *  - Scenario runner & verdicts
 *  - Pristine demo reset
 *  - Analytics aggregates & the transaction index
 */
import {
  AdminAgentsResponseSchema,
  AnalyticsResponseSchema,
  AuditReplaySchema,
  TxListResponseSchema,
  AdminRulesResponseSchema,
  ApprovalResolvedSchema,
  ApprovalRequestSchema,
  ChaosStateResponseSchema,
  DemoResetResponseSchema,
  RulesHistoryResponseSchema,
  ScenarioAcceptedSchema,
  ScenarioRunResultSchema,
  type AdminAgent,
  type AdminRulesResponse,
  type AnalyticsResponse,
  type AnalyticsWindow,
  type AuditReplay,
  type OutcomeKind,
  type TxListResponse,
  type ApprovalRequest,
  type ApprovalResolved,
  type ArmedChaos,
  type ChaosFlag,
  type DemoResetResponse,
  type RulesHistoryEntry,
  type ScenarioAccepted,
  type ScenarioName,
  type ScenarioRunResult,
} from "@growthagent/shared";
import { z } from "zod";
import { API_BASE, getAdminToken } from "./config.js";
import { ApiError } from "./api.js";

const ApprovalsInboxResponseSchema = z.object({ approvals: z.array(ApprovalRequestSchema) });

interface WireError {
  error?: { code?: string; message?: string; retryable?: boolean };
}

async function adminRequest<T>(
  path: string,
  init: RequestInit,
  parse: (body: unknown) => T,
): Promise<T> {
  const token = getAdminToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token !== "" ? { "x-admin-token": token } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  const json: unknown = text === "" ? {} : JSON.parse(text);

  if (!res.ok) {
    const e = (json as WireError).error;
    throw new ApiError(
      res.status,
      e?.code ?? "ADMIN_HTTP_ERROR",
      e?.message ?? res.statusText,
      e?.retryable ?? false,
    );
  }

  return parse(json);
}

/* ---------------------------- Approvals ---------------------------- */

export async function fetchApprovals(status?: "PENDING" | "RESOLVED"): Promise<ApprovalRequest[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return adminRequest(
    `/v1/admin/approvals${q}`,
    { method: "GET" },
    (b) => ApprovalsInboxResponseSchema.parse(b).approvals,
  );
}

export async function approveApproval(
  approvalId: string,
  note?: string,
  confirmRulesVersion?: number,
): Promise<ApprovalResolved> {
  const body: Record<string, unknown> = {};
  if (note !== undefined && note.trim() !== "") body.approver_note = note.trim();
  if (confirmRulesVersion !== undefined) body.confirm_rules_version = confirmRulesVersion;

  return adminRequest(
    `/v1/admin/approvals/${encodeURIComponent(approvalId)}/approve`,
    { method: "POST", body: JSON.stringify(body) },
    (b) => ApprovalResolvedSchema.parse(b),
  );
}

export async function rejectApproval(
  approvalId: string,
  note?: string,
): Promise<ApprovalResolved> {
  const body: Record<string, unknown> = {};
  if (note !== undefined && note.trim() !== "") body.approver_note = note.trim();

  return adminRequest(
    `/v1/admin/approvals/${encodeURIComponent(approvalId)}/reject`,
    { method: "POST", body: JSON.stringify(body) },
    (b) => ApprovalResolvedSchema.parse(b),
  );
}

/* ------------------------------ Rules ------------------------------ */

export async function fetchRules(): Promise<AdminRulesResponse> {
  return adminRequest(
    "/v1/admin/rules",
    { method: "GET" },
    (b) => AdminRulesResponseSchema.parse(b),
  );
}

export async function updateRules(
  patch: Record<string, unknown>,
  expectedVersion: number,
  confirmIncrease?: boolean,
  note?: string,
): Promise<AdminRulesResponse> {
  const body: Record<string, unknown> = {
    patch,
    expected_version: expectedVersion,
    ...(confirmIncrease ? { confirm_increase: true } : {}),
    ...(note !== undefined && note.trim() !== "" ? { note: note.trim() } : {}),
  };

  return adminRequest(
    "/v1/admin/rules",
    { method: "PUT", body: JSON.stringify(body) },
    (b) => AdminRulesResponseSchema.parse(b),
  );
}

export async function fetchRulesHistory(): Promise<RulesHistoryEntry[]> {
  return adminRequest(
    "/v1/admin/rules/history",
    { method: "GET" },
    (b) => RulesHistoryResponseSchema.parse(b).history,
  );
}

/* ------------------------------ Agents ------------------------------ */

export async function fetchAgents(): Promise<AdminAgent[]> {
  return adminRequest(
    "/v1/admin/agents",
    { method: "GET" },
    (b) => AdminAgentsResponseSchema.parse(b).agents,
  );
}

export async function revokeAgent(agentId: string, reason?: string): Promise<AdminAgent> {
  const body: Record<string, unknown> = {};
  if (reason !== undefined && reason.trim() !== "") body.reason = reason.trim();

  return adminRequest(
    `/v1/admin/agents/${encodeURIComponent(agentId)}/revoke`,
    { method: "POST", body: JSON.stringify(body) },
    (b) => b as AdminAgent,
  );
}

/* ------------------------------ Chaos ------------------------------ */

export async function fetchChaos(): Promise<ArmedChaos[]> {
  return adminRequest(
    "/v1/demo/chaos",
    { method: "GET" },
    (b) => ChaosStateResponseSchema.parse(b).armed,
  );
}

export async function armChaos(
  flag: ChaosFlag,
  txIds?: string[],
  ttlMinutes = 10,
): Promise<ArmedChaos[]> {
  const body: Record<string, unknown> = {
    flag,
    ttl_minutes: ttlMinutes,
    ...(txIds && txIds.length > 0 ? { scope: { tx_ids: txIds } } : {}),
  };

  return adminRequest(
    "/v1/demo/chaos",
    { method: "PUT", body: JSON.stringify(body) },
    (b) => ChaosStateResponseSchema.parse(b).armed,
  );
}

export async function disarmChaos(): Promise<ArmedChaos[]> {
  return adminRequest(
    "/v1/demo/chaos",
    { method: "DELETE" },
    (b) => ChaosStateResponseSchema.parse(b).armed,
  );
}

/* ---------------------------- Scenarios ---------------------------- */

export async function runScenario(
  name: ScenarioName,
  agentAlias?: string,
): Promise<ScenarioAccepted> {
  const body: Record<string, unknown> = {};
  if (agentAlias !== undefined && agentAlias.trim() !== "") {
    body.overrides = { agent_alias: agentAlias.trim() };
  }

  return adminRequest(
    `/v1/demo/scenarios/${encodeURIComponent(name)}`,
    { method: "POST", body: JSON.stringify(body) },
    (b) => ScenarioAcceptedSchema.parse(b),
  );
}

export async function fetchScenarioRun(runId: string): Promise<ScenarioRunResult> {
  return adminRequest(
    `/v1/demo/scenarios/runs/${encodeURIComponent(runId)}`,
    { method: "GET" },
    (b) => ScenarioRunResultSchema.parse(b),
  );
}

/* ------------------------------ Reset ------------------------------ */

export async function resetDemo(force = false): Promise<DemoResetResponse> {
  return adminRequest(
    "/v1/demo/reset",
    { method: "POST", body: JSON.stringify({ confirm: true, force }) },
    (b) => DemoResetResponseSchema.parse(b),
  );
}

/* ---------------------------- Analytics ---------------------------- */

/** GET /v1/admin/analytics — every figure aggregated in SQL from real rows. */
export async function fetchAnalytics(window: AnalyticsWindow): Promise<AnalyticsResponse> {
  return adminRequest(
    `/v1/admin/analytics?window=${encodeURIComponent(window)}`,
    { method: "GET" },
    (b) => AnalyticsResponseSchema.parse(b),
  );
}

/** GET /v1/admin/transactions — the operational index behind the trace screen. */
export async function fetchTransactions(opts: {
  outcome?: OutcomeKind | "ALL";
  q?: string;
  limit?: number;
} = {}): Promise<TxListResponse> {
  const params = new URLSearchParams();
  if (opts.outcome !== undefined && opts.outcome !== "ALL") params.set("outcome", opts.outcome);
  if (opts.q !== undefined && opts.q.trim() !== "") params.set("q", opts.q.trim());
  params.set("limit", String(opts.limit ?? 50));

  return adminRequest(
    `/v1/admin/transactions?${params.toString()}`,
    { method: "GET" },
    (b) => TxListResponseSchema.parse(b),
  );
}

/** GET /v1/admin/audit/:txId/replay — tamper-evident hash-chain replay. */
export async function fetchAuditReplay(txId: string, deep = false): Promise<AuditReplay> {
  return adminRequest(
    `/v1/admin/audit/${encodeURIComponent(txId)}/replay${deep ? "?deep=true" : ""}`,
    { method: "GET" },
    (b) => AuditReplaySchema.parse(b),
  );
}

