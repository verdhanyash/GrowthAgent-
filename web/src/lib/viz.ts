/**
 * web/src/lib/viz.ts — the chart design tokens, in ONE place.
 *
 * Every colour here was run through the palette validator against this app's
 * real chart surface (#0a0a0a, not a generic dark grey) before being written
 * down. The numbers in the comments are that run's output, so a future edit can
 * be re-checked rather than eyeballed.
 *
 * OUTCOME (status) — APPROVED/ESCALATED/DECLINED/FAILED mean good→bad, so they
 * wear status tokens, never categorical slots. Declared in stack order:
 *   worst adjacent CVD ΔE 11.3 (protan) · worst adjacent normal-vision ΔE 15.7
 *   · all four ≥3:1 against #0a0a0a.
 * The order matters: warning(#fab219) beside serious(#ec835a) measures 13.6 for
 * full-colour vision — under the 15 floor — so DECLINED sits between them and
 * that pair never touches. Status colour is always paired with a text label in
 * the legend, the row header and the tooltip, so hue is never the only channel.
 *
 * SERIES (categorical) — for the charts whose bars are identity, not verdict.
 * Slots 1–3 of the reference palette's dark column, which pass every check on
 * all pairs (worst CVD ΔE 9.4, normal-vision 20.9). Three is the documented cap
 * for all-pairs forms; past three, fold the tail into "Other" instead of
 * inventing a fourth hue.
 */
import type { OutcomeKind } from "@growthagent/shared";

/** Verdict colours. Fixed meaning — never themed, never reused as a series. */
export const OUTCOME_COLOR: Record<OutcomeKind, string> = {
  APPROVED: "#0ca30c",
  ESCALATED: "#fab219",
  DECLINED: "#d03b3b",
  FAILED: "#ec835a",
};

/** Stack/legend order. Best → worst, and it keeps the two oranges apart. */
export const OUTCOME_ORDER: readonly OutcomeKind[] = [
  "APPROVED",
  "ESCALATED",
  "DECLINED",
  "FAILED",
];

/** Human labels, so no chart ever renders a raw enum at the reader. */
export const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  APPROVED: "Approved",
  ESCALATED: "Escalated",
  DECLINED: "Declined",
  FAILED: "Failed",
};

/** Categorical slots for non-verdict series. Assign in order; never cycle. */
export const SERIES = ["#3987e5", "#d95926", "#199e70"] as const;

/** Chart chrome. One step off the surface, recessive, solid hairlines only. */
export const VIZ = {
  surface: "#0a0a0a",
  grid: "#2c2c2a",
  axis: "#383835",
  muted: "#898781",
  ink: "#ffffff",
  /** De-emphasis fill for "everything except the series that matters". */
  quiet: "#3f3f46",
} as const;

/** Area/track washes: the series hue at ~10%, never a saturated block. */
export const wash = (hex: string, alpha = 0.12): string => {
  const n = hex.replace("#", "");
  const to = (i: number): number => Number.parseInt(n.slice(i, i + 2), 16);
  return `rgba(${to(0)}, ${to(2)}, ${to(4)}, ${alpha})`;
};
