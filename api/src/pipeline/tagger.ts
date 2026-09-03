/**
 * Deterministic heuristic injection tagger (api-contract.md §5.1 QUARANTINE
 * ZONE note, frontend-events.md InjectionFlagged payload). ZERO LLM trust —
 * plain regexes over the customer note, run at INTAKE before any model sees the
 * text. Output feeds three consumers:
 *   - the gatekeeper's InjectionSignal input (injectionGuard / repeatOffender),
 *   - the negotiation stage's NoteHeuristicTags (disclosed to the model),
 *   - the injection_flagged SSE event.
 *
 * v2 — EVASION FOLDING (audit §2). A regex list over raw bytes is trivially
 * side-stepped. "system note" with a U+200B zero-width space wedged inside it,
 * a Cyrillic-lookalike spelling, the fullwidth forms, and "EMPLOYEE" written with
 * fullwidth digits all read as the attack to a language model and as innocent
 * text to `/\bsystem\s*note\b/i`.
 * So every note is scanned TWICE: once as sent, and once through `foldEvasions`
 * (NFKC → drop zero-width/invisible → map homoglyphs → collapse spacing). A hit
 * in either pass counts, and folded hits are marked so the trace says which
 * pass caught it.
 *
 * This is still a HEURISTIC SPEED-BUMP, not a security boundary — semantic
 * paraphrase in any language will always get past a pattern list. The hard
 * backstop is the gatekeeper's arithmetic (discount cap, margin floor, cart
 * cap, totals drift), which does not read the note at all.
 *
 * Pure and versioned: tagger_version rides in every signal so audit trails
 * stay interpretable when the pattern list evolves.
 */
import type { InjectionSignal } from "@growthagent/shared";
import type { NoteHeuristicTags } from "@growthagent/shared";

export const TAGGER_VERSION = "heuristic-v2";

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

/**
 * Characters that carry no glyph but break every `\b`-anchored pattern:
 * zero-width space/non-joiner/joiner, LRM/RLM and friends, word joiner,
 * invisible separator/times/plus, BOM, and the soft hyphen.
 */
const INVISIBLE_RE =
  /[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g;

/**
 * Homoglyph folding table: Cyrillic and Greek letters that render (near-)
 * identically to Latin ones, plus the Cherokee/mathematical lookalikes that
 * show up in real evasion attempts. NFKC does NOT fold these — they are
 * distinct letters, not compatibility variants — so the mapping is explicit.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H",
  "К": "K", "М": "M", "О": "O", "Р": "P", "Т": "T",
  "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c",
  "у": "y", "х": "x", "і": "i", "ѕ": "s", "н": "h",
  "Α": "A", "Β": "B", "Ε": "E", "Η": "H", "Ι": "I",
  "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P",
  "Τ": "T", "Υ": "Y", "Χ": "X",
  "α": "a", "ε": "e", "ι": "i", "ο": "o", "ρ": "p",
  "υ": "u", "ν": "v", "χ": "x",
  "Ꭰ": "D", "Ꭺ": "H", "Ꮐ": "G", "Ꮮ": "P",
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
  "‘": "'", "’": "'", "“": '"', "”": '"',
};

/**
 * Collapse the cheap ways to hide a pattern from a regex, WITHOUT changing what
 * a human or a model reads:
 *   1. NFKC — fullwidth/ligature/superscript forms become their ASCII base, and
 *      NBSP becomes a normal space;
 *   2. drop invisible characters;
 *   3. map homoglyphs to their Latin twins;
 *   4. squeeze runs of whitespace and punctuation-as-separator to one space, so
 *      "system  .  note" and "system note" fold together.
 * Exported for tests and for anyone auditing what "folded" means.
 */
export function foldEvasions(note: string): string {
  return note
    .normalize("NFKC")
    .replace(INVISIBLE_RE, "")
    .replace(/[^\u0000-\u007f]/g, (ch) => HOMOGLYPHS[ch] ?? ch)
    .replace(/[\s\u00a0]+/g, " ");
}

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
  const folded = foldEvasions(note);
  const hits: { pattern_id: string; snippet: string; normalized?: boolean }[] = [];
  let risk = 0;
  for (const p of PATTERNS) {
    // Raw first so an honest note reports the bytes the customer actually sent;
    // the folded pass only speaks up when the raw pass missed.
    const direct = p.re.exec(note);
    if (direct !== null) {
      hits.push({ pattern_id: p.id, snippet: snippetOf(note, direct) });
      risk += p.weight;
      continue;
    }
    if (folded === note) continue; // nothing was folded: no second chance to take
    const evasive = p.re.exec(folded);
    if (evasive !== null) {
      // Snippet comes from the FOLDED text (its indices are the folded ones) and
      // is flagged, so the trace never implies the customer typed these bytes.
      hits.push({ pattern_id: p.id, snippet: snippetOf(folded, evasive), normalized: true });
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
