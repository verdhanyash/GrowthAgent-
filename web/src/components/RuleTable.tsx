/**
 * web/src/components/RuleTable.tsx — the gatekeeper's rule ledger for one run.
 *
 * Default view is "evaluated", not "all sixteen". The full roster matters when
 * you are auditing coverage, so it stays one click away — but opening a trace to
 * read twelve greyed-out PENDING rows above the four that actually ran was the
 * single noisiest thing on the old trace screen.
 *
 * Failures and escalations sort to the top: the reason the cart went the way it
 * did should never be something you scroll for.
 */
import { useState } from "react";
import { RULE_IDS } from "@growthagent/shared";
import type { RuleView } from "../hooks/traceReducer.js";
import { Chip, DataTable, Segmented } from "./ui.js";

type Filter = "EVALUATED" | "ALL";

/** RuleStatus → chip. FAIL blocks; BAND/ESCALATE_TRIGGER/UNAVAILABLE_INPUT
 *  route to a human; SKIP ran nothing because a dependency failed. */
function verdict(status: string): JSX.Element {
  switch (status) {
    case "PASS":
      return <Chip tone="ok">pass</Chip>;
    case "FAIL":
      return <Chip tone="bad">fail</Chip>;
    case "BAND":
    case "ESCALATE_TRIGGER":
    case "UNAVAILABLE_INPUT":
      return <Chip tone="escalate">{status.replace(/_/g, " ").toLowerCase()}</Chip>;
    case "SKIP":
      return <Chip>skipped</Chip>;
    default:
      return <Chip tone="warn">{status.toLowerCase()}</Chip>;
  }
}

const WEIGHT: Record<string, number> = {
  FAIL: 0,
  BAND: 1,
  ESCALATE_TRIGGER: 1,
  UNAVAILABLE_INPUT: 1,
  SKIP: 2,
  PASS: 3,
};

interface Row {
  id: string;
  rule: RuleView | undefined;
}

export function RuleTable({ rules }: { rules: Record<string, RuleView> }): JSX.Element {
  const [filter, setFilter] = useState<Filter>("EVALUATED");

  const evaluated = Object.keys(rules).length;
  const rows: Row[] = RULE_IDS.map((id) => ({ id, rule: rules[id] }))
    .filter((r) => (filter === "EVALUATED" ? r.rule !== undefined : true))
    .sort((a, b) => {
      const wa = a.rule === undefined ? 4 : (WEIGHT[a.rule.status] ?? 3);
      const wb = b.rule === undefined ? 4 : (WEIGHT[b.rule.status] ?? 3);
      return wa - wb || a.id.localeCompare(b.id);
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-mute">
          {evaluated} of {RULE_IDS.length} invariants evaluated on this cart
        </p>
        <Segmented
          label="Rule filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "EVALUATED", label: "Evaluated", count: evaluated },
            { value: "ALL", label: "All", count: RULE_IDS.length },
          ]}
        />
      </div>

      <DataTable<Row>
        rows={rows}
        rowKey={(r) => r.id}
        empty="No rule has reported yet."
        columns={[
          {
            header: "Invariant",
            cell: (r) => (
              <span className={`font-mono text-[11px] ${r.rule === undefined ? "text-mute" : "text-ink"}`}>
                {r.id.replace(/^GK-/, "")}
              </span>
            ),
          },
          {
            header: "Verdict",
            cell: (r) => (r.rule === undefined ? <span className="text-mute">—</span> : verdict(r.rule.status)),
          },
          { header: "Observed", numeric: true, cell: (r) => r.rule?.actual ?? "—" },
          { header: "Limit", numeric: true, cell: (r) => r.rule?.expected ?? "—" },
          {
            header: "Detail",
            cell: (r) => (
              <span className="text-[11px] text-mute">
                {r.rule?.human_message ?? "not reached on this run"}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
