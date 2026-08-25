/**
 * GK-CATEGORY-ALLOWLIST (gatekeeper.md §6 row 10) — BLOCKER.
 * Compares the MERCHANT-ASSIGNED category_raw against the merchant allowlist.
 * Enrichment categories are structurally absent from the gatekeeper's input
 * type — their absence IS the provenance rule. ALL_ALLOWED mode ignores the
 * list entirely. Comparison is exact-string (catalog data is canonicalized
 * to uppercase at ingestion; no case-folding heuristics inside the gate).
 */
import type { RuleDefinition, RuleVerdict } from "./registry.js";
import type { GateContext } from "../context.js";

export const categoryAllowlist: RuleDefinition = {
  id: "GK-CATEGORY-ALLOWLIST",
  severity: "BLOCKER",
  dependsOn: ["GK-SKU-RESOLUTION"],
  evaluate(ctx: Readonly<GateContext>): RuleVerdict {
    const mode = ctx.rules.category_allowlist_mode;
    if (mode === "ALL_ALLOWED") {
      return {
        status: "PASS",
        human_message: "Category allowlist disabled (ALL_ALLOWED) — all merchant categories sellable.",
        evidence: { mode, allowlist_consulted: false },
      };
    }

    const allow = new Set(ctx.rules.category_allowlist);
    const offending = [
      ...new Set(
        ctx.merged_lines
          .map((l) => ctx.sku_index.get(l.sku_id)?.category_raw ?? "")
          .filter((c) => c !== "" && !allow.has(c)),
      ),
    ];

    if (offending.length > 0) {
      return {
        status: "FAIL",
        expected: `categories within [${ctx.rules.category_allowlist.join(", ")}]`,
        actual: offending.join(", "),
        reason_code: "CATEGORY_BLOCKED",
        human_message: `Cart contains item(s) in category not on the merchant allowlist: ${offending.join(", ")}.`,
        evidence: {
          mode,
          allowlist: [...ctx.rules.category_allowlist],
          offending_categories: offending,
        },
      };
    }

    return {
      status: "PASS",
      human_message: `All line categories within the merchant allowlist (${ctx.rules.category_allowlist.join(", ")}).`,
      evidence: { mode, allowlist: [...ctx.rules.category_allowlist] },
    };
  },
};
