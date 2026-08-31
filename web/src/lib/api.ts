/**
 * web/src/lib/api.ts — typed buyer-surface REST client.
 *
 * The only live HTTP surface (api route recon) is four routes under /v1:
 *   POST /v1/carts/proposals        → 202 ProposalAccepted
 *   GET  /v1/carts/proposals/:txId  → 200 ProposalStatusResponse (pending|terminal)
 *   POST /v1/stream-tickets         → 200 StreamTicketResponse
 *   GET  /v1/stream/:txId?ticket=   → SSE (opened by useTransactionStream, not here)
 *
 * Every call authenticates with X-Agent-Key. Responses are validated against
 * the shared zod contracts so the UI can never render an off-contract body.
 */
import {
  CreateProposalRequestSchema,
  ProposalAcceptedSchema,
  ProposalStatusResponse,
  StreamTicketResponseSchema,
  type CreateProposalRequest,
  type ProposalAccepted,
  type ProposalStatusResponse as ProposalStatus,
  type StreamTicketResponse,
} from "@growthagent/shared";
import { API_BASE, getAgentKey } from "./config.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface WireError {
  error?: { code?: string; message?: string; retryable?: boolean };
}

async function request<T>(
  path: string,
  init: RequestInit,
  parse: (body: unknown) => T,
): Promise<T> {
  const key = getAgentKey();
  if (key === "") throw new ApiError(0, "NO_AGENT_KEY", "no agent key configured");
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-agent-key": key,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const json: unknown = text === "" ? {} : JSON.parse(text);
  if (!res.ok) {
    const e = (json as WireError).error;
    throw new ApiError(res.status, e?.code ?? "HTTP_ERROR", e?.message ?? res.statusText, e?.retryable ?? false);
  }
  return parse(json);
}

/** POST /v1/carts/proposals — async job start; returns tx_id + urls. */
export async function createProposal(body: CreateProposalRequest): Promise<ProposalAccepted> {
  const validated = CreateProposalRequestSchema.parse(body);
  return request(
    "/v1/carts/proposals",
    { method: "POST", body: JSON.stringify(validated) },
    (b) => ProposalAcceptedSchema.parse(b),
  );
}

/** GET /v1/carts/proposals/:txId — poll pending vs terminal outcome. */
export async function pollProposal(txId: string): Promise<ProposalStatus> {
  return request(
    `/v1/carts/proposals/${encodeURIComponent(txId)}`,
    { method: "GET" },
    (b) => ProposalStatusResponse.parse(b),
  );
}

/** POST /v1/stream-tickets — mint a short-lived ticket bound to {agent, tx}. */
export async function mintStreamTicket(txId: string): Promise<StreamTicketResponse> {
  return request(
    "/v1/stream-tickets",
    { method: "POST", body: JSON.stringify({ tx_id: txId }) },
    (b) => StreamTicketResponseSchema.parse(b),
  );
}

/** Build the SSE URL for a tx with a freshly-minted ticket in the query. */
export function streamUrl(txId: string, ticket: string, lastEventId?: number): string {
  const q = new URLSearchParams({ ticket });
  if (lastEventId !== undefined && lastEventId > 0) q.set("lastEventId", String(lastEventId));
  return `${API_BASE}/v1/stream/${encodeURIComponent(txId)}?${q.toString()}`;
}
