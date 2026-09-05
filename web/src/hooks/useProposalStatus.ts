/**
 * useProposalStatus — TanStack Query poll of GET /v1/carts/proposals/:txId. The
 * poll is AUTHORITATIVE for terminal state (the SSE stream is live narration but
 * can lag/reconnect); once the body reports status==="TERMINAL" we stop polling
 * and expose `isTerminal`, which the caller uses to flip the stream's `active`
 * flag false and shut the EventSource loop cleanly.
 */
import { useQuery } from "@tanstack/react-query";
import type { ProposalStatusResponse } from "@growthagent/shared";
import { pollProposal, ApiError } from "../lib/api.js";

export interface UseProposalStatusResult {
  data: ProposalStatusResponse | null;
  isTerminal: boolean;
  error: Error | null;
  isLoading: boolean;
}

const POLL_MS = 1200;

export function useProposalStatus(txId: string | null): UseProposalStatusResult {
  const q = useQuery({
    queryKey: ["proposal", txId],
    queryFn: () => pollProposal(txId as string),
    enabled: txId !== null,
    // Poll until terminal, then stop. Stop polling immediately if an error occurs.
    refetchInterval: (query) => {
      if (query.state.data?.status === "TERMINAL" || query.state.error !== null) {
        return false;
      }
      return POLL_MS;
    },
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (!error.retryable || error.status === 404)) {
        return false;
      }
      return failureCount < 1;
    },
  });

  const data = q.data ?? null;
  return {
    data,
    isTerminal: data?.status === "TERMINAL",
    error: (q.error as Error | null) ?? null,
    isLoading: q.isLoading,
  };
}
