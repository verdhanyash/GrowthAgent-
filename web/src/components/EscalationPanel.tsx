/**
 * web/src/components/EscalationPanel.tsx — the live escalation, on the trace.
 *
 * Read-only: deciding happens in Approvals, and duplicating the buttons here
 * would mean two places to keep honest. What this panel owes the reader is the
 * countdown (the approval self-expires to DECLINED), the frozen cart the
 * decision applies to, and the digest tying it to the rule trace.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatPaise, type EventPayloadMap } from "@growthagent/shared";
import { bpsToPct } from "../lib/format.js";
import { Chip, KV, Mono } from "./ui.js";

type Created = EventPayloadMap["escalation_created"];
type Resolved = EventPayloadMap["escalation_approved"];

function useCountdown(expiresAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}

export function EscalationPanel({
  created,
  resolved,
}: {
  created: Created | null;
  resolved: Resolved | null;
}): JSX.Element | null {
  if (created === null) return null;
  return <Body created={created} resolved={resolved} />;
}

function Body({ created, resolved }: { created: Created; resolved: Resolved | null }): JSX.Element {
  const secs = useCountdown(created.expires_at);
  const cart = created.proposed_cart;

  return (
    <section className="rounded-xl border border-escalate/40 bg-panel p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="escalate" withDot={resolved === null}>
            {resolved === null
              ? "waiting on a human"
              : resolved.decision === "APPROVED"
                ? "approved by a human"
                : "rejected by a human"}
          </Chip>
          {created.reason_codes.map((r) => (
            <span key={r} className="font-mono text-[11px] text-escalate-bright">
              {r.replace(/_/g, " ").toLowerCase()}
            </span>
          ))}
        </div>
        {resolved === null && (
          <div className="flex items-center gap-3">
            <span className={`text-[11px] ${secs > 0 ? "text-mute" : "text-bad-bright"}`}>
              {secs > 0 ? `expires in ${secs}s` : "expired"}
            </span>
            <Link
              to="/approvals"
              className="text-[12px] text-escalate-bright transition-colors hover:text-ink"
            >
              Decide →
            </Link>
          </div>
        )}
      </header>

      <dl className="mt-5 grid gap-x-8 sm:grid-cols-2">
        <KV k="Subtotal">{formatPaise(cart.subtotal_paise)}</KV>
        <KV k={`Discount ${bpsToPct(cart.discount_percent_bps)}`}>
          −{formatPaise(cart.discount_paise)}
        </KV>
        <KV k="Frozen total">{formatPaise(cart.total_paise)}</KV>
        <KV k="Rule trace">
          <Mono value={created.rule_trace_ref.trace_digest} truncate className="max-w-[150px]" />
        </KV>
      </dl>

      {resolved !== null && (
        <p className="mt-4 border-t border-edge pt-4 text-[12px] text-mute">
          Decided by <span className="text-ink">{resolved.decided_by}</span> at{" "}
          {new Date(resolved.decided_at).toLocaleTimeString()}
          {resolved.note !== null && resolved.note !== undefined && resolved.note !== ""
            ? ` — “${resolved.note}”`
            : ""}
        </p>
      )}
    </section>
  );
}
