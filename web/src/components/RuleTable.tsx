/**
 * RuleTable — the deterministic gatekeeper's per-rule ledger. We render the
 * FULL 16-rule roster (RULE_IDS from shared) so the viewer sees the whole policy
 * surface, not just the rules that happened to fire; rules the run evaluated
 * arrive as gatekeeper_rule_result events (keyed by rule_id in reducer state)
 * and light up with their PASS/FAIL/ESCALATE verdict + expected-vs-actual. Rows
 * not (yet) evaluated stay muted "—". Color is always paired with a text label.
 */
import { RULE_IDS } from "@growthagent/shared";
import type { RuleView } from "../hooks/traceReducer.js";
import { Chip } from "./ui.js";

function verdictChip(status: string): JSX.Element {
  const s = status.toUpperCase();
  if (s === "PASS" || s === "OK") return <Chip tone="ok">pass</Chip>;
  if (s === "FAIL" || s === "BLOCK") return <Chip tone="bad">fail</Chip>;
  if (s === "ESCALATE") return <Chip tone="escalate">escalate</Chip>;
  return <Chip tone="warn">{status.toLowerCase()}</Chip>;
}

function rowTint(status: string | undefined): string {
  if (!status) return "";
  const s = status.toUpperCase();
  if (s === "PASS" || s === "OK") return "bg-ok/[0.06]";
  if (s === "FAIL" || s === "BLOCK") return "bg-bad/[0.09]";
  if (s === "ESCALATE") return "bg-escalate/[0.09]";
  return "bg-warn/[0.07]";
}

export function RuleTable({ rules }: { rules: Record<string, RuleView> }): JSX.Element {
  const evaluated = Object.keys(rules).length;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[12px] text-mute">
        <span>16 rules · {evaluated} evaluated this run</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-mute">
              <th className="py-1.5 pr-3 font-medium">Rule</th>
              <th className="py-1.5 pr-3 font-medium">Verdict</th>
              <th className="py-1.5 pr-3 font-medium">Expected</th>
              <th className="py-1.5 pr-3 font-medium">Actual</th>
            </tr>
          </thead>
          <tbody>
            {RULE_IDS.map((id) => {
              const r = rules[id];
              return (
                <tr key={id} className={`border-t border-edge/60 ${rowTint(r?.status)}`}>
                  <td className="py-1.5 pr-3 font-mono text-[12px] text-ink/90">{id.replace(/^GK-/, "")}</td>
                  <td className="py-1.5 pr-3">{r ? verdictChip(r.status) : <span className="text-mute">—</span>}</td>
                  <td className="py-1.5 pr-3 text-mute">{r?.expected ?? "—"}</td>
                  <td className="py-1.5 pr-3 text-ink/90">{r?.actual ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
