/**
 * useProposalStatus — TanStack Query poll of GET /v1/carts/proposals/:txId. The
 * poll is AUTHORITATIVE for terminal state (the SSE stream is live narration but
 * can lag/reconnect); once the body reports status==="TERMINAL" we stop polling
 * and expose `isTerminal`, which the caller uses to flip the stream's `active`
 * flag false and shut the EventSource loop cleanly.
 */
import { useQuery } from "@tanstack/react-query";
import type { ProposalStatusResponse } from "@growthagent/shared";
import { pollProposal } from "../lib/api.js";

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
    // Poll until terminal, then stop. `refetchInterval` receives the query and
    // returns false to halt once the body is TERMINAL.
    refetchInterval: (query) => (query.state.data?.status === "TERMINAL" ? false : POLL_MS),
    refetchIntervalInBackground: true,
    staleTime: 0,
    retry: 2,
  });

  const data = q.data ?? null;
  return {
    data,
    isTerminal: data?.status === "TERMINAL",
    error: (q.error as Error | null) ?? null,
    isLoading: q.isLoading,
  };
}
