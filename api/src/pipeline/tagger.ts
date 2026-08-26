/**
 * Deterministic heuristic injection tagger (api-contract.md §5.1 QUARANTINE
 * ZONE note, frontend-events.md InjectionFlagged payload). ZERO LLM trust —
 * plain regexes over the raw customer note, run at INTAKE before any model
 * sees the text. Output feeds three consumers:
 *   - the gatekeeper's InjectionSignal input (injectionGuard / repeatOffender),
 *   - the negotiation stage's NoteHeuristicTags (disclosed to the model),
 *   - the injection_flagged SSE event.
 *
 * Pure and versioned: tagger_version rides in every signal so audit trails
 * stay interpretable when the pattern list evolves.
 */
import type { InjectionSignal } from "@growthagent/shared";
import type { NoteHeuristicTags } from "@growthagent/shared";

export const TAGGER_VERSION = "heuristic-v1";

interface Pattern {
  readonly id: string;
  readonly re: RegExp;
  /** Weight toward the 0-100 risk score (deterministic, display only). */
  readonly weight: number;
}

const PATTERNS: readonly Pattern[] = [
  {
    // Fake authority: "system note", "admin confirmed", "official override".
    id: "SYSTEM_NOTE_SPOOF",
    re: /\b(system\s*note|admin\s*(confirmed|approved|says)|official\s*override|moderator\s*instruction)\b/i,
    weight: 40,
  },
  {
    // Discount tokens the merchant never issued ("EMPLOYEE50", "50% off").
    id: "DISCOUNT_OVERRIDE_TOKEN",
    re: /\b(employee\d{1,3}|staff\d{1,3}|promo[_-]?override|internal[_-]?code)\b|\b\d{1,2}\s*%\s*off\b/i,
    weight: 30,
  },
  {
    // Loyalty/reward fabrication.
    id: "LOYALTY_FABRICATION",
    re: /\b(loyalty\s+(override|points?\s+granted|reward\s+unlocked))\b/i,
    weight: 25,
  },
  {
    // Urgency/social pressure to skip checks.
    id: "URGENCY_BYPASS_PRESSURE",
    re: /\b(skip\s+(the\s+)?(checks?|validation)|no\s+need\s+to\s+verify|just\s+approve\s+it)\b/i,
    weight: 20,
  },
  {
    // Refund/compensation phishing inside a purchase intent.
    id: "REFUND_PHISHING",
    re: /\b(free\s+refund|compensate\s+me|gift\s+card\s+payout)\b/i,
    weight: 20,
  },
];

/** Trimmed match snippets for the UI's red banner (max 160 chars each). */
function snippetOf(note: string, m: RegExpExecArray): string {
  const start = Math.max(0, m.index - 20);
  const end = Math.min(note.length, m.index + m[0].length + 20);
  const s = (start > 0 ? "…" : "") + note.slice(start, end) + (end < note.length ? "…" : "");
  return s.slice(0, 160);
}

export interface TaggerOutput {
  readonly signal: InjectionSignal;
  readonly tags: NoteHeuristicTags;
}

/** Scan one customer note. Deterministic: same bytes ⇒ same output forever. */
export function scanCustomerNote(note: string): TaggerOutput {
  const hits: { pattern_id: string; snippet: string }[] = [];
  let risk = 0;
  for (const p of PATTERNS) {
    const m = p.re.exec(note);
    if (m !== null) {
      hits.push({ pattern_id: p.id, snippet: snippetOf(note, m) });
      risk += p.weight;
    }
  }
  return {
    signal: {
      suspected: hits.length > 0,
      risk_score: Math.min(100, risk),
      hits,
      tagger_version: TAGGER_VERSION,
    },
    tags: {
      injection_suspected: hits.length > 0,
      patterns: hits.map((h) => ({
        pattern_id: h.pattern_id,
        snippet_redacted: h.snippet,
      })),
    },
  };
}
