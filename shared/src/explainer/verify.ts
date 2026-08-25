/**
 * Narration verification (frontend-events.md §4.4 item 6 — the prompt-side
 * contract made ENFORCEABLE). The model's output is untrusted prose; these
 * pure checks decide whether it may ship:
 *
 *  Rule G (grounding): every seq in grounded_on_events must exist in the
 *   fact skeleton handed to the model, and at least one must be referenced —
 *   a fabricated or empty grounding is a compliance failure, not a typo
 *   (whole narrative rejected; the rejected text is preserved for the trail).
 *
 *  Rule Q (untrusted restatement): buyer/customer-note strings may appear
 *   ONLY inside quoted mono spans prefixed `buyer claim —`. Any verbatim-ish
 *   occurrence outside such a span restates attacker-controlled text as fact
 *   → rejected. Strings too short to fingerprint (< MIN_UNTRUSTED_LEN) are
 *   exempt from the scan — they cannot carry an injection payload.
 *
 * PURE: no clock, no randomness, no IO.
 */
import type { NarrativeOutput } from "./schema.js";

export const BUYER_CLAIM_PREFIX = "buyer claim —";
/** Below this length a needle is too generic to fingerprint reliably. */
export const MIN_UNTRUSTED_LEN = 12;

export type NarrationRejection =
  | "EMPTY_GROUNDING"
  | "GROUNDING_FABRICATED"
  | "UNTRUSTED_RESTATED";

export interface VerifyContext {
  /** Seqs actually present in the fact skeleton given to the model. */
  readonly candidateSeqs: ReadonlySet<number>;
  /** Buyer-visible untrusted strings (request lines, customer note). */
  readonly untrustedTexts: readonly string[];
}

export type NarrationVerifyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly rejection: NarrationRejection;
      /** Human-readable detail for the audit event / llm_calls row. */
      readonly detail: string;
    };

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Lookbehind window for the buyer-claim prefix. Generous on purpose: an
 *  exact-length window chops the prefix's first char when the quote begins
 *  immediately after `prefix "` (off-by-one laundering hole otherwise). */
const PREFIX_LOOKBEHIND = 40;

/**
 * Finds the first occurrence of `needle` in `haystack` that is NOT preceded
 * by the buyer-claim quote prefix. Whitespace-collapsed matching so line
 * wraps cannot launder a restatement.
 */
function firstUnquotedOccurrence(
  haystack: string,
  needle: string,
): number | null {
  const h = collapse(haystack).toLowerCase();
  const n = collapse(needle).toLowerCase();
  let from = 0;
  for (;;) {
    const at = h.indexOf(n, from);
    if (at === -1) return null;
    const windowStart = Math.max(0, at - PREFIX_LOOKBEHIND);
    const window = h.slice(windowStart, at);
    if (!window.includes(BUYER_CLAIM_PREFIX.toLowerCase())) return at;
    from = at + 1;
  }
}

export function verifyNarration(
  output: NarrativeOutput,
  ctx: VerifyContext,
): NarrationVerifyResult {
  // Rule G: non-empty + no fabricated seqs.
  if (output.grounded_on_events.length === 0) {
    return { ok: false, rejection: "EMPTY_GROUNDING", detail: "no seqs cited" };
  }
  const unknown = output.grounded_on_events.filter(
    (seq) => !ctx.candidateSeqs.has(seq),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      rejection: "GROUNDING_FABRICATED",
      detail: `cited seq(s) not in fact skeleton: ${unknown.join(", ")}`,
    };
  }

  // Rule Q: untrusted text only inside `buyer claim —` spans.
  for (const t of ctx.untrustedTexts) {
    if (collapse(t).length < MIN_UNTRUSTED_LEN) continue;
    const at = firstUnquotedOccurrence(output.body_md, t);
    if (at !== null) {
      return {
        ok: false,
        rejection: "UNTRUSTED_RESTATED",
        detail: `untrusted text appears outside a "${BUYER_CLAIM_PREFIX}" span near offset ${at}`,
      };
    }
  }

  return { ok: true };
}
