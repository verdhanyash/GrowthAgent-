/**
 * CATALOG_CONFIG — every catalog-intelligence-agent knob. Mirrors the
 * campaign config's ownership rule: nothing may hardcode a value found here
 * elsewhere.
 */
export const CATALOG_CONFIG = {
  // -- closed occasion vocabulary (data-model-audit.md §2.5 column comment).
  // Anything outside this set is DROPPED with an UNKNOWN_OCCASION warning,
  // never a hard failure — marketing copy degrades partially, not fatally.
  closedOccasions: [
    "birthday",
    "anniversary",
    "diwali",
    "rakhi",
    "congrats",
  ] as const,

  // -- field caps (mirror negotiation.md payload caps + §2.5 columns)
  maxTags: 10,
  maxOccasions: 6,
  maxPairings: 6,
  maxWarnings: 8,

  // -- LLM
  enrichmentModel: "meta/llama-3.3-70b-instruct" as const,
  enrichmentMaxTokens: 2048,
  enrichmentTimeoutMs: 30_000,

  // -- retry ladder: identical ownership stance as the campaign rationale
  // ladder — SDK client maxRetries: 0, ours attempts=2 + backoff, injectable
  // timing for deterministic tests.
  enrichmentAttempts: 2,
  enrichmentBackoffBaseMs: 500,
} as const;
