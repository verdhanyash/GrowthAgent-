/**
 * Settlement failure taxonomy (settlement.md §4/§5) — classified identically
 * in style to the sibling modules' four-way ladders
 * (catalog/enrichment.port.ts, explainer/narrator.port.ts):
 *
 *   CHAOS_FORCED        — chaos toggle carrier; breaks without retrying.
 *   RETRYABLE_EXHAUSTED — provider unavailable: timeouts / 5xx / network.
 *                         The M6 sweeper owns the receipt-retry ladder (§10.1);
 *        		         settle() itself never blind-retries a money move.
 *   PARSE_FAILED        — authenticated bytes / provider reply failed schema.
 *   NON_RETRYABLE       — everything else fails fast: provider rejections,
 *                         duplicate-receipt ambiguity, webhook auth failures,
 *                         domain refusals, and unknown error shapes.
 */
import {
  ChaosForcedGatewayError,
  ProviderParseError,
  ProviderUnavailableError,
} from "./provider/types.js";

export type SettlementFailureKind =
  | "RETRYABLE_EXHAUSTED"
  | "NON_RETRYABLE"
  | "PARSE_FAILED"
  | "CHAOS_FORCED";

export function classify(e: unknown): SettlementFailureKind {
  if (e instanceof ChaosForcedGatewayError) return "CHAOS_FORCED";
  if (e instanceof ProviderUnavailableError) return "RETRYABLE_EXHAUSTED";
  if (e instanceof ProviderParseError) return "PARSE_FAILED";
  // Every other typed error (ProviderRejectedError, DuplicateReceiptError,
  // WebhookAuthenticationError, domain refusals) plus UNKNOWN shapes fail fast.
  return "NON_RETRYABLE";
}
