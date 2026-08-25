/**
 * auditCitations — the deterministic Citation Auditor (negotiation.md §4).
 * PURE: zero IO, zero LLM, no clock reads (audited_at is injected). Re-runnable
 * by the replay endpoint years later against the snapshotted pack.
 *
 * Philosophy (§4.1): checks TRACEABILITY and FABRICATION, never policy. A
 * high-but-real campaign discount is CLEAN here and the gatekeeper's problem
 * next; a beautifully argued cart resting on one invented statistic dies here.
 */
import type {
  EvidencePackContainer,
  EvidencePackEntry,
} from "../schemas.js";
import type { NegotiationProposal } from "./proposal.schema.js";
import {
  deriveNumericFacts,
  type FactUnit,
  type NumericFact,
} from "../evidence/facts.js";

export type CitationVerdict = "CLEAN" | "STRIPPED" | "FAILED";

export type ViolationCode =
  | "DANGLING_EVIDENCE_ID" // cited id not in pack
  | "KIND_MISMATCH" // claim.kind != kinds of cited entries
  | "NUMERIC_MISMATCH" // a number in statement not derivable from cited payloads
  | "UNSUPPORTED_DISCOUNT_CLAIM" // discount-context % with no campaign-priority backing
  | "GROSS_FABRICATION" // mismatched value > 3x max same-kind cited fact
  | "UNKNOWN_SKU" // proposed sku absent from pack PRICE entries
  | "STOCK_OVERDRAW" // line qty > STOCK available_qty (§4.2 stage 1b)
  | "PRIORITY_REF_MISMATCH"; // priority id not in tx snapshot (§4.2 stage 2b)

export interface CitationViolation {
  readonly code: ViolationCode;
  readonly claim_index: number | null;
  readonly evidence_id: string | null;
  /** Deterministic, includes the offending token/value. */
  readonly detail: string;
  readonly money_relevant: boolean;
}

export interface CitationAuditResult {
  readonly tx_id: string;
  readonly pack_hash: string;
  readonly verdict: CitationVerdict;
  readonly violations: readonly CitationViolation[];
  /** null iff FAILED (proposal discarded wholesale). */
  readonly effective_proposal: NegotiationProposal | null;
  readonly flags: {
    readonly unsupported_discount_claim: boolean;
    /** A stripped claim's statement overlaps note n-grams. */
    readonly injection_echo_suspected: boolean;
  };
  readonly audited_at: string; // sim clock, injected — excluded from equality checks
}

export interface Tolerances {
  /** RUPEE float-rendering slack. */
  readonly rupeeSlack: number;
  /** PCT absolute slack ("about 47%" vs 47.30 passes). */
  readonly pctSlack: number;
  /** COUNT round-DOWN allowance ("over 40 orders" vs 42); never up. */
  readonly countRoundDownMax: number;
  /** DEC1 absolute slack. */
  readonly decSlack: number;
  /** Non-money token exceeding 3x the max same-unit cited fact → GROSS_FABRICATION. */
  readonly grossMultiplier: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  rupeeSlack: 0.01,
  pctSlack: 0.05,
  countRoundDownMax: 5,
  decSlack: 0.05,
  grossMultiplier: 3,
};

export interface AuditOptions {
  readonly tolerances?: Partial<Tolerances>;
  /** Transaction id echoed into the result (the pack does not carry it). */
  readonly tx_id: string;
  /** Sim-clock instant for the result stamp. REQUIRED from the caller — this
   *  function owns no clock. */
  readonly audited_at: string;
  /** Raw customer note for injection-echo n-gram overlap on stripped claims. */
  readonly customer_note_raw?: string | undefined;
  /** When false, PRICE cost figures leave the derivable set (§4.3 note): the
   *  model cannot cite a number it was never shown. Defaults true. */
  readonly include_costs?: boolean | undefined;
}

/* ----------------------- number extraction (§4.4) ----------------------- */

export interface NumberToken {
  readonly value: number;
  readonly unit: FactUnit;
  /** Char offset of the numeric run inside the statement. */
  readonly at: number;
}

const DISCOUNT_WORDS = /\b(?:off|discount|coupon|promo|loyalty)\b/i;

/**
 * Deterministic scanner. Pre-strips evidence ids (E001), SKU-like uppercase
 * tokens containing a separator (CAKE-CHOC-500 — canonical SKU shapes carry
 * digits that are NOT quantities; NORMALIZATION: negotiation.md sketched
 * `SKU-*` prefixes, §18 adopted the gatekeeper shape), and ISO dates. A `\b`
 * guards the digit run so alnumend identifiers like EMPLOYEE50 never emit a
 * phantom token. Indian digit grouping ("13,88,860") parses via comma-strip.
 */
export function extractNumbers(statement: string): NumberToken[] {
  let s = statement.replace(/E\d{3}/g, "");
  s = s.replace(/\b[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+\b/g, ""); // SKU-like
  s = s.replace(/\d{4}-\d{2}-\d{2}/g, "");
  const tokens: NumberToken[] = [];
  const re = /(?:₹|Rs\.?|INR)?\s?\b(\d[\d,]*(?:\.\d+)?)\s?(%)?/gi;
  for (const m of s.matchAll(re)) {
    const raw = m[1] ?? "";
    const value = Number.parseFloat(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const unit: FactUnit = m[2] !== undefined ? "PCT" : m[0]?.match(/₹|Rs\.?|INR/i) ? "RUPEE" : "COUNT";
    tokens.push({ value, unit, at: m.index ?? 0 });
  }
  return tokens;
}

/** True when a discount-flavored word sits near the token (±40 chars). */
export function isDiscountContext(statement: string, tok: NumberToken): boolean {
  const lo = Math.max(0, tok.at - 40);
  const hi = Math.min(statement.length, tok.at + 40);
  return DISCOUNT_WORDS.test(statement.slice(lo, hi));
}

/* --------------------------- tolerance rules ---------------------------- */

function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** §4.5 — plus the derived-total allowance for RUPEE tokens (§4.5 tail):
 *  a RUPEE token additionally matches the summed list prices of DISTINCT cited
 *  PRICE entries ("together listed at ₹948"). Post-discount totals are never
 *  derivable (R3 forbids model arithmetic; settlement owns math). */
function matchesAny(
  facts: readonly NumericFact[],
  tok: NumberToken,
  citedPriceRupeeSum: number | null,
  tol: Tolerances,
): boolean {
  switch (tok.unit) {
    case "PAISE":
      return facts.some((f) => f.unit === "PAISE" && f.value === tok.value);
    case "RUPEE": {
      if (
        facts.some(
          (f) => f.unit === "RUPEE" && Math.abs(tok.value - f.value) <= tol.rupeeSlack,
        )
      ) {
        return true;
      }
      return (
        citedPriceRupeeSum !== null &&
        Math.abs(tok.value - citedPriceRupeeSum) <= tol.rupeeSlack
      );
    }
    case "PCT":
      return facts.some(
        (f) =>
          f.unit === "PCT" &&
          (Math.abs(tok.value - f.value) <= tol.pctSlack ||
            tok.value === roundHalfUp(f.value)),
      );
    case "COUNT":
      return facts.some(
        (f) =>
          f.unit === "COUNT" &&
          (f.value === tok.value ||
            (tok.value <= f.value && f.value - tok.value <= tol.countRoundDownMax)),
      );
    case "DEC1":
      return facts.some(
        (f) => f.unit === "DEC1" && Math.abs(tok.value - f.value) <= tol.decSlack,
      );
  }
}

/* ------------------------------ the auditor ----------------------------- */

export function auditCitations(
  proposal: NegotiationProposal,
  pack: EvidencePackContainer,
  opts: AuditOptions,
): CitationAuditResult {
  const tol: Tolerances = { ...DEFAULT_TOLERANCES, ...(opts.tolerances ?? {}) };
  const idx = new Map<string, EvidencePackEntry>(
    pack.entries.map((e) => [e.id, e]),
  );

  const violations: CitationViolation[] = [];
  const stripClaim = new Set<number>();
  let unsupportedDiscount = false;

  const isPriceSku = new Map<string, string>(); // sku -> entry id
  const stockBySku = new Map<string, EvidencePackEntry>();
  for (const e of pack.entries) {
    if (e.kind === "PRICE" && e.sku !== null && !isPriceSku.has(e.sku)) {
      isPriceSku.set(e.sku, e.id);
    }
    if (e.kind === "STOCK" && e.sku !== null && !stockBySku.has(e.sku)) {
      stockBySku.set(e.sku, e);
    }
  }

  /* -- Stage 1: SKU existence ------------------------------------------ */
  for (const item of proposal.proposed_items) {
    if (!isPriceSku.has(item.sku)) {
      violations.push({
        code: "UNKNOWN_SKU",
        claim_index: null,
        evidence_id: null,
        detail: `proposed sku ${item.sku} absent from pack PRICE entries`,
        money_relevant: true,
      });
    }
  }

  /* -- Stage 1b: quantity-vs-stock relation ----------------------------- */
  for (const item of proposal.proposed_items) {
    const st = stockBySku.get(item.sku);
    if (!st || st.payload.kind !== "STOCK") continue;
    if (item.qty > st.payload.payload.available_qty) {
      violations.push({
        code: "STOCK_OVERDRAW",
        claim_index: null,
        evidence_id: st.id,
        detail: `qty ${item.qty} > available_qty ${st.payload.payload.available_qty}`,
        money_relevant: true,
      });
    }
  }

  /* -- Stage 2: per-claim reconciliation -------------------------------- */
  for (let i = 0; i < proposal.claims.length; i++) {
    const c = proposal.claims[i];
    if (!c) continue;

    const resolved: EvidencePackEntry[] = [];
    const dangling: string[] = [];
    const seenIds = new Set<string>();
    for (const eid of c.evidence_ids) {
      if (seenIds.has(eid)) continue; // duplicate ids deduped silently (A14)
      seenIds.add(eid);
      const hit = idx.get(eid);
      if (hit) resolved.push(hit);
      else dangling.push(eid);
    }
    for (const eid of dangling) {
      violations.push({
        code: "DANGLING_EVIDENCE_ID",
        claim_index: i,
        evidence_id: eid,
        detail: `cited id ${eid} does not exist in pack ${pack.pack_hash.slice(0, 12)}…`,
        money_relevant: false,
      });
    }
    // A claim whose citations ALL dangle has nothing backing it — strip whole
    // claim (matrix A5, §5.1 archetype 3).
    if (dangling.length > 0) {
      stripClaim.add(i);
      if (resolved.length === 0) continue;
    }

    const kinds = new Set(resolved.map((e) => e.kind));
    if (resolved.length > 0 && (kinds.size > 1 || !kinds.has(c.kind))) {
      violations.push({
        code: "KIND_MISMATCH",
        claim_index: i,
        evidence_id: null,
        detail: `claim.kind ${c.kind} vs cited kinds {${[...kinds].sort().join(", ")}}`,
        money_relevant: false,
      });
      stripClaim.add(i);
      continue;
    }

    // Union of derivable facts across resolved entries; optional cost redaction.
    const facts: NumericFact[] = [];
    for (const e of resolved) {
      for (const f of deriveNumericFacts(e.payload)) {
        if (
          opts.include_costs === false && // default (undefined) keeps costs — §4.3 "defaults true"
          e.kind === "PRICE" &&
          f.name.startsWith("cost") // cost_paise AND its rupee mirror
        ) {
          continue;
        }
        facts.push(f);
      }
    }
    // Derived-total allowance input: distinct cited PRICE entries' list sum.
    const priceEntries = resolved.filter((e) => e.kind === "PRICE");
    const citedPriceRupeeSum =
      priceEntries.length > 0
        ? priceEntries.reduce((s, e) => {
            const p =
              e.payload.kind === "PRICE" ? e.payload.payload.list_price_paise : 0;
            return s + p;
          }, 0) / 100
        : null;

    for (const t of extractNumbers(c.statement)) {
      if (isDiscountContext(c.statement, t)) {
        const camps = resolved.filter((e) => e.kind === "CAMPAIGN_PRIORITY");
        if (camps.length === 0) {
          // NORMALIZATION (documented): matrix row A12 pins FAILED for an
          // unsupported discount claim, while §4.2 pseudocode + §4.6 mark it
          // recoverable. We follow the PSEUDOCODE + VERDICT-TABLE majority:
          // strip the claim, keep the cart — the auditor removes lies from the
          // narrative, the GATEKEEPER owns discount policy (§4.1 layering).
          violations.push({
            code: "UNSUPPORTED_DISCOUNT_CLAIM",
            claim_index: i,
            evidence_id: null,
            detail: `token ${t.value}${t.unit === "PCT" ? "%" : ""} used in discount context with no CAMPAIGN_PRIORITY citation`,
            money_relevant: true,
          });
          unsupportedDiscount = true;
          stripClaim.add(i);
          continue;
        }
      }
      if (!matchesAny(facts, t, citedPriceRupeeSum, tol)) {
        // NORMALIZATION (documented): money relevance comes from the TOKEN's
        // unit (rupee/paise figures are always money) or from money-bearing
        // CLAIM kinds (PRICE/MARGIN) — a wrong attach-rate percentage is a
        // narrative lie, not a price lie (matrix A3 recovers).
        const moneyRel =
          t.unit === "RUPEE" ||
          t.unit === "PAISE" ||
          c.kind === "PRICE" ||
          c.kind === "MARGIN";
        const sameUnitMax = Math.max(
          ...facts.filter((f) => f.unit === t.unit).map((f) => f.value),
          Number.NEGATIVE_INFINITY,
        );
        const gross =
          !moneyRel &&
          facts.length > 0 &&
          Number.isFinite(sameUnitMax) &&
          t.value > tol.grossMultiplier * sameUnitMax;
        if (gross) {
          violations.push({
            code: "GROSS_FABRICATION",
            claim_index: i,
            evidence_id: null,
            detail: `token ${t.value} ${t.unit} exceeds ${tol.grossMultiplier}x the max same-unit cited fact (${sameUnitMax})`,
            money_relevant: false,
          });
        } else {
          violations.push({
            code: "NUMERIC_MISMATCH",
            claim_index: i,
            evidence_id: null,
            detail: `token ${t.value} ${t.unit} not derivable from cited ${[...seenIds].join(",")}`,
            money_relevant: moneyRel,
          });
        }
        // ANY unreconciled number amputates its claim (matrix A3/A8/A9:
        // "claim removed; cart intact"); money relevance only escalates the
        // VERDICT to FAILED below.
        stripClaim.add(i);
      }
    }
  }

  /* -- Stage 2b: priority_ref integrity ---------------------------------- */
  const packPriorityIds = new Set(
    pack.entries
      .filter((e) => e.kind === "CAMPAIGN_PRIORITY")
      .map((e) =>
        e.payload.kind === "CAMPAIGN_PRIORITY" ? e.payload.payload.priority_id : "",
      ),
  );
  const seenPid = new Set<string>();
  for (const pid of proposal.campaign_priority_ids) {
    if (seenPid.has(pid)) continue;
    seenPid.add(pid);
    if (!packPriorityIds.has(pid)) {
      violations.push({
        code: "PRIORITY_REF_MISMATCH",
        claim_index: null,
        evidence_id: null,
        detail: `priority id ${pid} not in tx snapshot`,
        money_relevant: false, // fatal regardless (§4.2)
      });
    }
  }

  /* -- Stage 3: verdict --------------------------------------------------- */
  const fatalCodes = new Set<ViolationCode>([
    "UNKNOWN_SKU",
    "GROSS_FABRICATION",
    "STOCK_OVERDRAW",
    "PRIORITY_REF_MISMATCH",
  ]);
  const fatal =
    violations.some(
      (v) => fatalCodes.has(v.code) || (v.code === "NUMERIC_MISMATCH" && v.money_relevant),
    ) || proposal.proposed_items.length === 0;

  if (fatal) {
    return result("FAILED", null);
  }

  const effectiveClaims = proposal.claims.filter((_, i) => !stripClaim.has(i));
  const effective: NegotiationProposal = {
    ...proposal,
    claims: effectiveClaims,
    // used_campaign_priority stays truthful to the CART; stale priority refs
    // were already handled in stage 2b.
  };

  // Injection echo: any STRIPPED claim whose statement shares a >=4-char
  // case-folded token with the customer note (deterministic overlap check).
  let echo = false;
  if (opts.customer_note_raw !== undefined && stripClaim.size > 0) {
    const noteGrams = grams(opts.customer_note_raw);
    for (const i of stripClaim) {
      const st = proposal.claims[i]?.statement;
      if (!st) continue;
      for (const g of grams(st)) {
        if (noteGrams.has(g)) {
          echo = true;
          break;
        }
      }
      if (echo) break;
    }
  }

  return result(violations.length === 0 ? "CLEAN" : "STRIPPED", effective, echo);

  function result(
    verdict: CitationVerdict,
    eff: NegotiationProposal | null,
    echo = false,
  ): CitationAuditResult {
    return Object.freeze({
      tx_id: opts.tx_id,
      pack_hash: pack.pack_hash,
      verdict,
      violations: Object.freeze(violations),
      effective_proposal: eff,
      flags: Object.freeze({
        unsupported_discount_claim: unsupportedDiscount,
        injection_echo_suspected: echo,
      }),
      audited_at: opts.audited_at,
    });
  }
}

/** Lowercased >=4-char alphanumeric runs of a string. */
function grams(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.toLowerCase().matchAll(/[a-z0-9]{4,}/g)) {
    out.add(m[0]);
  }
  return out;
}
