/**
 * Deterministic rationale verifier (campaign.md §8.1). The LLM's only job is
 * phrasing; this is the check that keeps it honest. Matching runs on a
 * NORMALIZED form so trivial typography can't cause false rejects, while any
 * semantic invention still trips.
 *
 * Deliberate consequences, each pinned by a unit test:
 *  • "46% slower than peers" vs display "0.46x" → INVENTED_NUMBER (the
 *    fabrication class we care about: numerically faithful-looking,
 *    representationally unauthorized).
 *  • Restating a metric twice is fine — Rule 2 checks membership, not counts.
 *  • SKU codes carry digits ("KAJU_KATLI_250G"): the whole identifier is
 *    stripped before numeric scanning (names ≠ quantities — same rule as the
 *    negotiation auditor's scanner), so naming a SKU never fabricates a
 *    number; a residual unit suffix ("500g") is also removed.
 *  • Dates pass because the expiry metric's display IS that date string.
 */
import type { Opportunity } from "@growthagent/shared";
import type { EntryDraft } from "../domain/derive.js";

export function normalizeForMatch(s: string): string {
  return s
    // SKU-like identifiers are NAMES, not quantities — strip before any
    // numeric scan (mirrors audit.ts extractNumbers' gatekeeper-shape rule;
    // also swallows action words like PROMOTE_PAIR harmlessly). Without this,
    // an honest rationale naming KAJU_KATLI_250G trips INVENTED_NUMBER on the
    // phantom token 250.
    .replace(/\b[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+\b/g, "")
    .toLowerCase()
    .replace(/₹/g, "") // rupee sign
    .replace(/,/g, "") // Indian digit grouping 1,23,456 -> 123456
    .replace(/−/g, "-") // unicode minus
    .replace(/[₀-₉]/g, (d) =>
      String((d.codePointAt(0) ?? 0) - 0x2080),
    ) // subscript digits
    .replace(/(?<=\d)(?:g|kg|ml|gm)\b/g, "") // residual unit suffixes
    .replace(/\s+/g, " ")
    .trim();
}

const NUMERIC_TOKEN = /\d+(?:\.\d+)?/g;

/**
 * Numbers legitimately present besides metrics: entry weights and the raw
 * (unformatted) metric values tolerated alongside their displays.
 */
function allowedNumericTokens(
  opp: Opportunity,
  entry: EntryDraft,
): Set<string> {
  const s = new Set<string>();
  for (const m of opp.metrics) {
    for (const t of normalizeForMatch(m.display).match(NUMERIC_TOKEN) ?? []) {
      s.add(t);
    }
    s.add(String(m.value)); // raw value tolerated alongside display
  }
  s.add(entry.weight.toFixed(2));
  return s;
}

export type Verdict = "VERIFIED" | "MISSING_METRIC" | "INVENTED_NUMBER";

export function verifyRationale(
  opp: Opportunity,
  entry: EntryDraft,
  rationale: string,
): Verdict {
  const norm = normalizeForMatch(rationale);

  // Rule 1 — completeness: EVERY metric display must appear verbatim-normalized.
  for (const m of opp.metrics) {
    if (!norm.includes(normalizeForMatch(m.display))) return "MISSING_METRIC";
  }

  // Rule 2 — no invention: every number in the text must be accounted for.
  const allowed = allowedNumericTokens(opp, entry);
  for (const t of norm.match(NUMERIC_TOKEN) ?? []) {
    if (!allowed.has(t)) return "INVENTED_NUMBER";
  }
  return "VERIFIED";
}
