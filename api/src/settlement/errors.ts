/**
 * Buyer-visible settlement refusals (settlement.md §12 behavior matrix):
 * every non-happy HTTP outcome of the settle path carries a stable machine
 * code; `retryable` marks the two ladders that may legitimately be retried.
 */
export class SettlementRejectedError extends Error {
  constructor(
    public readonly code: string,
    public readonly description: string,
    public readonly httpStatus: number,
    public readonly extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${description}`);
    this.name = "SettlementRejectedError";
  }
}
